/**
 * Tests for the swap-input Zod validator and JSON Schema mirror.
 *
 * Scope: assert OUR contracts, not Zod's behavior. Specifically:
 *  - Each required field is actually required (404 with structured details).
 *  - Each format regex catches the foot-guns that would otherwise silently
 *    misroute funds (e.g. fractional `amountIn` would be truncated by
 *    `BigInt()` and send the wrong amount to 1CS).
 *  - The JSON Schema mirror stays in lockstep with the Zod schema (same
 *    required list, same patterns) — the JSON Schema is what x402scan and
 *    the 402 envelope advertise; drift would publish a stale contract.
 */

import { describe, it, expect } from "vitest";
import {
  SwapRequestInputSchema,
  SwapRequestInputJsonSchema,
} from "./swap-input.js";

function validInput() {
  return {
    destinationAsset: "nep141:usdc.near",
    destinationAddress: "alice.near",
    amountIn: "10000000",
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SwapRequestInputSchema (Zod runtime validator)
// ═══════════════════════════════════════════════════════════════════════

describe("SwapRequestInputSchema — happy paths", () => {
  it("accepts a minimal valid input (no refundAddress)", () => {
    const result = SwapRequestInputSchema.safeParse(validInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refundAddress).toBeUndefined();
    }
  });

  it("accepts an input with the optional refundAddress", () => {
    const result = SwapRequestInputSchema.safeParse({
      ...validInput(),
      refundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.success).toBe(true);
  });
});

describe("SwapRequestInputSchema — required fields", () => {
  it("returns one Zod issue per missing required field", () => {
    const result = SwapRequestInputSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toEqual(
        expect.arrayContaining([
          "destinationAsset",
          "destinationAddress",
          "amountIn",
        ]),
      );
    }
  });
});

describe("SwapRequestInputSchema — format gates that prevent fund-misrouting", () => {
  // The BigInt foot-gun: `BigInt("10.5")` throws, but if the validator
  // accepted "10.5" we'd silently send a different amount to 1CS than the
  // buyer thought. The digits-only pattern is load-bearing.
  it("rejects fractional amountIn (would silently misroute funds)", () => {
    const result = SwapRequestInputSchema.safeParse({
      ...validInput(),
      amountIn: "10.5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects amountIn = '0' (paying nothing has no semantic meaning)", () => {
    const result = SwapRequestInputSchema.safeParse({
      ...validInput(),
      amountIn: "0",
    });
    expect(result.success).toBe(false);
  });

  // The destinationAsset gate is intentionally permissive (any
  // `<identifier>:<body>` shape) to forward-compat with 1CS namespace
  // additions. We only reject structurally-bogus shapes that 1CS would
  // never accept regardless.
  it.each([
    ["bare token name (no namespace prefix)", "usdc.near"],
    ["empty string", ""],
    ["prefix with empty body", "nep141:"],
    ["uppercase prefix (catches `NEP141:` typo)", "NEP141:foo"],
    ["leading punctuation", ":nep141:foo"],
  ])("rejects destinationAsset that is %s", (_label, value) => {
    const result = SwapRequestInputSchema.safeParse({
      ...validInput(),
      destinationAsset: value,
    });
    expect(result.success).toBe(false);
  });

  // The three asset-ID prefixes 1CS currently emits in production
  // (verified at https://1click.chaindefuser.com/v0/tokens 2026-05).
  // Adding a new prefix at 1CS should not require a gateway code change.
  it.each([
    ["nep141 native NEAR", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
    ["nep141 OMFT bridge", "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"],
    ["nep245 multi-token", "nep245:v2_1.omni.hot.tg:56_11111111111111111111"],
    ["1cs_v1 Solana SPL", "1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS"],
  ])("accepts %s asset IDs", (_label, value) => {
    const result = SwapRequestInputSchema.safeParse({
      ...validInput(),
      destinationAsset: value,
    });
    expect(result.success).toBe(true);
  });

  it("rejects refundAddress in non-EVM format", () => {
    // refundType is hardcoded ORIGIN_CHAIN (EVM), so a NEAR-style refundAddress
    // would be silently nonsense. Catch it here rather than at the upstream.
    const result = SwapRequestInputSchema.safeParse({
      ...validInput(),
      refundAddress: "alice.near",
    });
    expect(result.success).toBe(false);
  });

});

// ═══════════════════════════════════════════════════════════════════════
// SwapRequestInputJsonSchema — must mirror the Zod schema exactly so the
// contract published in /openapi.json + extensions.bazaar.info doesn't
// drift from runtime behavior.
// ═══════════════════════════════════════════════════════════════════════

describe("SwapRequestInputJsonSchema — Zod alignment", () => {
  it("declares the same required fields as Zod", () => {
    expect(SwapRequestInputJsonSchema.required).toEqual([
      "destinationAsset",
      "destinationAddress",
      "amountIn",
    ]);
  });

  it("mirrors every Zod regex pattern verbatim", () => {
    const props = SwapRequestInputJsonSchema.properties as Record<string, Record<string, unknown>>;
    expect((props.destinationAsset as { pattern: string }).pattern).toBe("^[a-z0-9][a-z0-9_]*:.+$");
    expect((props.amountIn as { pattern: string }).pattern).toBe("^[1-9]\\d*$");
    expect((props.refundAddress as { pattern: string }).pattern).toBe("^0x[a-fA-F0-9]{40}$");
  });

  it("forbids additional properties (closed schema, matches Zod's z.object default)", () => {
    expect(SwapRequestInputJsonSchema.additionalProperties).toBe(false);
  });
});
