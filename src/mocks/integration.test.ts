/**
 * Integration tests — full x402 flow using mock dependencies.
 *
 * These tests exercise the complete quote → verify → settle pipeline
 * with real cryptographic signatures (EIP-712) and mock external deps
 * (chain reader, broadcaster, 1CS API). They validate that the modules
 * work together correctly per the x402 spec.
 *
 * NOTE: This file is INTENTIONALLY DISTINCT from `src/e2e.test.ts`.
 * - `src/e2e.test.ts` asserts the canonical x402 HTTP wire format (headers,
 *   status codes, base64 encoding) using supertest against a real Express app.
 * - This file fans the happy- and sad-path flows out across every
 *   `DESTINATION_PRESETS` entry (NEAR / Arbitrum / Ethereum / Polygon /
 *   Stellar / Solana) via `describe.each`, calling the gateway functions
 *   directly without HTTP marshalling.
 *
 * Both axes (HTTP wire compliance × multi-chain destination) are needed.
 * Do NOT merge this file into `e2e.test.ts`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStateStore } from "../storage/store.js";
import { verifyPayment } from "../payment/verifier.js";
import { settlePayment, extractDestinationChain } from "../payment/settler.js";
import type { SwapState, SwapRequestInput } from "../types.js";

import {
  mockFastPollConfig,
  mockPaymentRequirements,
  signEIP3009Payload,
  signPermit2Payload,
  mockChainReader,
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  MOCK_DEPOSIT_ADDRESS,
  BUYER_ADDRESS,
  MOCK_TX_HASH,
  DESTINATION_PRESETS,
  buyerWallet,
  mockSwapState,
  mockSwapInputs,
} from "./index.js";

describe("Integration: full x402 flow with mocks", () => {
  let store: InMemoryStateStore;
  const cfg = mockFastPollConfig();

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  // ── Helper: simulate quote-engine creating the initial state ──────
  async function simulateQuote(
    overrides: Partial<SwapState> = {},
  ): Promise<SwapState> {
    const state = mockSwapState(overrides);
    await store.create(MOCK_DEPOSIT_ADDRESS, state);
    return state;
  }

  // ═══════════════════════════════════════════════════════════════════
  // EIP-3009 full flow
  // ═══════════════════════════════════════════════════════════════════

  describe("EIP-3009 — complete flow", () => {
    it("should succeed: quote → verify (real sig) → settle", async () => {
      // Step 1: Gateway quotes — creates QUOTED state
      const state = await simulateQuote();

      // Step 2: Buyer signs EIP-3009 authorization with real wallet
      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      // Step 3: Gateway verifies the payment signature
      const chainReader = mockChainReader();
      const verifyResult = await verifyPayment(
        payload,
        store,
        chainReader,
        cfg,
        { skipOnChainChecks: true }, // Skip balance check in unit test
      );

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.signerAddress?.toLowerCase()).toBe(
        BUYER_ADDRESS.toLowerCase(),
      );

      // State should now be VERIFIED
      const verifiedState = await store.get(MOCK_DEPOSIT_ADDRESS);
      expect(verifiedState!.phase).toBe("VERIFIED");
      expect(verifiedState!.signerAddress?.toLowerCase()).toBe(
        BUYER_ADDRESS.toLowerCase(),
      );

      // Step 4: Gateway settles — broadcast → notify → poll → response
      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn(); // happy path: SUCCESS

      const response = await settlePayment(
        MOCK_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      // Validate the x402 SettlementResponse
      expect(response.success).toBe(true);
      expect(response.transaction).toBe(MOCK_TX_HASH);
      expect(response.network).toBe("eip155:8453");
      expect(response.payer?.toLowerCase()).toBe(BUYER_ADDRESS.toLowerCase());
      expect(response.extra?.settlementType).toBe("crosschain-1cs");
      expect(response.extra?.swapStatus).toBe("SUCCESS");
      // The receipt's destinationChain comes from the buyer's swapInputs.
      expect(response.extra?.destinationChain).toBe(
        extractDestinationChain(state.swapInputs.destinationAsset),
      );
      // Receipt enrichment — operatorFee, slippage, formatted amounts
      // (D14 → CrossChainSettlementExtra in the PAYMENT-RESPONSE header).
      expect(response.extra?.operatorFee).toBeDefined();
      expect(response.extra?.operatorFee?.bps).toBe(state.operatorMarginBps);
      expect(response.extra?.destinationRecipient).toBe(
        state.swapInputs.destinationAddress,
      );

      // Final state should be SETTLED
      const settledState = await store.get(MOCK_DEPOSIT_ADDRESS);
      expect(settledState!.phase).toBe("SETTLED");
      expect(settledState!.originTxHash).toBe(MOCK_TX_HASH);
      expect(settledState!.oneClickStatus).toBe("SUCCESS");
      expect(settledState!.settledAt).toBeGreaterThan(0);
    });

    it("should succeed with on-chain balance checks enabled", async () => {
      await simulateQuote();

      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      // Use a chain reader with sufficient balance
      const chainReader = mockChainReader({ tokenBalance: 100_000_000n });
      const verifyResult = await verifyPayment(
        payload,
        store,
        chainReader,
        cfg,
        { skipOnChainChecks: false },
      );

      expect(verifyResult.valid).toBe(true);
    });

    it("should fail verification with insufficient balance", async () => {
      await simulateQuote();

      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      // Zero balance — should fail
      const chainReader = mockChainReader({ tokenBalance: 0n });
      const verifyResult = await verifyPayment(
        payload,
        store,
        chainReader,
        cfg,
        { skipOnChainChecks: false },
      );

      expect(verifyResult.valid).toBe(false);
      expect(verifyResult.error).toContain("Insufficient token balance");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Multi-chain destination — EIP-3009, parametrized by buyer destination
  // ═══════════════════════════════════════════════════════════════════

  describe.each([
    ["NEAR", DESTINATION_PRESETS.near, "near"],
    ["Arbitrum", DESTINATION_PRESETS.arbitrum, "eip155:42161"],
    ["Ethereum", DESTINATION_PRESETS.ethereum, "eip155:1"],
    ["Polygon", DESTINATION_PRESETS.polygon, "eip155:137"],
    ["Stellar (non-EVM)", DESTINATION_PRESETS.stellar, "stellar:pubnet"],
    ["Solana (non-EVM)", DESTINATION_PRESETS.solana, "solana:mainnet"],
  ] as const)("EIP-3009 — %s destination", (_label, preset, expectedChain) => {
    it(`should report destinationChain = ${expectedChain}`, async () => {
      // Build a buyer-supplied input from the preset.
      const inputs: SwapRequestInput = mockSwapInputs(preset);
      await store.create(MOCK_DEPOSIT_ADDRESS, mockSwapState({ swapInputs: inputs }));

      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      const chainReader = mockChainReader();
      await verifyPayment(payload, store, chainReader, cfg, {
        skipOnChainChecks: true,
      });

      const response = await settlePayment(
        MOCK_DEPOSIT_ADDRESS,
        store,
        mockBroadcastFn(),
        mockDepositNotifyFn(),
        mockStatusPollFn(),
        cfg,
      );

      expect(response.success).toBe(true);
      expect(response.extra?.destinationChain).toBe(expectedChain);
      expect(response.extra?.destinationAsset).toBe(preset.destinationAsset);
      expect(response.extra?.destinationRecipient).toBe(preset.destinationAddress);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Permit2 full flow
  // ═══════════════════════════════════════════════════════════════════

  describe("Permit2 — complete flow", () => {
    it("should succeed: quote → verify (real sig) → settle", async () => {
      // Use Permit2 requirements
      const permit2Requirements = mockPaymentRequirements({
        extra: {
          name: "USD Coin",
          version: "2",
          assetTransferMethod: "permit2",
        },
      });

      await store.create(
        MOCK_DEPOSIT_ADDRESS,
        mockSwapState({ paymentRequirements: permit2Requirements }),
      );

      // Buyer signs Permit2 authorization
      const { payload } = await signPermit2Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      // Verify
      const chainReader = mockChainReader();
      const verifyResult = await verifyPayment(
        payload,
        store,
        chainReader,
        cfg,
        { skipOnChainChecks: true },
      );

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.signerAddress?.toLowerCase()).toBe(
        BUYER_ADDRESS.toLowerCase(),
      );

      // Settle
      const response = await settlePayment(
        MOCK_DEPOSIT_ADDRESS,
        store,
        mockBroadcastFn(),
        mockDepositNotifyFn(),
        mockStatusPollFn(),
        cfg,
      );

      expect(response.success).toBe(true);
      expect(response.extra?.swapStatus).toBe("SUCCESS");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════

  describe("Edge cases", () => {
    it("should reject verification if buyer signs wrong deposit address", async () => {
      await simulateQuote();

      // Sign to a DIFFERENT address than the stored payTo. The verifier
      // looks up state by accepted.payTo, so a wrong address results in
      // "state not found" — which is the correct x402 behavior: the buyer
      // can't trick the gateway into accepting payment for a different
      // deposit address.
      const wrongAddress = "0x0000000000000000000000000000000000000001";
      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: wrongAddress,
        requirements: { payTo: wrongAddress },
      });

      const chainReader = mockChainReader();
      const result = await verifyPayment(
        payload,
        store,
        chainReader,
        cfg,
        { skipOnChainChecks: true },
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("No swap state found");
    });

    it("should reject verification if amount is too low", async () => {
      await simulateQuote();

      // Sign with insufficient amount
      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
        value: "1000", // Way below the 10,500,000 required
        requirements: { amount: "1000" },
      });

      const chainReader = mockChainReader();
      const result = await verifyPayment(
        payload,
        store,
        chainReader,
        cfg,
        { skipOnChainChecks: true },
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Amount too low");
    });

    it("should handle already-settled idempotency", async () => {
      await simulateQuote();

      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      const chainReader = mockChainReader();
      await verifyPayment(payload, store, chainReader, cfg, {
        skipOnChainChecks: true,
      });

      const firstResponse = await settlePayment(
        MOCK_DEPOSIT_ADDRESS,
        store,
        mockBroadcastFn(),
        mockDepositNotifyFn(),
        mockStatusPollFn(),
        cfg,
      );

      // Second pass: settler should return cached response
      const secondResponse = await settlePayment(
        MOCK_DEPOSIT_ADDRESS,
        store,
        mockBroadcastFn(), // Should NOT be called
        mockDepositNotifyFn(),
        mockStatusPollFn(),
        cfg,
      );

      expect(secondResponse).toEqual(firstResponse);
    });

    it("should fail settlement gracefully on broadcast error", async () => {
      await simulateQuote();

      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });

      const chainReader = mockChainReader();
      await verifyPayment(payload, store, chainReader, cfg, {
        skipOnChainChecks: true,
      });

      // Broadcast will fail
      const broadcast = mockBroadcastFn({
        eip3009Error: new Error("execution reverted: nonce already used"),
      });

      await expect(
        settlePayment(
          MOCK_DEPOSIT_ADDRESS,
          store,
          broadcast,
          mockDepositNotifyFn(),
          mockStatusPollFn(),
          cfg,
        ),
      ).rejects.toThrow("Broadcast failed");

      // State should be FAILED
      const finalState = await store.get(MOCK_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });
  });
});
