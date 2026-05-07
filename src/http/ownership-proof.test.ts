/**
 * Tests for the ownership-proof module.
 *
 * Covers the canonical message builder + URL normalisation, signature
 * format gate, sign-then-recover round-trip, and the startup-validation
 * aggregator used by `config.ts`.
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  OWNERSHIP_PROOF_PREFIX,
  buildOwnershipProofMessage,
  normalizePublicBaseUrl,
  isValidOwnershipProofFormat,
  recoverOwnershipProofSigner,
  signOwnershipProof,
  validateOwnershipProofs,
} from "./ownership-proof.js";

// ═══════════════════════════════════════════════════════════════════════
// normalizePublicBaseUrl
// ═══════════════════════════════════════════════════════════════════════

describe("normalizePublicBaseUrl", () => {
  it("normalises scheme/host case, strips path/query/trailing slash, drops default ports, preserves non-default ports", () => {
    expect(normalizePublicBaseUrl("HTTPS://Gateway.Example.COM/")).toBe("https://gateway.example.com");
    expect(normalizePublicBaseUrl("https://gateway.example.com/some/path?x=1#frag")).toBe(
      "https://gateway.example.com",
    );
    expect(normalizePublicBaseUrl("http://gateway.example.com:80")).toBe("http://gateway.example.com");
    expect(normalizePublicBaseUrl("https://gateway.example.com:443")).toBe("https://gateway.example.com");
    expect(normalizePublicBaseUrl("https://gateway.example.com:8443")).toBe("https://gateway.example.com:8443");
  });

  it("rejects non-http(s) schemes and malformed inputs", () => {
    expect(() => normalizePublicBaseUrl("ftp://gateway.example.com")).toThrow(/must use http or https/);
    expect(() => normalizePublicBaseUrl("ws://gateway.example.com")).toThrow(/must use http or https/);
    expect(() => normalizePublicBaseUrl("not a url at all")).toThrow();
    expect(() => normalizePublicBaseUrl("")).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildOwnershipProofMessage — canonical, deterministic, idempotent under URL variants
// ═══════════════════════════════════════════════════════════════════════

describe("buildOwnershipProofMessage", () => {
  it("matches the documented canonical message verbatim (and starts with the prefix)", () => {
    const msg = buildOwnershipProofMessage("https://gateway.example.com");
    expect(msg).toBe("x402 ownership of https://gateway.example.com");
    expect(msg.startsWith(OWNERSHIP_PROOF_PREFIX)).toBe(true);
  });

  it("produces identical output for cosmetically different URLs of the same origin", () => {
    const baseline = buildOwnershipProofMessage("https://gateway.example.com");
    expect(buildOwnershipProofMessage("https://gateway.example.com/")).toBe(baseline);
    expect(buildOwnershipProofMessage("https://Gateway.Example.COM")).toBe(baseline);
    expect(buildOwnershipProofMessage("https://gateway.example.com:443")).toBe(baseline);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isValidOwnershipProofFormat — structural shape gate
// ═══════════════════════════════════════════════════════════════════════

describe("isValidOwnershipProofFormat", () => {
  it("accepts 0x + 130 hex chars (any case)", () => {
    expect(isValidOwnershipProofFormat("0x" + "a".repeat(130))).toBe(true);
    expect(isValidOwnershipProofFormat("0x" + "aB".repeat(65))).toBe(true);
  });

  it("rejects malformed shapes (missing 0x, wrong length, non-hex, empty)", () => {
    expect(isValidOwnershipProofFormat("a".repeat(130))).toBe(false); // missing 0x
    expect(isValidOwnershipProofFormat("0x" + "a".repeat(128))).toBe(false); // too short
    expect(isValidOwnershipProofFormat("0x" + "a".repeat(132))).toBe(false); // too long
    expect(isValidOwnershipProofFormat("0x" + "g".repeat(130))).toBe(false); // non-hex
    expect(isValidOwnershipProofFormat("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sign → recover round-trip
// ═══════════════════════════════════════════════════════════════════════

describe("signOwnershipProof + recoverOwnershipProofSigner", () => {
  const PRIVATE_KEY = "0x" + "ab".repeat(32);
  const URL = "https://gateway.example.com";

  it("round-trips: signature is well-formed and recovery returns the signer's address", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, URL);
    expect(isValidOwnershipProofFormat(sig)).toBe(true);
    expect(recoverOwnershipProofSigner(sig, URL)).toBe(wallet.address.toLowerCase());
  });

  it("recovers the same address when signing and verifying URLs differ only cosmetically (URL-normalisation works end-to-end)", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, "https://Gateway.Example.COM/");
    expect(recoverOwnershipProofSigner(sig, "https://gateway.example.com")).toBe(wallet.address.toLowerCase());
  });

  it("recovers a DIFFERENT address when the URL differs semantically (different origin)", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, "https://gateway.example.com");
    const recovered = recoverOwnershipProofSigner(sig, "https://gateway.example.org");
    expect(recovered).not.toBe(wallet.address.toLowerCase());
  });

  it("throws on malformed signatures", () => {
    expect(() => recoverOwnershipProofSigner("0xdeadbeef", URL)).toThrow(/malformed/);
    expect(() => recoverOwnershipProofSigner("not-a-signature", URL)).toThrow(/malformed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateOwnershipProofs — startup aggregator used by config.ts
// ═══════════════════════════════════════════════════════════════════════

describe("validateOwnershipProofs", () => {
  const URL = "https://gateway.example.com";
  const WALLET = new ethers.Wallet("0x" + "cd".repeat(32));

  it("returns empty + no warnings when both inputs are empty", () => {
    expect(validateOwnershipProofs([], undefined)).toEqual({ valid: [], warnings: [] });
  });

  it("warns when proofs are set but publicBaseUrl is missing (proofs without a domain are meaningless)", () => {
    const { valid, warnings } = validateOwnershipProofs(["0x" + "a".repeat(130)], undefined);
    expect(valid).toEqual([]);
    expect(warnings[0]).toMatch(/PUBLIC_BASE_URL is not/);
  });

  it("flags malformed proofs without dropping valid ones; logs recovered signer for valid", async () => {
    const good = await signOwnershipProof(WALLET, URL);
    const { valid, warnings } = validateOwnershipProofs(["not-a-proof", good], URL);
    expect(valid).toEqual([good]);
    expect(warnings.some((w) => w.includes("OWNERSHIP_PROOFS[0] is malformed"))).toBe(true);
    expect(warnings.find((w) => w.includes("recovered to"))).toContain(WALLET.address.toLowerCase());
  });

  it("accepts structurally-valid proofs even when signed for a different URL (verification vs recovery is out of scope)", async () => {
    const sigOverOtherUrl = await signOwnershipProof(WALLET, "https://other.example.com");
    const { valid, warnings } = validateOwnershipProofs([sigOverOtherUrl], URL);
    expect(valid.length).toBe(1);
    // The recovered address won't match the operator's wallet — this is intentional.
    // Verifying against a known operator key is out of scope (multisig / HW wallets).
    expect(warnings.find((w) => w.includes("recovered to"))).not.toContain(WALLET.address.toLowerCase());
  });
});
