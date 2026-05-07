/**
 * `/openapi.json` document builder.
 *
 * x402scan's **primary** discovery surface — checked before
 * `/.well-known/x402`, so the richness of this document determines how
 * well the gateway is indexed. Key x402-specific fields:
 *
 *  - `info.title` / `info.version`                          (stock OpenAPI)
 *  - `servers[0].url`         — the public base URL
 *  - `x-discovery.ownershipProofs`                          (x402scan ext.)
 *  - `x-crosschain`           — protocol + schema pointer   (gateway ext.)
 *  - `components.securitySchemes.x402`                      (stock OpenAPI)
 *  - `components.schemas.CrossChainQuoteExtra`              (informational shape on 402)
 *  - `components.schemas.CrossChainSettlementExtra`         (receipt shape on 200)
 *  - Per operation:
 *      - `security: [{ x402: [] }]`                         (stock OpenAPI)
 *      - `x-payment-info: { protocols: "x402", mode: "swap", currency, min, max, operatorMarginBps }`
 *      - `parameters: [{ in: "query", ... }]`               (driven by `route.inputSchema`)
 *      - `responses.200` with empty body schema + `headers.PAYMENT-RESPONSE`
 *        that references `CrossChainSettlementExtra` — the receipt lives in the
 *        header, not the body (D14 in implementation_plan.md)
 *      - `responses.402` documenting the PAYMENT-REQUIRED header (and its
 *        decoded `accepts[0].extra.crossChain` informational block)
 *
 * This module is a **pure builder** — no Express handler, no I/O. The
 * `server.ts` entry point calls `buildOpenApiDocument` at startup and
 * serves the resulting plain object as JSON from `GET /openapi.json`.
 *
 * @module openapi
 */

import type { GatewayConfig } from "../infra/config.js";
import type {
  ProtectedMethod,
  ProtectedRoute,
  RoutePricing,
} from "./protected-routes.js";
import { validateOwnershipProofs } from "./ownership-proof.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Static metadata describing the gateway itself. Passed in (rather than
 * derived from `package.json`) so the builder stays pure and testable
 * without JSON imports, and so release tooling controls the version
 * string the document advertises.
 */
export interface OpenApiInfo {
  /** Human-readable title — shown in x402scan's indexer. */
  title: string;
  /** Semantic version string from the package manifest. */
  version: string;
  /** Optional longer description. */
  description?: string;
}

/**
 * The built document. The shape follows OpenAPI 3.1 with x402scan-style
 * extensions; we model it loosely (`Record<string, unknown>`) because
 * dragging in a full OpenAPI type dependency buys us nothing here and
 * would fight the x402 extensions.
 */
export type OpenApiDocument = Record<string, unknown>;

/**
 * JSON Schema for the `accepts[0].extra.crossChain` informational block
 * carried on every 402 envelope. Advertised in the OpenAPI document at
 * `components.schemas.CrossChainQuoteExtra` so indexers (x402scan,
 * generic OpenAPI tooling) and integrators can discover the shape
 * without parsing a live 402 response.
 *
 * Mirrors {@link import("../types.js").CrossChainQuoteExtra} 1:1. Kept as
 * a module-level constant so a future shape change is one edit here +
 * one in `types.ts` + one in `quote-engine.ts`.
 */
export const CROSS_CHAIN_QUOTE_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: "object",
    description:
      "Informational 1CS quote metadata carried on `accepts[0].extra.crossChain`. " +
      "Never used for signing. Clients opt in by checking `protocol === \"1cs\"`; " +
      "clients that don't care ignore the whole object.",
    required: [
      "protocol",
      "quoteId",
      "destinationRecipient",
      "destinationAsset",
      "amountOut",
      "amountOutFormatted",
      "amountOutUsd",
      "amountInUsd",
      "refundTo",
      "operatorFee",
    ],
    properties: {
      protocol: {
        type: "string",
        enum: ["1cs"],
        description: "Cross-chain protocol discriminator.",
      },
      quoteId: {
        type: "string",
        description: "1CS quote correlation ID — use when contacting support.",
      },
      destinationRecipient: {
        type: "string",
        description:
          "Buyer's recipient on the destination chain (echo of `swapInputs.destinationAddress`).",
      },
      destinationAsset: {
        type: "string",
        description:
          "1CS asset ID the buyer receives (echo of `swapInputs.destinationAsset`).",
      },
      amountOut: {
        type: "string",
        description: "Expected destination amount (smallest unit).",
      },
      amountOutFormatted: {
        type: "string",
        description: "Human-readable destination amount (e.g. \"10.00\").",
      },
      amountOutUsd: {
        type: "string",
        description: "USD value of the destination amount.",
      },
      amountInUsd: {
        type: "string",
        description: "USD value of the buyer's origin-chain authorisation.",
      },
      refundFee: {
        type: "string",
        description:
          "Fee charged if the deposit is refunded. Optional (chain-dependent).",
      },
      refundTo: {
        type: "string",
        description:
          "Address that receives refunds from failed swaps — buyer's `refundAddress` when supplied, else the gateway fallback.",
      },
      depositMemo: {
        type: "string",
        description:
          "Memo required by certain destination chains (Stellar, XRP, " +
          "Cosmos-family). Omitted when the chain does not require one.",
      },
      operatorFee: {
        type: "object",
        required: ["bps", "amount", "currency"],
        description:
          "Operator margin charged on top of the 1CS-quoted `amountIn`. Surfaced transparently so the buyer can see exactly what they're paying.",
        properties: {
          bps: { type: "integer", minimum: 0, maximum: 1000 },
          amount: {
            type: "string",
            description: "Margin amount in the origin asset's smallest unit.",
          },
          currency: { type: "string" },
        },
      },
    },
  });

/**
 * JSON Schema for the swap settlement receipt carried in
 * `PAYMENT-RESPONSE.extensions.crossChain` on a successful 200 response.
 * Advertised at `components.schemas.CrossChainSettlementExtra` so x402scan
 * and other indexers can discover the receipt shape without probing a live
 * settlement.
 *
 * Mirrors {@link import("../types.js").CrossChainSettlementExtra} 1:1.
 * Receipt-as-header is a deliberate design choice (D14 in
 * `implementation_plan.md`) — the body is `{}` and `extensions.crossChain`
 * is the standardized x402 carrier for protocol-specific settlement metadata.
 */
export const CROSS_CHAIN_SETTLEMENT_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: "object",
    description:
      "Cross-chain settlement receipt carried in the PAYMENT-RESPONSE header's " +
      "extensions.crossChain field on the 200 response. The 200 body is `{}`; " +
      "this object is the receipt.",
    required: ["settlementType", "swapStatus"],
    properties: {
      settlementType: {
        type: "string",
        enum: ["crosschain-1cs"],
        description: "Settlement protocol discriminator.",
      },
      destinationTxHashes: {
        type: "array",
        description: "Destination-chain tx hashes reported by 1CS.",
        items: {
          type: "object",
          required: ["hash", "explorerUrl"],
          properties: {
            hash: { type: "string" },
            explorerUrl: { type: "string" },
          },
        },
      },
      destinationChain: {
        type: "string",
        description: "Chain prefix (e.g. \"near\", \"arbitrum\") extracted from the asset ID.",
      },
      destinationRecipient: {
        type: "string",
        description: "Buyer's recipient on the destination chain (echo of swapInputs.destinationAddress).",
      },
      destinationAsset: {
        type: "string",
        description: "1CS asset ID actually delivered.",
      },
      destinationAmount: {
        type: "string",
        description: "Smallest-unit amount actually received (from swapDetails.amountOut).",
      },
      destinationAmountFormatted: {
        type: "string",
        description: "Human-readable destination amount, when 1CS reports it.",
      },
      destinationAmountUsd: {
        type: "string",
        description: "USD value of the destination amount, when 1CS reports it.",
      },
      slippage: {
        type: "number",
        description: "Realised slippage from 1CS, when available.",
      },
      operatorFee: {
        type: "object",
        required: ["bps", "amount", "currency"],
        description: "Operator margin breakdown — same shape as the 402 envelope's operatorFee.",
        properties: {
          bps: { type: "integer", minimum: 0, maximum: 1000 },
          amount: { type: "string" },
          currency: { type: "string" },
        },
      },
      swapStatus: {
        type: "string",
        enum: [
          "KNOWN_DEPOSIT_TX",
          "PENDING_DEPOSIT",
          "INCOMPLETE_DEPOSIT",
          "PROCESSING",
          "SUCCESS",
          "FAILED",
          "REFUNDED",
        ],
        description: "1CS terminal/non-terminal status.",
      },
      correlationId: {
        type: "string",
        description: "1CS correlation ID for support / explorer lookup.",
      },
    },
  });

// ═══════════════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the OpenAPI document for every protected route.
 *
 * Pure function: returns a fresh plain object on each call. Safe to
 * compute per-request, but `server.ts` caches it at startup since the
 * routes registry and config are both immutable at runtime.
 *
 * Behaviour when `publicBaseUrl` is unset (local development):
 *  - `servers` is omitted entirely (allowed by OpenAPI 3.1).
 *  - `x-discovery.ownershipProofs` is emitted as an empty array — the
 *    proofs would be structurally valid but semantically meaningless
 *    without a canonical base URL, so we drop them to avoid confusing
 *    indexers.
 *  - Paths still appear with their paid-resource metadata; local
 *    consumers can still use the document for development / testing.
 */
export function buildOpenApiDocument(
  info: OpenApiInfo,
  cfg: GatewayConfig,
  routes: readonly ProtectedRoute[],
): OpenApiDocument {
  const baseUrl = cfg.publicBaseUrl;

  // Filter malformed ownership proofs the same way the well-known
  // document does, so the two surfaces never disagree.
  const { valid: validProofs } = validateOwnershipProofs(
    cfg.ownershipProofs,
    baseUrl,
  );

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
    },
    ...(baseUrl
      ? {
          servers: [
            {
              url: baseUrl,
              description: "Gateway public endpoint",
            },
          ],
        }
      : {}),
    "x-discovery": {
      ownershipProofs: validProofs,
    },
    "x-crosschain": {
      protocol: "1cs",
      quoteSchema: "#/components/schemas/CrossChainQuoteExtra",
      settlementSchema: "#/components/schemas/CrossChainSettlementExtra",
      description:
        "Every 402 envelope carries `accepts[0].extra.crossChain` (CrossChainQuoteExtra: " +
        "quote ID, destination amount, refund details, operator fee). Every 200 carries a " +
        "settlement receipt at `PAYMENT-RESPONSE.extensions.crossChain` (CrossChainSettlementExtra). " +
        "Clients that only speak the EVM `exact` scheme can ignore both.",
    },
    paths: buildPaths(routes, cfg),
    components: {
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "x402",
          description:
            "Pay-per-request authentication via the x402 protocol. Clients receive a 402 with a PAYMENT-REQUIRED envelope, sign an EIP-712 authorization, and retry with PAYMENT-SIGNATURE.",
        },
      },
      schemas: {
        CrossChainQuoteExtra: CROSS_CHAIN_QUOTE_SCHEMA,
        CrossChainSettlementExtra: CROSS_CHAIN_SETTLEMENT_SCHEMA,
      },
    },
  };

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════
// Path-item construction
// ═══════════════════════════════════════════════════════════════════════

function buildPaths(
  routes: readonly ProtectedRoute[],
  cfg: GatewayConfig,
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    // Multiple methods on the same path share a single path item.
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method.toLowerCase()] = buildOperation(route, cfg);
    paths[route.path] = pathItem;
  }

  return paths;
}

function buildOperation(
  route: ProtectedRoute,
  cfg: GatewayConfig,
): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    summary: route.summary,
    description: route.description,
    security: [{ x402: [] }],
    "x-payment-info": buildPaymentInfo(route.pricing, cfg),
  };

  attachRequestShape(operation, route.method, route.inputSchema);

  operation.responses = buildResponses(route);

  return operation;
}

/**
 * Translate the registry's `RoutePricing` into the x402scan-compatible
 * `x-payment-info` block.
 *
 * Output shape: `{ protocols: "x402", mode: "swap", currency, min, max,
 * operatorMarginBps }`. The `operatorMarginBps` value comes from the
 * service-level config (not per-route) since this is a single-product
 * service; surfacing it here lets x402scan and integrators see the
 * markup the operator charges without probing a live 402.
 */
function buildPaymentInfo(
  pricing: RoutePricing,
  cfg: GatewayConfig,
): Record<string, unknown> {
  return {
    protocols: "x402",
    mode: "swap",
    currency: pricing.currency,
    min: pricing.min,
    max: pricing.max,
    operatorMarginBps: cfg.operatorMarginBps,
  };
}

/**
 * Attach the input shape to an operation.
 *
 * - For GET: emit `parameters: [{ in: "query", ... }]` — one entry per
 *   top-level field of the route's flat `inputSchema`.
 * - For POST: emit an `application/json` `requestBody` whose schema is
 *   the registry's `inputSchema`.
 *
 * The swap route is GET (D8 in implementation_plan.md) — query params
 * carry the buyer's destination. POST support is retained for
 * forward-compatibility if a future paid route needs body input.
 */
function attachRequestShape(
  operation: Record<string, unknown>,
  method: ProtectedMethod,
  inputSchema: Record<string, unknown>,
): void {
  if (method === "GET") {
    const parameters = jsonSchemaToQueryParameters(inputSchema);
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }
    return;
  }
  // POST
  operation.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: inputSchema,
      },
    },
  };
}

/**
 * Walk a flat object JSON Schema and emit one OpenAPI `parameters` entry
 * per top-level property. Scoped to flat schemas — the swap route's input
 * is intentionally flat for query-string carriage. Nested objects in the
 * schema would be silently flattened to their top key here, so don't use
 * this on hierarchical inputs without revisiting.
 */
export function jsonSchemaToQueryParameters(
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (schema.type !== "object") return [];
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return [];

  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  return Object.entries(properties).map(([name, fieldSchema]) => {
    const param: Record<string, unknown> = {
      name,
      in: "query",
      required: required.has(name),
      schema: fieldSchema,
    };
    if (typeof fieldSchema.description === "string") {
      param.description = fieldSchema.description;
    }
    return param;
  });
}

function buildResponses(route: ProtectedRoute): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description:
        "Settlement complete. The body is `{}` by design — the swap receipt is " +
        "carried in the `PAYMENT-RESPONSE` header's `extensions.crossChain` field " +
        "(CrossChainSettlementExtra). See D14 in implementation_plan.md.",
      headers: {
        "PAYMENT-RESPONSE": {
          description:
            "Base64-encoded x402 SettleResponse. The `extensions.crossChain` field " +
            "carries the swap receipt — destination tx hashes, slippage, operator fee.",
          schema: { type: "string" },
        },
      },
      content: {
        "application/json": {
          schema: route.outputSchema,
        },
      },
    },
    "402": {
      description:
        "Payment required. The `PAYMENT-REQUIRED` header carries a base64-encoded " +
        "x402 v2 envelope; clients sign an EIP-712 authorization and retry with " +
        "`PAYMENT-SIGNATURE`. Decoded, `accepts[0].extra.crossChain` conforms to " +
        "CrossChainQuoteExtra — informational metadata about the 1Click Swap " +
        "(quote ID, destination amount, refund target, operator fee).",
      headers: {
        "PAYMENT-REQUIRED": {
          description: "Base64-encoded x402 PaymentRequired envelope (v2).",
          schema: { type: "string" },
        },
      },
    },
    "400": {
      description:
        "Buyer input failed validation. Body: `{ error: \"INVALID_INPUT\", message, details: [{path, message}], correlationId }`.",
    },
    "503": {
      description:
        "Upstream 1CS service unavailable, authentication failed, deadline too short, or facilitator gas insufficient.",
    },
  };
  return responses;
}
