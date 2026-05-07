/**
 * Tests for the Settler module.
 *
 * Uses injectable BroadcastFn, DepositNotifyFn, and StatusPollFn to avoid
 * real on-chain interactions and 1CS API calls. All dependencies are stubs
 * that return configurable values, following the same pattern established
 * in quote-engine.test.ts and verifier.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  settlePayment,
  pollUntilTerminal,
  buildSettlementResponse,
  extractDestinationChain,
  recoverSettlement,
  recoverInFlightSettlements,
  type BroadcastFn,
  type BroadcastResult,
  type DepositNotifyFn,
  type DepositNotifyResult,
  type StatusPollFn,
  type StatusPollResult,
} from "./settler.js";
import { SettlementLimiter } from "../infra/rate-limiter.js";
import { InMemoryStateStore } from "../storage/store.js";
import type {
  SwapState,
  PaymentPayloadRecord,
  PaymentRequirementsRecord,
  QuoteResponseRecord,
  SettlementResponseRecord,
  OneClickStatus,
} from "../types.js";
import {
  SwapFailedError,
  SwapTimeoutError,
  InsufficientGasError,
} from "../types.js";
import type { GatewayConfig } from "../infra/config.js";
import { mockGatewayConfig, NETWORK, USDC_ADDRESS } from "../mocks/index.js";
import type {
  ExactEIP3009Payload,
  ExactPermit2Payload,
} from "@x402/evm";
import { x402ExactPermit2ProxyAddress } from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Test constants & helpers
// ═══════════════════════════════════════════════════════════════════════

const TEST_NETWORK = NETWORK;
const TEST_TOKEN_ADDRESS = USDC_ADDRESS;
const TEST_DEPOSIT_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const TEST_SIGNER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_TX_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return mockGatewayConfig(overrides);
}

function makeRequirements(
  overrides: Partial<PaymentRequirementsRecord> = {},
): PaymentRequirementsRecord {
  return {
    scheme: "exact",
    network: TEST_NETWORK,
    asset: TEST_TOKEN_ADDRESS,
    amount: "10500000",
    payTo: TEST_DEPOSIT_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    ...overrides,
  };
}

function makeQuoteResponse(
  overrides: Partial<QuoteResponseRecord> = {},
): QuoteResponseRecord {
  return {
    correlationId: "corr-123",
    timestamp: new Date().toISOString(),
    signature: "sig-abc",
    quoteRequest: {},
    quote: {
      depositAddress: TEST_DEPOSIT_ADDRESS,
      amountIn: "10500000",
      amountInFormatted: "10.50",
      amountInUsd: "10.50",
      minAmountIn: "10400000",
      amountOut: "10000000",
      amountOutFormatted: "10.00",
      amountOutUsd: "10.00",
      minAmountOut: "9900000",
      deadline: new Date(Date.now() + 600_000).toISOString(),
      timeEstimate: 30,
    },
    ...overrides,
  };
}

function makeEIP3009Payload(): PaymentPayloadRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    x402Version: 1,
    accepted: makeRequirements(),
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: TEST_SIGNER_ADDRESS,
        to: TEST_DEPOSIT_ADDRESS,
        value: "10500000",
        validAfter: "0",
        validBefore: String(nowSec + 300),
        nonce: "0x" + "11".repeat(32),
      },
    } satisfies ExactEIP3009Payload as unknown as Record<string, unknown>,
  };
}

function makePermit2Payload(): PaymentPayloadRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    x402Version: 1,
    accepted: makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    }),
    payload: {
      signature: "0x" + "cd".repeat(65),
      permit2Authorization: {
        from: TEST_SIGNER_ADDRESS,
        permitted: {
          token: TEST_TOKEN_ADDRESS,
          amount: "10500000",
        },
        spender: x402ExactPermit2ProxyAddress,
        nonce: "12345",
        deadline: String(nowSec + 300),
        witness: {
          to: TEST_DEPOSIT_ADDRESS,
          validAfter: "0",
        },
      },
    } satisfies ExactPermit2Payload as unknown as Record<string, unknown>,
  };
}

function makeVerifiedState(
  payloadOverride?: PaymentPayloadRecord,
): SwapState {
  return {
    depositAddress: TEST_DEPOSIT_ADDRESS,
    swapInputs: {
      destinationChain: "near",
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      destinationAddress: "alice.near",
      amountIn: "10500000",
    },
    operatorMarginBps: 30,
    quoteResponse: makeQuoteResponse(),
    paymentRequirements: makeRequirements(),
    paymentPayload: payloadOverride ?? makeEIP3009Payload(),
    signerAddress: TEST_SIGNER_ADDRESS,
    phase: "VERIFIED",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Mock dependency factories ───────────────────────────────────────

function mockBroadcastFn(
  overrides: Partial<BroadcastFn> = {},
): BroadcastFn {
  return {
    broadcastEIP3009: vi.fn().mockResolvedValue({
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 65000n,
    } satisfies BroadcastResult),
    broadcastPermit2: vi.fn().mockResolvedValue({
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 85000n,
    } satisfies BroadcastResult),
    checkAuthorizationState: vi.fn().mockResolvedValue(false),
    getFacilitatorBalance: vi.fn().mockResolvedValue(
      1_000_000_000_000_000_000n, // 1 ETH
    ),
    ...overrides,
  };
}

function mockDepositNotifyFn(
  result?: DepositNotifyResult,
): DepositNotifyFn {
  return vi.fn().mockResolvedValue(
    result ?? { status: "KNOWN_DEPOSIT_TX", correlationId: "corr-123" },
  );
}

function mockStatusPollFn(
  results?: StatusPollResult[],
): StatusPollFn {
  if (!results) {
    return vi.fn().mockResolvedValue({
      status: "SUCCESS" as OneClickStatus,
      swapDetails: {
        originChainTxHashes: [{ hash: TEST_TX_HASH, explorerUrl: "https://basescan.org/tx/" + TEST_TX_HASH }],
        destinationChainTxHashes: [{ hash: "dest-hash", explorerUrl: "https://nearblocks.io/tx/dest-hash" }],
        amountIn: "10500000",
        amountOut: "10000000",
      },
    } satisfies StatusPollResult);
  }
  // Return results in sequence
  const fn = vi.fn();
  for (const r of results) {
    fn.mockResolvedValueOnce(r);
  }
  return fn;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("settler", () => {
  let store: InMemoryStateStore;
  let cfg: GatewayConfig;

  beforeEach(() => {
    store = new InMemoryStateStore();
    // Use short poll intervals for test speed
    cfg = testConfig({
      pollIntervalBaseMs: 1,
      pollIntervalMaxMs: 5,
      maxPollTimeMs: 5000,
    });
  });

  // ── settlePayment: happy path ─────────────────────────────────────

  describe("settlePayment — happy path (EIP-3009)", () => {
    it("should settle an EIP-3009 payment end-to-end", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      // Verify response shape
      expect(response.success).toBe(true);
      expect(response.transaction).toBe(TEST_TX_HASH);
      expect(response.network).toBe(TEST_NETWORK);
      expect(response.payer).toBe(TEST_SIGNER_ADDRESS);
      expect(response.extra?.settlementType).toBe("crosschain-1cs");
      expect(response.extra?.swapStatus).toBe("SUCCESS");
      expect(response.extra?.correlationId).toBe("corr-123");

      // Verify state transitions
      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("SETTLED");
      expect(finalState!.originTxHash).toBe(TEST_TX_HASH);
      expect(finalState!.oneClickStatus).toBe("SUCCESS");
      expect(finalState!.settlementResponse).toBeDefined();
      expect(finalState!.settledAt).toBeGreaterThan(0);

      // Verify dependencies were called
      expect(broadcast.broadcastEIP3009).toHaveBeenCalledOnce();
      expect(broadcast.checkAuthorizationState).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(TEST_TX_HASH, TEST_DEPOSIT_ADDRESS);
      expect(poll).toHaveBeenCalledWith(TEST_DEPOSIT_ADDRESS);
    });
  });

  describe("settlePayment — happy path (Permit2)", () => {
    it("should settle a Permit2 payment end-to-end", async () => {
      const state = makeVerifiedState(makePermit2Payload());
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response.success).toBe(true);
      expect(response.transaction).toBe(TEST_TX_HASH);
      expect(broadcast.broadcastPermit2).toHaveBeenCalledOnce();
      expect(broadcast.broadcastEIP3009).not.toHaveBeenCalled();
      // Permit2 doesn't use checkAuthorizationState
      expect(broadcast.checkAuthorizationState).not.toHaveBeenCalled();
    });
  });

  // ── settlePayment: state validation ───────────────────────────────

  describe("settlePayment — state validation", () => {
    it("should throw if no state found", async () => {
      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment("0xnonexistent", store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("No swap state found");
    });

    it("should throw if state is not in VERIFIED phase", async () => {
      const state = makeVerifiedState();
      state.phase = "QUOTED";
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("Cannot settle swap in phase QUOTED");
    });

    it("should return cached response if already SETTLED", async () => {
      const cachedResponse: SettlementResponseRecord = {
        success: true,
        payer: TEST_SIGNER_ADDRESS,
        transaction: TEST_TX_HASH,
        network: TEST_NETWORK,
        amount: "10500000",
      };
      const state = makeVerifiedState();
      state.phase = "SETTLED" as any;
      state.settlementResponse = cachedResponse;
      // Need to create directly since InMemoryStateStore doesn't validate on create
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response).toEqual(cachedResponse);
      // No broadcast should have been attempted
      expect(broadcast.broadcastEIP3009).not.toHaveBeenCalled();
    });

    it("should throw if paymentPayload is missing", async () => {
      const state = makeVerifiedState();
      delete state.paymentPayload;
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("missing paymentPayload or signerAddress");
    });
  });

  // ── settlePayment: gas checks ─────────────────────────────────────

  describe("settlePayment — gas checks", () => {
    it("should throw InsufficientGasError when balance is too low", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        getFacilitatorBalance: vi.fn().mockResolvedValue(100n), // Way too low
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow(InsufficientGasError);
    });

    it("should proceed if balance check fails (non-fatal)", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        getFacilitatorBalance: vi.fn().mockRejectedValue(new Error("RPC error")),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response.success).toBe(true);
    });

    it("should respect custom minGasBalance option", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        getFacilitatorBalance: vi.fn().mockResolvedValue(500n),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      // With a very low threshold, 500 wei should be enough
      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
        { minGasBalance: 100n },
      );

      expect(response.success).toBe(true);
    });
  });

  // ── settlePayment: nonce pre-check (D-S3) ────────────────────────

  describe("settlePayment — nonce pre-check (D-S3)", () => {
    it("should fail if EIP-3009 nonce is already used", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        checkAuthorizationState: vi.fn().mockResolvedValue(true), // Nonce used
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("nonce already used");

      // State should be FAILED
      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });

    it("should proceed if nonce check fails (non-fatal)", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        checkAuthorizationState: vi.fn().mockRejectedValue(new Error("RPC down")),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response.success).toBe(true);
    });
  });

  // ── settlePayment: broadcast failures ─────────────────────────────

  describe("settlePayment — broadcast failures", () => {
    it("should fail swap and throw on broadcast error", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        broadcastEIP3009: vi.fn().mockRejectedValue(
          new Error("transaction reverted"),
        ),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("Broadcast failed");

      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
      expect(finalState!.error).toContain("Broadcast failed");
    });
  });

  // ── settlePayment: 1CS notification ───────────────────────────────

  describe("settlePayment — 1CS notification", () => {
    it("should continue if deposit notification fails (non-fatal)", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = vi.fn().mockRejectedValue(new Error("1CS unreachable"));
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      // Should still succeed — 1CS detects deposits via chain monitoring
      expect(response.success).toBe(true);
    });
  });

  // ── settlePayment: swap failure (D-S4) ────────────────────────────

  describe("settlePayment — swap failure (D-S4)", () => {
    it("should throw SwapFailedError when 1CS reports FAILED", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn([
        { status: "PROCESSING" },
        { status: "FAILED", swapDetails: { refundedAmount: "10500000" } },
      ]);

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg, {
          // Use very short polling for tests
        }),
      ).rejects.toThrow(SwapFailedError);

      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });

    it("should throw SwapFailedError when 1CS reports REFUNDED", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn([
        { status: "REFUNDED", swapDetails: { refundedAmount: "10500000" } },
      ]);

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow(SwapFailedError);
    });
  });

  // ── settlePayment: timeout ────────────────────────────────────────

  describe("settlePayment — timeout", () => {
    it("should throw SwapTimeoutError when polling exceeds maxPollTimeMs", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      // Always return non-terminal status
      const poll = vi.fn().mockResolvedValue({
        status: "PROCESSING" as OneClickStatus,
      });

      // Use very short timeout for the test
      const shortCfg = testConfig({
        maxPollTimeMs: 50,
        pollIntervalBaseMs: 10,
        pollIntervalMaxMs: 20,
      });

      await expect(
        settlePayment(
          TEST_DEPOSIT_ADDRESS,
          store,
          broadcast,
          notify,
          poll,
          shortCfg,
        ),
      ).rejects.toThrow(SwapTimeoutError);

      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });
  });

  // ── settlePayment: phase transitions ──────────────────────────────

  describe("settlePayment — phase transitions", () => {
    it("should transition through VERIFIED → BROADCASTING → BROADCAST → POLLING → SETTLED", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const phases: string[] = [];
      const originalUpdate = store.update.bind(store);
      store.update = async (addr, patch) => {
        if (patch.phase) phases.push(patch.phase);
        return originalUpdate(addr, patch);
      };

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(phases).toEqual([
        "BROADCASTING",
        "BROADCAST",
        "POLLING",
        "SETTLED",
      ]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// pollUntilTerminal
// ═══════════════════════════════════════════════════════════════════════

describe("pollUntilTerminal", () => {
  let store: InMemoryStateStore;

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  it("should return immediately on SUCCESS", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 1000 });
    const poll = mockStatusPollFn([
      {
        status: "SUCCESS",
        swapDetails: {
          destinationChainTxHashes: [{ hash: "dest", explorerUrl: "url" }],
          amountOut: "10000000",
        },
      },
    ]);

    const result = await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
    expect(result.status).toBe("SUCCESS");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("should poll multiple times until terminal", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = mockStatusPollFn([
      { status: "PENDING_DEPOSIT" },
      { status: "KNOWN_DEPOSIT_TX" },
      { status: "PROCESSING" },
      { status: "SUCCESS", swapDetails: { amountOut: "10000000" } },
    ]);

    const result = await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
    expect(result.status).toBe("SUCCESS");
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("should throw SwapFailedError on FAILED status", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = mockStatusPollFn([
      { status: "PROCESSING" },
      { status: "FAILED" },
    ]);

    await expect(
      pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg),
    ).rejects.toThrow(SwapFailedError);
  });

  it("should throw SwapTimeoutError when exceeding maxPollTimeMs", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 2, maxPollTimeMs: 15 });
    const poll = vi.fn().mockResolvedValue({ status: "PROCESSING" });

    await expect(
      pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg),
    ).rejects.toThrow(SwapTimeoutError);
  });

  it("should retry on poll errors", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({ status: "SUCCESS", swapDetails: { amountOut: "10000000" } });

    const result = await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
    expect(result.status).toBe("SUCCESS");
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("should include refund info in SwapFailedError for REFUNDED status", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = mockStatusPollFn([
      { status: "REFUNDED", swapDetails: { refundedAmount: "10500000" } },
    ]);

    try {
      await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SwapFailedError);
      const swapErr = err as SwapFailedError;
      expect(swapErr.swapStatus).toBe("REFUNDED");
      expect(swapErr.refundInfo?.amount).toBe("10500000");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildSettlementResponse
// ═══════════════════════════════════════════════════════════════════════

describe("buildSettlementResponse", () => {
  it("should build a complete settlement response", () => {
    const state = makeVerifiedState();
    const broadcastResult: BroadcastResult = {
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 65000n,
    };
    const pollResult: StatusPollResult = {
      status: "SUCCESS",
      swapDetails: {
        originChainTxHashes: [{ hash: TEST_TX_HASH, explorerUrl: "https://basescan.org/tx/" + TEST_TX_HASH }],
        destinationChainTxHashes: [{ hash: "dest-hash", explorerUrl: "https://nearblocks.io/tx/dest-hash" }],
        amountOut: "10000000",
      },
    };
    const cfg = testConfig();

    const response = buildSettlementResponse(state, broadcastResult, pollResult, cfg);

    expect(response.success).toBe(true);
    expect(response.payer).toBe(TEST_SIGNER_ADDRESS);
    expect(response.transaction).toBe(TEST_TX_HASH);
    expect(response.network).toBe(TEST_NETWORK);
    expect(response.amount).toBe("10500000");
    expect(response.extra).toBeDefined();
    expect(response.extra!.settlementType).toBe("crosschain-1cs");
    expect(response.extra!.swapStatus).toBe("SUCCESS");
    expect(response.extra!.destinationChain).toBe("near");
    expect(response.extra!.destinationAsset).toBe(state.swapInputs.destinationAsset);
    expect(response.extra!.destinationAmount).toBe("10000000");
    expect(response.extra!.correlationId).toBe("corr-123");
    expect(response.extra!.destinationTxHashes).toEqual([
      { hash: "dest-hash", explorerUrl: "https://nearblocks.io/tx/dest-hash" },
    ]);
  });

  it("should handle missing swap details gracefully", () => {
    const state = makeVerifiedState();
    const broadcastResult: BroadcastResult = {
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 65000n,
    };
    const pollResult: StatusPollResult = {
      status: "SUCCESS",
    };
    const cfg = testConfig();

    const response = buildSettlementResponse(state, broadcastResult, pollResult, cfg);

    expect(response.success).toBe(true);
    expect(response.extra?.destinationTxHashes).toBeUndefined();
    expect(response.extra?.destinationAmount).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractDestinationChain
// ═══════════════════════════════════════════════════════════════════════

describe("extractDestinationChain", () => {
  it("should extract chain from short-form 1CS asset ID", () => {
    expect(extractDestinationChain("near:nUSDC")).toBe("near");
    expect(extractDestinationChain("ethereum:USDT")).toBe("ethereum");
    expect(extractDestinationChain("base:USDC")).toBe("base");
  });

  it("should return full string if no colon", () => {
    expect(extractDestinationChain("near")).toBe("near");
  });

  it("should extract EVM chain from all mapped NEP-141 OMFT-bridged asset IDs", () => {
    const evmCases: [string, string][] = [
      ["nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "eip155:1"],
      ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "eip155:8453"],
      ["nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", "eip155:42161"],
      ["nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85.omft.near", "eip155:10"],
      ["nep141:polygon-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omft.near", "eip155:137"],
      ["nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omft.near", "eip155:43114"],
      ["nep141:bsc-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omft.near", "eip155:56"],
      ["nep141:turbochain-0x1234567890abcdef1234567890abcdef12345678.omft.near", "eip155:7897"],
      ["nep141:gnosis-0xddafbb505ad214d7b80b1f830fccc89b60fb7a83.omft.near", "eip155:100"],
      ["nep141:scroll-0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4.omft.near", "eip155:534352"],
      ["nep141:xlayer-0x74b7f16337b8972027f6196a17a631ac6de26d22.omft.near", "eip155:196"],
      ["nep141:berachain-0x549943e04f40284185054145c6e4e9568c1f0572.omft.near", "eip155:80094"],
    ];
    for (const [asset, expected] of evmCases) {
      expect(extractDestinationChain(asset)).toBe(expected);
    }
  });

  it("should extract non-EVM chain from all mapped NEP-141 OMFT-bridged asset IDs", () => {
    const nonEvmCases: [string, string][] = [
      ["nep141:solana-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.omft.near", "solana:mainnet"],
      ["nep141:stellar-GAXYZ1234567890abcdef.omft.near", "stellar:pubnet"],
      ["nep141:bitcoin-bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh.omft.near", "bitcoin:mainnet"],
      ["nep141:ton-EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA.omft.near", "ton:mainnet"],
      ["nep141:tron-TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t.omft.near", "tron:mainnet"],
      ["nep141:xrp-rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh.omft.near", "xrp:mainnet"],
      ["nep141:aptos-0x1234567890abcdef.omft.near", "aptos:mainnet"],
      ["nep141:sui-0x1234567890abcdef.omft.near", "sui:mainnet"],
      ["nep141:dogecoin-DRjxno1HEAt9EF4qBKBR8gK9Pjc5Swktmq.omft.near", "dogecoin:mainnet"],
    ];
    for (const [asset, expected] of nonEvmCases) {
      expect(extractDestinationChain(asset)).toBe(expected);
    }
  });

  it("should return raw prefix for unknown NEP-141 chain prefixes (graceful degradation)", () => {
    // Unknown prefix with hyphen — returns the raw prefix, not "near"
    expect(extractDestinationChain(
      "nep141:futurechain-0xabcdef1234567890abcdef.omft.near",
    )).toBe("futurechain");
    expect(extractDestinationChain(
      "nep141:newl2-0x1234567890abcdef.omft.near",
    )).toBe("newl2");
  });

  it("should return 'near' for native NEAR NEP-141 assets", () => {
    // Native NEAR USDC (hex token account ID)
    expect(extractDestinationChain(
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    )).toBe("near");
    // Named NEAR token account
    expect(extractDestinationChain("nep141:usdc.near")).toBe("near");
    expect(extractDestinationChain("nep141:wrap.near")).toBe("near");
  });

  it("should return 'near-testnet' for testnet NEP-141 assets", () => {
    expect(extractDestinationChain("nep141:usdc.testnet")).toBe("near-testnet");
  });

  it("should pass through CAIP-2 identifiers", () => {
    expect(extractDestinationChain("eip155:8453")).toBe("eip155");
    expect(extractDestinationChain("eip155:1")).toBe("eip155");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// recoverSettlement — single-swap recovery
// ═══════════════════════════════════════════════════════════════════════

describe("recoverSettlement", () => {
  let store: InMemoryStateStore;
  let cfg: GatewayConfig;

  beforeEach(() => {
    store = new InMemoryStateStore();
    cfg = testConfig({
      pollIntervalBaseMs: 1,
      pollIntervalMaxMs: 5,
      maxPollTimeMs: 5000,
    });
  });

  /** Create a state stuck in a given phase. */
  function makeStuckState(
    phase: "BROADCASTING" | "BROADCAST" | "POLLING",
    extra: Partial<SwapState> = {},
  ): SwapState {
    return {
      depositAddress: TEST_DEPOSIT_ADDRESS,
      swapInputs: {
        destinationChain: "near",
        destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        destinationAddress: "alice.near",
        amountIn: "10500000",
      },
      operatorMarginBps: 30,
      quoteResponse: makeQuoteResponse(),
      paymentRequirements: makeRequirements(),
      paymentPayload: makeEIP3009Payload(),
      signerAddress: TEST_SIGNER_ADDRESS,
      phase,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    };
  }

  it("should recover a POLLING swap by resuming polling", async () => {
    const state = makeStuckState("POLLING", { originTxHash: TEST_TX_HASH });
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const notify = mockDepositNotifyFn();
    const poll = mockStatusPollFn();

    await recoverSettlement(state, store, notify, poll, cfg);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("SETTLED");
    expect(final!.settlementResponse?.success).toBe(true);
    expect(final!.settlementResponse?.transaction).toBe(TEST_TX_HASH);
    // depositNotifyFn should NOT be called for POLLING phase
    expect(notify).not.toHaveBeenCalled();
  });

  it("should recover a BROADCAST swap by re-notifying then polling", async () => {
    const state = makeStuckState("BROADCAST", { originTxHash: TEST_TX_HASH });
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const notify = mockDepositNotifyFn();
    const poll = mockStatusPollFn();

    await recoverSettlement(state, store, notify, poll, cfg);

    // Should have called depositNotifyFn
    expect(notify).toHaveBeenCalledWith(TEST_TX_HASH, TEST_DEPOSIT_ADDRESS);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("SETTLED");
    expect(final!.settlementResponse?.success).toBe(true);
  });

  it("should recover BROADCAST even if deposit-notify fails", async () => {
    const state = makeStuckState("BROADCAST", { originTxHash: TEST_TX_HASH });
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const notify = vi.fn().mockRejectedValue(new Error("1CS unavailable"));
    const poll = mockStatusPollFn();

    await recoverSettlement(state, store, notify, poll, cfg);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("SETTLED");
  });

  it("should mark BROADCASTING without txHash as FAILED", async () => {
    const state = makeStuckState("BROADCASTING"); // no originTxHash
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const notify = mockDepositNotifyFn();
    const poll = mockStatusPollFn();

    await recoverSettlement(state, store, notify, poll, cfg);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("FAILED");
    expect(final!.error).toContain("cannot safely re-broadcast");
    // Neither notify nor poll should be called
    expect(notify).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });

  it("should recover BROADCASTING with txHash as if BROADCAST", async () => {
    const state = makeStuckState("BROADCASTING", { originTxHash: TEST_TX_HASH });
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const notify = mockDepositNotifyFn();
    const poll = mockStatusPollFn();

    await recoverSettlement(state, store, notify, poll, cfg);

    expect(notify).toHaveBeenCalledWith(TEST_TX_HASH, TEST_DEPOSIT_ADDRESS);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("SETTLED");
    expect(final!.settlementResponse?.transaction).toBe(TEST_TX_HASH);
  });

  it("should mark FAILED on poll timeout", async () => {
    const state = makeStuckState("POLLING", { originTxHash: TEST_TX_HASH });
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const shortCfg = testConfig({
      pollIntervalBaseMs: 1,
      pollIntervalMaxMs: 2,
      maxPollTimeMs: 10, // Very short — will timeout
    });

    // Poll always returns non-terminal status
    const poll = vi.fn().mockResolvedValue({
      status: "PROCESSING" as OneClickStatus,
    } satisfies StatusPollResult);

    await recoverSettlement(state, store, mockDepositNotifyFn(), poll, shortCfg);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("FAILED");
    expect(final!.error).toContain("Recovery failed");
  });

  it("should mark FAILED if 1CS reports FAILED", async () => {
    const state = makeStuckState("POLLING", { originTxHash: TEST_TX_HASH });
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const poll = vi.fn().mockResolvedValue({
      status: "FAILED" as OneClickStatus,
    } satisfies StatusPollResult);

    await recoverSettlement(state, store, mockDepositNotifyFn(), poll, cfg);

    const final = await store.get(TEST_DEPOSIT_ADDRESS);
    expect(final!.phase).toBe("FAILED");
    expect(final!.error).toContain("Recovery failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// recoverInFlightSettlements — startup orchestrator
// ═══════════════════════════════════════════════════════════════════════

describe("recoverInFlightSettlements", () => {
  let store: InMemoryStateStore;
  let cfg: GatewayConfig;

  beforeEach(() => {
    store = new InMemoryStateStore();
    cfg = testConfig({
      pollIntervalBaseMs: 1,
      pollIntervalMaxMs: 5,
      maxPollTimeMs: 5000,
    });
  });

  function makeStuckState(
    depositAddress: string,
    phase: "BROADCASTING" | "BROADCAST" | "POLLING",
    extra: Partial<SwapState> = {},
  ): SwapState {
    return {
      depositAddress,
      swapInputs: {
        destinationChain: "near",
        destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        destinationAddress: "alice.near",
        amountIn: "10500000",
      },
      operatorMarginBps: 30,
      quoteResponse: makeQuoteResponse({ correlationId: `corr-${depositAddress}` }),
      paymentRequirements: makeRequirements({ payTo: depositAddress }),
      paymentPayload: makeEIP3009Payload(),
      signerAddress: TEST_SIGNER_ADDRESS,
      phase,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    };
  }

  it("should return zeros when no stuck swaps exist", async () => {
    const result = await recoverInFlightSettlements(
      store, mockDepositNotifyFn(), mockStatusPollFn(), undefined, cfg,
    );
    expect(result.total).toBe(0);
    expect(result.started).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  it("should find and start recovery across all phases", async () => {
    const s1 = makeStuckState("0xA", "BROADCASTING"); // no txHash → FAILED
    const s2 = makeStuckState("0xB", "BROADCAST", { originTxHash: "0xTX_B" });
    const s3 = makeStuckState("0xC", "POLLING", { originTxHash: "0xTX_C" });

    await store.create("0xA", s1);
    await store.create("0xB", s2);
    await store.create("0xC", s3);

    const result = await recoverInFlightSettlements(
      store, mockDepositNotifyFn(), mockStatusPollFn(), undefined, cfg,
    );
    expect(result.total).toBe(3);
    expect(result.started).toBe(3);
    expect(result.skipped).toBe(0);

    // Await background recovery tasks deterministically.
    await Promise.all(result.tasks);

    // 0xA: FAILED (no txHash)
    expect((await store.get("0xA"))!.phase).toBe("FAILED");
    // 0xB: SETTLED (notify + poll)
    expect((await store.get("0xB"))!.phase).toBe("SETTLED");
    // 0xC: SETTLED (poll only)
    expect((await store.get("0xC"))!.phase).toBe("SETTLED");
  });

  it("should respect settlement limiter capacity", async () => {
    const s1 = makeStuckState("0xA", "POLLING", { originTxHash: "0xTX_A" });
    const s2 = makeStuckState("0xB", "POLLING", { originTxHash: "0xTX_B" });
    const s3 = makeStuckState("0xC", "POLLING", { originTxHash: "0xTX_C" });

    await store.create("0xA", s1);
    await store.create("0xB", s2);
    await store.create("0xC", s3);

    // Limiter with capacity 1, pre-acquire the only slot
    const limiter = new SettlementLimiter(1);
    limiter.acquire(); // fills up

    const result = await recoverInFlightSettlements(
      store, mockDepositNotifyFn(), mockStatusPollFn(), limiter, cfg,
    );

    expect(result.total).toBe(3);
    expect(result.started).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it("should release limiter slots after recovery completes", async () => {
    const s1 = makeStuckState("0xA", "POLLING", { originTxHash: "0xTX_A" });
    await store.create("0xA", s1);

    const limiter = new SettlementLimiter(5);

    const result = await recoverInFlightSettlements(
      store, mockDepositNotifyFn(), mockStatusPollFn(), limiter, cfg,
    );

    // Initially 1 slot taken
    expect(limiter.current).toBe(1);

    // Await recovery tasks deterministically.
    await Promise.all(result.tasks);

    // Slot released
    expect(limiter.current).toBe(0);
  });

  it("should ignore QUOTED, VERIFIED, SETTLED, FAILED, EXPIRED phases", async () => {
    // Create states in non-recoverable phases directly (store.create is idempotent)
    const base = makeStuckState("0xA", "POLLING"); // template for field shape
    await store.create("0xA", { ...base, depositAddress: "0xA", phase: "QUOTED" });
    await store.create("0xB", { ...base, depositAddress: "0xB", phase: "VERIFIED" });
    await store.create("0xC", { ...base, depositAddress: "0xC", phase: "SETTLED" });
    await store.create("0xD", { ...base, depositAddress: "0xD", phase: "FAILED" });
    await store.create("0xE", { ...base, depositAddress: "0xE", phase: "EXPIRED" });

    const result = await recoverInFlightSettlements(
      store, mockDepositNotifyFn(), mockStatusPollFn(), undefined, cfg,
    );
    expect(result.total).toBe(0);
  });
});
