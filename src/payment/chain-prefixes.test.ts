/**
 * Tests for the shared NEP-141 chain-prefix module.
 *
 * These helpers are the gate for buyer-destination format validation
 * (`validateBuyerDestination` + `diagnoseQuoteRequest` in quote-engine.ts).
 * The diagnoser has its own behavioral tests; this file covers the
 * primitive helpers directly so regressions land at a clear file.
 */

import { describe, it, expect } from "vitest";
import {
  EVM_CHAIN_PREFIXES,
  NON_EVM_CHAIN_PREFIXES,
  extractChainPrefix,
  isValidNearAccount,
  isNearNativeAsset,
} from "./chain-prefixes.js";

// ═══════════════════════════════════════════════════════════════════════
// Chain-prefix lists — invariants + content sanity
// ═══════════════════════════════════════════════════════════════════════

describe("EVM_CHAIN_PREFIXES / NON_EVM_CHAIN_PREFIXES", () => {
  it("both lists are non-empty, lowercase, and disjoint", () => {
    expect(EVM_CHAIN_PREFIXES.length).toBeGreaterThan(0);
    expect(NON_EVM_CHAIN_PREFIXES.length).toBeGreaterThan(0);
    for (const p of EVM_CHAIN_PREFIXES) expect(p).toBe(p.toLowerCase());
    for (const p of NON_EVM_CHAIN_PREFIXES) expect(p).toBe(p.toLowerCase());
    const evm = new Set(EVM_CHAIN_PREFIXES);
    for (const p of NON_EVM_CHAIN_PREFIXES) expect(evm.has(p)).toBe(false);
  });

  it("contains the chains buyers most commonly target", () => {
    for (const p of ["eth", "base", "arb", "polygon"]) expect(EVM_CHAIN_PREFIXES).toContain(p);
    for (const p of ["solana", "stellar", "bitcoin"]) expect(NON_EVM_CHAIN_PREFIXES).toContain(p);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractChainPrefix
// ═══════════════════════════════════════════════════════════════════════

describe("extractChainPrefix", () => {
  it("extracts the prefix from OMFT-bridged assets (EVM and non-EVM)", () => {
    expect(extractChainPrefix("nep141:base-0x833589f.omft.near")).toBe("base");
    expect(extractChainPrefix("nep141:arb-0xaf88d065.omft.near")).toBe("arb");
    expect(extractChainPrefix("nep141:eth-0xa0b86991.omft.near")).toBe("eth");
    expect(extractChainPrefix("nep141:stellar-GA5Z.omft.near")).toBe("stellar");
    expect(extractChainPrefix("nep141:solana-7vfCXTU.omft.near")).toBe("solana");
    expect(extractChainPrefix("nep141:bitcoin-bc1q.omft.near")).toBe("bitcoin");
  });

  it("returns null for NEAR-native assets (named contracts and implicit hex accounts)", () => {
    // Tokens NOT ending in `.omft.near` are NEAR-native.
    expect(extractChainPrefix("nep141:usdt.tether-token.near")).toBeNull();
    expect(extractChainPrefix("nep141:wrap.near")).toBeNull();
    // 64-char implicit hex account.
    expect(
      extractChainPrefix("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toBeNull();
  });

  it("works with or without the nep141: prefix", () => {
    expect(extractChainPrefix("base-0x833589f.omft.near")).toBe("base");
    expect(extractChainPrefix("nep141:base-0x833589f.omft.near")).toBe("base");
  });

  it("returns null for obviously malformed input", () => {
    expect(extractChainPrefix("")).toBeNull();
    expect(extractChainPrefix("nep141:")).toBeNull();
    expect(extractChainPrefix("not-an-asset")).toBeNull();
    expect(extractChainPrefix("nep141:foo.near")).toBeNull(); // no hyphen
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isValidNearAccount
// ═══════════════════════════════════════════════════════════════════════

describe("isValidNearAccount", () => {
  it("accepts valid named accounts (.near, .tg) and 64-char hex implicit accounts", () => {
    expect(isValidNearAccount("alice.near")).toBe(true);
    expect(isValidNearAccount("sub.alice.near")).toBe(true);
    expect(isValidNearAccount("a-b-c.near")).toBe(true);
    expect(isValidNearAccount("acc_with_underscore.near")).toBe(true);
    expect(isValidNearAccount("foo.tg")).toBe(true);
    expect(isValidNearAccount("a".repeat(64))).toBe(true);
  });

  it("rejects wrong/missing TLAs (the .nea typo, .com, .eth, no TLA, .testnet)", () => {
    for (const bad of ["foo.nea", "foo.neer", "foo.com", "foo.eth", "foo.testnet", "merchant"]) {
      expect(isValidNearAccount(bad)).toBe(false);
    }
  });

  it("rejects format violations: uppercase, whitespace, edge separators, consecutive separators", () => {
    for (const bad of [
      "Merchant.near",            // uppercase
      "A".repeat(64),             // uppercase implicit
      " merchant.near",           // leading whitespace
      "merchant.near ",           // trailing whitespace
      ".near",                    // leading separator
      "-foo.near",                // leading hyphen
      "_foo.near",                // leading underscore
      "foo--bar.near",            // double hyphen
      "foo..bar.near",            // double dot
    ]) {
      expect(isValidNearAccount(bad)).toBe(false);
    }
  });

  it("rejects out-of-bounds lengths and empty input", () => {
    expect(isValidNearAccount("")).toBe(false);
    expect(isValidNearAccount("a")).toBe(false); // too short
    expect(isValidNearAccount("a".repeat(65))).toBe(false); // too long
    expect(isValidNearAccount("a".repeat(63))).toBe(false); // 63-char hex (one off)
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isNearNativeAsset
// ═══════════════════════════════════════════════════════════════════════

describe("isNearNativeAsset", () => {
  it("recognises NEAR-native named tokens and implicit hex accounts", () => {
    expect(isNearNativeAsset("nep141:usdt.tether-token.near")).toBe(true);
    expect(isNearNativeAsset("nep141:wrap.near")).toBe(true);
    expect(isNearNativeAsset("nep141:" + "a".repeat(64))).toBe(true);
  });

  it("rejects OMFT-bridged assets and non-NEAR-suffix tokens", () => {
    for (const bad of [
      "nep141:base-0x833589f.omft.near",
      "nep141:stellar-GA5Z.omft.near",
      "nep141:arb-0xaf88d065.omft.near",
      "nep141:foo.eth",
      "nep141:bar.com",
    ]) {
      expect(isNearNativeAsset(bad)).toBe(false);
    }
  });

  it("works with or without the nep141: prefix; rejects empty/malformed", () => {
    // Prefix-stripping fallback: both forms accepted.
    expect(isNearNativeAsset("wrap.near")).toBe(true);
    expect(isNearNativeAsset("a".repeat(64))).toBe(true);
    // Malformed.
    expect(isNearNativeAsset("")).toBe(false);
    expect(isNearNativeAsset("nep141:")).toBe(false);
  });
});
