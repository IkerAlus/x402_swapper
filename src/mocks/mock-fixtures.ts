/**
 * Higher-level fixture builders that compose the lower-level mocks.
 *
 * Centralised so individual tests don't repeat the swap-input + quote-
 * response + state-shape ceremony — they grab the fixture they need and
 * override the bit they're testing. New required fields on `SwapState`
 * (or new fields on `ProtectedRoute`) flow into every consumer here so
 * a future shape change is a single edit.
 *
 * @module mocks/mock-fixtures
 */

import type { RequestHandler } from "express";
import type {
  SwapState,
  SwapPhase,
  PaymentPayloadRecord,
} from "../types.js";
import type { ProtectedRoute } from "../http/protected-routes.js";
import {
  SwapRequestInputSchema,
  SwapRequestInputJsonSchema,
} from "../http/swap-input.js";
import {
  MOCK_DEPOSIT_ADDRESS,
  mockSwapInputs,
  mockQuoteResponse,
} from "./mock-1cs-responses.js";
import { mockPaymentRequirements } from "./mock-x402-payloads.js";

// ═══════════════════════════════════════════════════════════════════════
// SwapState fixture
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a complete {@link SwapState} fixture with all required fields
 * populated, including the swap-as-resource fields (`swapInputs`,
 * `operatorMarginBps`).
 *
 * Defaults:
 *  - depositAddress = {@link MOCK_DEPOSIT_ADDRESS}
 *  - swapInputs     = {@link mockSwapInputs}
 *  - phase          = `"QUOTED"`
 *  - operatorMarginBps = `30` (0.3%)
 *  - quoteResponse  = {@link mockQuoteResponse} bound to `swapInputs`
 *  - paymentRequirements = {@link mockPaymentRequirements}
 *
 * Pass overrides for whatever the test cares about; e.g. `phase: "VERIFIED"`
 * + `paymentPayload` + `signerAddress` to build a state ready to settle.
 */
export function mockSwapState(
  overrides: Partial<SwapState> = {},
): SwapState {
  const inputs = overrides.swapInputs ?? mockSwapInputs();
  const now = Date.now();

  return {
    depositAddress: MOCK_DEPOSIT_ADDRESS,
    swapInputs: inputs,
    operatorMarginBps: 30,
    quoteResponse: mockQuoteResponse(inputs),
    paymentRequirements: mockPaymentRequirements(),
    phase: "QUOTED",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Convenience factory for a state in a specific phase. Mostly for
 * `recoverInFlightSettlements` tests that need a state mid-flight
 * without repeating the phase + dependent-field combination.
 */
export function mockSwapStateInPhase(
  phase: SwapPhase,
  overrides: Partial<SwapState> = {},
): SwapState {
  switch (phase) {
    case "VERIFIED":
      return mockSwapState({
        phase: "VERIFIED",
        signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        ...overrides,
      });
    case "BROADCASTING":
      return mockSwapState({
        phase: "BROADCASTING",
        signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        ...overrides,
      });
    case "BROADCAST":
      return mockSwapState({
        phase: "BROADCAST",
        signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        originTxHash: "0xf1e2d3c4b5a697f8e9d0c1b2a3948576061728394a5b6c7d8e9f0a1b2c3d4e5f",
        ...overrides,
      });
    case "POLLING":
      return mockSwapState({
        phase: "POLLING",
        signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        originTxHash: "0xf1e2d3c4b5a697f8e9d0c1b2a3948576061728394a5b6c7d8e9f0a1b2c3d4e5f",
        ...overrides,
      });
    default:
      return mockSwapState({ phase, ...overrides });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ProtectedRoute fixture
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a fully-bound {@link ProtectedRoute} suitable for injection into
 * `MiddlewareDeps.route`. Uses the live swap-input validator + JSON
 * Schema so middleware tests exercise the real Zod parsing path.
 *
 * The handler is a no-op `res.json({})` (the receipt is in the
 * PAYMENT-RESPONSE header — D14). Tests that care about the response
 * body can pass a custom handler.
 */
export function mockProtectedRoute(
  overrides: Partial<ProtectedRoute> = {},
): ProtectedRoute {
  const handler: RequestHandler = (_req, res) => {
    res.json({});
  };

  return {
    path: "/api/swap",
    method: "GET",
    summary: "Cross-chain swap",
    description: "Test fixture for the swap-as-resource route.",
    pricing: { currency: "USD", min: "0.01", max: "100000" },
    inputValidator: SwapRequestInputSchema,
    inputSchema: SwapRequestInputJsonSchema,
    outputSchema: { type: "object", additionalProperties: false },
    handler,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Re-export PaymentPayloadRecord for fixture consumers (saves one import)
// ═══════════════════════════════════════════════════════════════════════

export type { PaymentPayloadRecord };
