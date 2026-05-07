/**
 * Tests for the `/openapi.json` document builder.
 *
 * Asserts our contract surfaces (x402scan-required fields, the D14
 * receipt-as-header design, the GET query-parameter rendering, the
 * CrossChainQuoteExtra + CrossChainSettlementExtra schemas) — not OpenAPI
 * library behavior.
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  buildOpenApiDocument,
  jsonSchemaToQueryParameters,
  type OpenApiInfo,
} from "./openapi.js";
import { signOwnershipProof } from "./ownership-proof.js";
import type { ProtectedRoute } from "./protected-routes.js";
import { SwapRequestInputSchema, SwapRequestInputJsonSchema } from "./swap-input.js";
import { mockGatewayConfig } from "../mocks/mock-config.js";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

function info(overrides: Partial<OpenApiInfo> = {}): OpenApiInfo {
  return {
    title: "x402-1cs-gateway",
    version: "0.1.0",
    description: "test description",
    ...overrides,
  };
}

function route(overrides: Partial<ProtectedRoute> = {}): ProtectedRoute {
  return {
    path: "/api/swap",
    method: "GET",
    summary: "Cross-chain swap",
    description: "Pay USDC, receive any 1CS-supported asset on any chain.",
    pricing: { currency: "USD", min: "0.01", max: "100000" },
    inputValidator: SwapRequestInputSchema,
    inputSchema: SwapRequestInputJsonSchema,
    outputSchema: { type: "object", additionalProperties: false },
    handler: (_req, _res, next) => next(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Top-level shape
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — top-level shape", () => {
  it("emits openapi version, info block (description optional), and the canonical key order", () => {
    const withDesc = buildOpenApiDocument(
      info({ title: "my-gw", version: "9.9.9", description: "desc" }),
      mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
      [route()],
    );
    expect(withDesc.openapi).toBe("3.1.0");
    expect(withDesc.info).toEqual({ title: "my-gw", version: "9.9.9", description: "desc" });

    // Key order matters for human readability of the published JSON.
    expect(Object.keys(withDesc)).toEqual([
      "openapi",
      "info",
      "servers",
      "x-discovery",
      "x-crosschain",
      "paths",
      "components",
    ]);

    // Description omitted when not provided.
    const noDesc = buildOpenApiDocument({ title: "t", version: "v" }, mockGatewayConfig(), [route()]);
    expect(noDesc.info).toEqual({ title: "t", version: "v" });
  });

  it("emits servers[] when publicBaseUrl is set; omits it when unset", () => {
    const withUrl = buildOpenApiDocument(
      info(),
      mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
      [route()],
    );
    expect(withUrl.servers).toEqual([
      { url: "https://gateway.example.com", description: "Gateway public endpoint" },
    ]);

    expect(
      buildOpenApiDocument(info(), mockGatewayConfig({ publicBaseUrl: undefined }), [route()]),
    ).not.toHaveProperty("servers");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x-discovery.ownershipProofs
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x-discovery.ownershipProofs", () => {
  const WALLET = new ethers.Wallet("0x" + "22".repeat(32));

  it("mirrors valid proofs and drops malformed ones", async () => {
    const url = "https://gateway.example.com";
    const good = await signOwnershipProof(WALLET, url);

    expect(
      (
        buildOpenApiDocument(
          info(),
          mockGatewayConfig({ publicBaseUrl: url, ownershipProofs: [good, "garbage"] }),
          [route()],
        )["x-discovery"] as { ownershipProofs: string[] }
      ).ownershipProofs,
    ).toEqual([good]);
  });

  it("emits an empty proofs array when publicBaseUrl is unset (proofs without a domain are meaningless)", () => {
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({
        publicBaseUrl: undefined,
        ownershipProofs: ["0x" + "a".repeat(130)],
      }),
      [route()],
    );
    expect(doc["x-discovery"]).toEqual({ ownershipProofs: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Security + per-operation
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — operations + security", () => {
  it("emits operations under lowercase method keys with x402 security and route metadata", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ path: "/api/a", method: "GET", summary: "Op A", description: "Hello." }),
      route({ path: "/api/b", method: "POST" }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;

    expect(Object.keys(paths["/api/a"]!)).toEqual(["get"]);
    expect(Object.keys(paths["/api/b"]!)).toEqual(["post"]);

    const opA = paths["/api/a"]!.get!;
    expect(opA.summary).toBe("Op A");
    expect(opA.description).toBe("Hello.");
    expect(opA.security).toEqual([{ x402: [] }]);

    const schemes = (doc.components as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect(schemes.x402).toMatchObject({ type: "http", scheme: "x402" });
  });

  it("allows multiple methods on the same path (separate operations)", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ path: "/api/shared", method: "GET" }),
      route({ path: "/api/shared", method: "POST" }),
    ]);
    const shared = (doc.paths as Record<string, Record<string, unknown>>)["/api/shared"]!;
    expect(Object.keys(shared).sort()).toEqual(["get", "post"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x-payment-info — swap-mode pricing
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x-payment-info", () => {
  it("emits swap-mode pricing with min/max from the route and operatorMarginBps from cfg", () => {
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({ operatorMarginBps: 30 }),
      [route({ pricing: { currency: "USD", min: "0.01", max: "100000" } })],
    );
    const op = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/swap"]!.get!;
    expect(op["x-payment-info"]).toEqual({
      protocols: "x402",
      mode: "swap",
      currency: "USD",
      min: "0.01",
      max: "100000",
      operatorMarginBps: 30,
    });
  });

  it("allows operatorMarginBps=0 (free deployment)", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig({ operatorMarginBps: 0 }), [route()]);
    const op = (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/api/swap"]!.get!;
    expect((op["x-payment-info"] as { operatorMarginBps: number }).operatorMarginBps).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Responses — D14 receipt-as-header
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — responses", () => {
  it("declares 200 with the route's outputSchema as body AND the PAYMENT-RESPONSE header (D14)", () => {
    const schema = { type: "object", additionalProperties: false };
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route({ outputSchema: schema })]);
    const r200 = ((doc.paths as any)["/api/swap"].get.responses as Record<string, unknown>)["200"] as Record<string, unknown>;

    // Body schema (intentionally empty for the swap route).
    expect(r200).toMatchObject({ content: { "application/json": { schema } } });
    // Receipt is in the header — D14.
    expect(r200.description as string).toMatch(/PAYMENT-RESPONSE/);
    expect(((r200.headers as Record<string, unknown>)["PAYMENT-RESPONSE"] as { schema: unknown }).schema).toEqual({
      type: "string",
    });
  });

  it("declares 402 (PAYMENT-REQUIRED header), 400 (INVALID_INPUT), and 503 (upstream errors)", () => {
    const responses = ((buildOpenApiDocument(info(), mockGatewayConfig(), [route()]).paths as any)["/api/swap"].get.responses) as Record<string, Record<string, unknown>>;

    const r402 = responses["402"];
    expect(((r402.headers as Record<string, unknown>)["PAYMENT-REQUIRED"] as { schema: unknown }).schema).toEqual({
      type: "string",
    });

    expect((responses["400"].description as string)).toMatch(/INVALID_INPUT/);
    expect(responses["503"]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET query parameters
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — GET query parameters", () => {
  it("emits one query parameter per inputSchema field, with required correctly marked", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    const params = ((doc.paths as any)["/api/swap"].get.parameters) as Array<{
      name: string;
      in: string;
      required: boolean;
    }>;

    expect(params.every((p) => p.in === "query")).toBe(true);
    const lookup = Object.fromEntries(params.map((p) => [p.name, p.required]));
    expect(lookup).toEqual({
      destinationChain: true,
      destinationAsset: true,
      destinationAddress: true,
      amountIn: true,
      refundAddress: false,
    });
  });

  it("does NOT emit parameters for POST routes (uses requestBody instead)", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ method: "POST", path: "/api/post-route" }),
    ]);
    const op = (doc.paths as any)["/api/post-route"].post;
    expect(op).not.toHaveProperty("parameters");
    expect(op.requestBody).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// jsonSchemaToQueryParameters (the small helper used above)
// ═══════════════════════════════════════════════════════════════════════

describe("jsonSchemaToQueryParameters", () => {
  it("returns [] for non-object schemas or object schemas without properties", () => {
    expect(jsonSchemaToQueryParameters({ type: "string" })).toEqual([]);
    expect(jsonSchemaToQueryParameters({ type: "object" })).toEqual([]);
  });

  it("emits one parameter per property and propagates per-field description", () => {
    const result = jsonSchemaToQueryParameters({
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", description: "the A field" },
        b: { type: "string" },
      },
    });
    expect(result.length).toBe(2);
    expect(result[0]).toMatchObject({ name: "a", required: true, description: "the A field" });
    expect(result[1]).toMatchObject({ name: "b", required: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x-crosschain + components.schemas — the on-the-wire receipt contract
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x-crosschain + schemas", () => {
  it("x-crosschain references BOTH the quote schema and the settlement schema", () => {
    const xcc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()])["x-crosschain"] as Record<string, unknown>;
    expect(xcc).toMatchObject({
      protocol: "1cs",
      quoteSchema: "#/components/schemas/CrossChainQuoteExtra",
      settlementSchema: "#/components/schemas/CrossChainSettlementExtra",
    });
  });

  it("CrossChainQuoteExtra schema requires operatorFee with bps/amount/currency sub-fields", () => {
    const schemas = (
      buildOpenApiDocument(info(), mockGatewayConfig(), [route()]).components as {
        schemas: Record<string, Record<string, unknown>>;
      }
    ).schemas;
    const schema = schemas.CrossChainQuoteExtra!;

    const required = schema.required as string[];
    expect(required).toEqual(
      expect.arrayContaining([
        "protocol",
        "quoteId",
        "destinationRecipient",
        "destinationAsset",
        "amountOut",
        "refundTo",
        "operatorFee",
      ]),
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect((props.protocol as { enum: string[] }).enum).toEqual(["1cs"]);
    expect((props.operatorFee.required as string[])).toEqual(
      expect.arrayContaining(["bps", "amount", "currency"]),
    );
  });

  it("CrossChainSettlementExtra schema declares the receipt fields and pins settlementType", () => {
    const schemas = (
      buildOpenApiDocument(info(), mockGatewayConfig(), [route()]).components as {
        schemas: Record<string, Record<string, unknown>>;
      }
    ).schemas;
    const schema = schemas.CrossChainSettlementExtra!;

    expect(schema.required as string[]).toEqual(expect.arrayContaining(["settlementType", "swapStatus"]));
    const props = schema.properties as Record<string, Record<string, unknown>>;
    for (const field of [
      "destinationTxHashes",
      "destinationChain",
      "destinationRecipient",
      "destinationAsset",
      "destinationAmount",
      "destinationAmountFormatted",
      "destinationAmountUsd",
      "slippage",
      "operatorFee",
      "swapStatus",
      "correlationId",
    ]) {
      expect(props).toHaveProperty(field);
    }
    expect((props.settlementType as { enum: string[] }).enum).toEqual(["crosschain-1cs"]);
  });
});
