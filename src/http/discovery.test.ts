/**
 * Tests for the `/.well-known/x402` document builder.
 *
 * Verifies the static shape required by x402scan and the IETF `_x402` TXT
 * draft, plus the edge cases that come up when the operator has only
 * half-configured discovery (URL without proofs, proofs without URL,
 * malformed proofs).
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { buildWellKnownDocument, WELL_KNOWN_INSTRUCTIONS } from "./discovery.js";
import { signOwnershipProof } from "./ownership-proof.js";
import type { ProtectedRoute } from "./protected-routes.js";
import { SwapRequestInputSchema, SwapRequestInputJsonSchema } from "./swap-input.js";
import { mockGatewayConfig } from "../mocks/mock-config.js";

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

function route(path: string, method: "GET" | "POST" = "GET"): ProtectedRoute {
  return {
    path,
    method,
    summary: `summary for ${path}`,
    description: `description for ${path}`,
    pricing: { currency: "USD", min: "0.01", max: "100" },
    inputValidator: SwapRequestInputSchema,
    inputSchema: SwapRequestInputJsonSchema,
    outputSchema: { type: "object", additionalProperties: false },
    handler: (_req, _res, next) => next(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Structural shape — top-level keys + version
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — shape", () => {
  it("emits version=1 and exactly the canonical four top-level keys (no extensions)", () => {
    // x402scan DISCOVERY.md does not recognise arbitrary extensions on
    // this surface — pin the key set so anyone adding/removing one updates
    // this test deliberately.
    const doc = buildWellKnownDocument(mockGatewayConfig(), [route("/a")]);
    expect(doc.version).toBe(1);
    expect(Object.keys(doc).sort()).toEqual([
      "instructions",
      "ownershipProofs",
      "resources",
      "version",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// resources[]
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — resources", () => {
  it("joins publicBaseUrl with each route path (handles trailing slash + subpath deployments) in registry order", () => {
    // Plain.
    expect(
      buildWellKnownDocument(
        mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
        [route("/api/a"), route("/api/b")],
      ).resources,
    ).toEqual(["https://gateway.example.com/api/a", "https://gateway.example.com/api/b"]);

    // Trailing slash on publicBaseUrl — should not double-slash.
    expect(
      buildWellKnownDocument(
        mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com/" }),
        [route("/api/a")],
      ).resources,
    ).toEqual(["https://gateway.example.com/api/a"]);

    // Reverse-proxy deployed under a subpath — composes onto the subpath.
    expect(
      buildWellKnownDocument(
        mockGatewayConfig({ publicBaseUrl: "https://example.com/x402" }),
        [route("/api/a")],
      ).resources,
    ).toEqual(["https://example.com/x402/api/a"]);

    // Registry order is preserved.
    expect(
      buildWellKnownDocument(mockGatewayConfig({ publicBaseUrl: "https://g.example.com" }), [
        route("/r2"),
        route("/r1"),
        route("/r3"),
      ]).resources,
    ).toEqual(["https://g.example.com/r2", "https://g.example.com/r1", "https://g.example.com/r3"]);
  });

  it("emits an empty resources array when publicBaseUrl is unset (relative URLs are useless to crawlers)", () => {
    expect(
      buildWellKnownDocument(mockGatewayConfig({ publicBaseUrl: undefined }), [route("/api/a")]).resources,
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ownershipProofs[]
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — ownership proofs", () => {
  it("emits only structurally-valid proofs (drops malformed; preserves multi-signer)", async () => {
    const url = "https://gateway.example.com";
    const w1 = new ethers.Wallet("0x" + "aa".repeat(32));
    const w2 = new ethers.Wallet("0x" + "bb".repeat(32));
    const [p1, p2] = await Promise.all([signOwnershipProof(w1, url), signOwnershipProof(w2, url)]);

    const doc = buildWellKnownDocument(
      mockGatewayConfig({ publicBaseUrl: url, ownershipProofs: [p1, "not-a-proof", p2] }),
      [route("/a")],
    );
    expect(doc.ownershipProofs).toEqual([p1, p2]);
  });

  it("emits an empty array when proofs are configured but publicBaseUrl is unset", () => {
    const doc = buildWellKnownDocument(
      mockGatewayConfig({ publicBaseUrl: undefined, ownershipProofs: ["0x" + "a".repeat(130)] }),
      [route("/a")],
    );
    expect(doc.ownershipProofs).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// instructions field — points crawlers at the richer surface
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — instructions", () => {
  it("is always present, matches WELL_KNOWN_INSTRUCTIONS, references /openapi.json + PAYMENT-REQUIRED, and is independent of publicBaseUrl", () => {
    const withUrl = buildWellKnownDocument(
      mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
      [route("/a")],
    );
    const withoutUrl = buildWellKnownDocument(
      mockGatewayConfig({ publicBaseUrl: undefined }),
      [route("/a")],
    );
    expect(withUrl.instructions).toBe(WELL_KNOWN_INSTRUCTIONS);
    expect(withUrl.instructions).toContain("/openapi.json");
    expect(withUrl.instructions).toContain("PAYMENT-REQUIRED");
    // Static text — same for both deployment postures.
    expect(withUrl.instructions).toBe(withoutUrl.instructions);
  });
});
