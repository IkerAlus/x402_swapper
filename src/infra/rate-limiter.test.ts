/**
 * Tests for the rate-limiting and abuse-prevention module.
 *
 * Covers:
 * - QuoteRateLimiter: sliding-window per-IP rate limiting
 * - SettlementLimiter: concurrent settlement cap
 * - QuoteGarbageCollector: expired quote cleanup
 * - Middleware integration: 429 responses, rate-limit headers, 503 on settlement cap
 *
 * @module rate-limiter.test
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

import {
  QuoteRateLimiter,
  SettlementLimiter,
  QuoteGarbageCollector,
} from "./rate-limiter.js";
import { createX402Middleware } from "../http/middleware.js";
import type { MiddlewareDeps } from "../http/middleware.js";
import { InMemoryStateStore } from "../storage/store.js";
import { mockFastPollConfig } from "../mocks/mock-config.js";
import {
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  mockChainReader,
  signEIP3009Payload,
  buyerWallet,
  mockSwapInputs,
  mockProtectedRoute,
} from "../mocks/index.js";
import type { SwapState, QuoteResponse, SwapRequestInput } from "../types.js";
import type { QuoteFn } from "../payment/quote-engine.js";
import { MOCK_DEPOSIT_ADDRESS, mockQuoteResponse } from "../mocks/mock-1cs-responses.js";
import { mockPaymentRequirements } from "../mocks/mock-x402-payloads.js";

function createMockQuoteFn(inputs: SwapRequestInput = mockSwapInputs()): QuoteFn {
  return async () => mockQuoteResponse(inputs) as unknown as QuoteResponse;
}

/** Build the buyer's query string for the swap route from a SwapRequestInput. */
function swapQuery(inputs: SwapRequestInput = mockSwapInputs()): Record<string, string> {
  const out: Record<string, string> = {
    destinationChain: inputs.destinationChain,
    destinationAsset: inputs.destinationAsset,
    destinationAddress: inputs.destinationAddress,
    amountIn: inputs.amountIn,
  };
  if (inputs.refundAddress) out.refundAddress = inputs.refundAddress;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// QuoteRateLimiter
// ═══════════════════════════════════════════════════════════════════════

describe("QuoteRateLimiter", () => {
  let limiter: QuoteRateLimiter;
  let clock: number;

  beforeEach(() => {
    clock = 1000;
    limiter = new QuoteRateLimiter(
      { maxRequests: 3, windowMs: 10_000 },
      { now: () => clock },
    );
  });

  afterEach(() => {
    limiter.destroy();
  });

  it("allows requests under the limit", () => {
    const r1 = limiter.check("1.2.3.4");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check("1.2.3.4");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check("1.2.3.4");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests over the limit", () => {
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");

    const r4 = limiter.check("1.2.3.4");
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("tracks IPs independently", () => {
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");

    // Different IP should still be allowed
    const r = limiter.check("2.2.2.2");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("resets after the window expires", () => {
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");

    // Still blocked
    expect(limiter.check("1.2.3.4").allowed).toBe(false);

    // Advance past the window
    clock += 10_001;

    const r = limiter.check("1.2.3.4");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it("uses a sliding window, not fixed intervals", () => {
    clock = 1000;
    limiter.check("1.2.3.4"); // t=1000

    clock = 5000;
    limiter.check("1.2.3.4"); // t=5000

    clock = 9000;
    limiter.check("1.2.3.4"); // t=9000

    // At t=9000 all 3 are within the 10s window → blocked
    expect(limiter.check("1.2.3.4").allowed).toBe(false);

    // At t=11001, the first request (t=1000) has expired → 1 slot freed
    // Remaining in window: t=5000 and t=9000. This new request makes 3 total → 0 remaining.
    clock = 11001;
    const r = limiter.check("1.2.3.4");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it("returns correct resetAt when blocked", () => {
    clock = 1000;
    limiter.check("1.2.3.4");
    clock = 2000;
    limiter.check("1.2.3.4");
    clock = 3000;
    limiter.check("1.2.3.4");

    clock = 4000;
    const r = limiter.check("1.2.3.4");
    expect(r.allowed).toBe(false);
    // The oldest request in the window is at t=1000, so resetAt = 1000 + 10000 = 11000
    expect(r.resetAt).toBe(11_000);
  });

  it("reports size (tracked IPs)", () => {
    expect(limiter.size).toBe(0);
    limiter.check("1.1.1.1");
    limiter.check("2.2.2.2");
    expect(limiter.size).toBe(2);
  });

  it("reset clears all state", () => {
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    limiter.check("1.1.1.1");
    expect(limiter.check("1.1.1.1").allowed).toBe(false);

    limiter.reset();

    expect(limiter.size).toBe(0);
    expect(limiter.check("1.1.1.1").allowed).toBe(true);
  });

  it("does not record blocked attempts", () => {
    // Fill the limit
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");

    // These blocked attempts should not count
    limiter.check("1.2.3.4");
    limiter.check("1.2.3.4");

    // After window expires, should be clean
    clock += 10_001;
    const r = limiter.check("1.2.3.4");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SettlementLimiter
// ═══════════════════════════════════════════════════════════════════════

describe("SettlementLimiter", () => {
  it("allows acquisitions up to the limit", () => {
    const limiter = new SettlementLimiter(3);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(false);
  });

  it("releases slots correctly", () => {
    const limiter = new SettlementLimiter(2);
    limiter.acquire();
    limiter.acquire();
    expect(limiter.acquire()).toBe(false);

    limiter.release();
    expect(limiter.current).toBe(1);
    expect(limiter.acquire()).toBe(true);
  });

  it("does not go below zero on extra releases", () => {
    const limiter = new SettlementLimiter(2);
    limiter.release(); // No-op
    expect(limiter.current).toBe(0);
  });

  it("reports current, capacity, and available", () => {
    const limiter = new SettlementLimiter(3);
    expect(limiter.current).toBe(0);
    expect(limiter.capacity).toBe(3);
    expect(limiter.available).toBe(true);

    limiter.acquire();
    limiter.acquire();
    limiter.acquire();
    expect(limiter.current).toBe(3);
    expect(limiter.available).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// QuoteGarbageCollector
// ═══════════════════════════════════════════════════════════════════════

describe("QuoteGarbageCollector", () => {
  let store: InMemoryStateStore;

  function makeState(overrides: Partial<SwapState> = {}): SwapState {
    return {
      depositAddress: MOCK_DEPOSIT_ADDRESS,
      quoteResponse: mockQuoteResponse(),
      paymentRequirements: mockPaymentRequirements(),
      phase: "QUOTED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  it("deletes states older than the grace period", async () => {
    const now = 100_000;
    const gc = new QuoteGarbageCollector(store, 5_000, () => now);

    // Old state (created at t=1000, grace=5000, cutoff=95000 → 1000 < 95000 → expired)
    await store.create("0xOLD", makeState({ depositAddress: "0xOLD", createdAt: 1_000 }));
    // Recent state (created at t=99000 → not expired)
    await store.create("0xNEW", makeState({ depositAddress: "0xNEW", createdAt: 99_000 }));

    const deleted = await gc.sweep();
    expect(deleted).toBe(1);
    expect(await store.get("0xOLD")).toBeNull();
    expect(await store.get("0xNEW")).not.toBeNull();
  });

  it("returns 0 when nothing to delete", async () => {
    const gc = new QuoteGarbageCollector(store, 5_000, () => 100_000);
    await store.create("0xNEW", makeState({ depositAddress: "0xNEW", createdAt: 99_000 }));

    const deleted = await gc.sweep();
    expect(deleted).toBe(0);
  });

  it("handles empty store", async () => {
    const gc = new QuoteGarbageCollector(store, 5_000);
    const deleted = await gc.sweep();
    expect(deleted).toBe(0);
  });

  it("prevents overlapping sweeps", async () => {
    // Create a slow store that takes time to list expired
    let listExpiredCallCount = 0;
    const slowStore: typeof store = {
      ...store,
      async listExpired(olderThanMs: number, phases?: ReadonlySet<SwapState["phase"]>) {
        listExpiredCallCount++;
        // Simulate delay
        await new Promise((r) => setTimeout(r, 50));
        return store.listExpired(olderThanMs, phases);
      },
      // delegate the rest
      create: store.create.bind(store),
      get: store.get.bind(store),
      update: store.update.bind(store),
      delete: store.delete.bind(store),
    };

    const gc = new QuoteGarbageCollector(slowStore, 5_000, () => 100_000);
    await store.create("0xOLD", makeState({ depositAddress: "0xOLD", createdAt: 1_000 }));

    // Start two sweeps concurrently
    const [d1, d2] = await Promise.all([gc.sweep(), gc.sweep()]);

    // Only one should have actually run
    expect(listExpiredCallCount).toBe(1);
    expect(d1 + d2).toBe(1); // One deleted 1, the other returned 0
  });

  it("does not delete in-flight settlements", async () => {
    const gc = new QuoteGarbageCollector(store, 5_000, () => 100_000);

    // Old QUOTED state — eligible for GC
    await store.create(
      "0xQUOTE",
      makeState({ depositAddress: "0xQUOTE", createdAt: 1_000, phase: "QUOTED" }),
    );

    // Old POLLING state — must NOT be deleted
    await store.create(
      "0xPOLL",
      makeState({ depositAddress: "0xPOLL", createdAt: 1_000, phase: "QUOTED" }),
    );
    await store.update("0xPOLL", { phase: "VERIFIED" });
    await store.update("0xPOLL", { phase: "BROADCASTING" });
    await store.update("0xPOLL", { phase: "BROADCAST", originTxHash: "0xTX" });
    await store.update("0xPOLL", { phase: "POLLING" });

    // Old BROADCASTING state — must NOT be deleted either
    await store.create(
      "0xBROAD",
      makeState({ depositAddress: "0xBROAD", createdAt: 1_000, phase: "QUOTED" }),
    );
    await store.update("0xBROAD", { phase: "VERIFIED" });
    await store.update("0xBROAD", { phase: "BROADCASTING" });

    const deleted = await gc.sweep();
    expect(deleted).toBe(1);
    expect(await store.get("0xQUOTE")).toBeNull();
    expect(await store.get("0xPOLL")).not.toBeNull();
    expect(await store.get("0xBROAD")).not.toBeNull();
  });

  it("deletes terminal states (SETTLED/FAILED/EXPIRED) older than grace period", async () => {
    const gc = new QuoteGarbageCollector(store, 5_000, () => 100_000);

    // Walk 0xDONE through to SETTLED
    await store.create(
      "0xDONE",
      makeState({ depositAddress: "0xDONE", createdAt: 1_000, phase: "QUOTED" }),
    );
    await store.update("0xDONE", { phase: "VERIFIED" });
    await store.update("0xDONE", { phase: "BROADCASTING" });
    await store.update("0xDONE", { phase: "BROADCAST", originTxHash: "0xTX" });
    await store.update("0xDONE", { phase: "POLLING" });
    await store.update("0xDONE", { phase: "SETTLED" });

    // Mark another as FAILED directly
    await store.create(
      "0xFAIL",
      makeState({ depositAddress: "0xFAIL", createdAt: 1_000, phase: "QUOTED" }),
    );
    await store.update("0xFAIL", { phase: "FAILED", error: "test" });

    const deleted = await gc.sweep();
    expect(deleted).toBe(2);
    expect(await store.get("0xDONE")).toBeNull();
    expect(await store.get("0xFAIL")).toBeNull();
  });

  it("start and stop manage the timer", () => {
    const gc = new QuoteGarbageCollector(store, 5_000);
    gc.start(1000);
    // Calling start again is a no-op (no double-start)
    gc.start(1000);
    gc.stop();
    gc.stop(); // Double-stop is safe
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Middleware Integration
// ═══════════════════════════════════════════════════════════════════════

describe("Rate limiting middleware integration", () => {
  function createTestApp(overrides: Partial<MiddlewareDeps> = {}) {
    const store = new InMemoryStateStore();
    const cfg = mockFastPollConfig();
    const route = mockProtectedRoute();

    const deps: MiddlewareDeps = {
      cfg,
      store,
      chainReader: mockChainReader(),
      broadcastFn: mockBroadcastFn(),
      depositNotifyFn: mockDepositNotifyFn(),
      statusPollFn: mockStatusPollFn(),
      quoteFn: createMockQuoteFn(),
      route,
      ...overrides,
    };

    const app = express();
    app.use(express.json());
    app.set("trust proxy", true); // So req.ip works in tests
    app.get(
      route.path,
      createX402Middleware(deps),
      (_req, res) => {
        res.json({});
      },
    );
    return { app, store, deps };
  }

  // ── Quote rate limiting ───────────────────────────────────────────

  describe("quote rate limiting (429)", () => {
    it("returns 429 when quote rate limit is exceeded", async () => {
      const clock = 1000;
      const quoteLimiter = new QuoteRateLimiter(
        { maxRequests: 2, windowMs: 60_000 },
        { now: () => clock },
      );

      const { app } = createTestApp({ quoteLimiter });
      const q = swapQuery();

      // First 2 requests should get 402 (normal quote flow)
      const r1 = await request(app).get("/api/swap").query(q);
      expect(r1.status).toBe(402);

      const r2 = await request(app).get("/api/swap").query(q);
      expect(r2.status).toBe(402);

      // Third should be rate-limited
      const r3 = await request(app).get("/api/swap").query(q);
      expect(r3.status).toBe(429);
      expect(r3.body.error).toBe("RATE_LIMITED");
      expect(r3.headers["retry-after"]).toBeDefined();
      expect(r3.headers["x-ratelimit-remaining"]).toBe("0");

      quoteLimiter.destroy();
    });

    it("includes rate-limit headers on allowed requests", async () => {
      const quoteLimiter = new QuoteRateLimiter(
        { maxRequests: 5, windowMs: 60_000 },
      );

      const { app } = createTestApp({ quoteLimiter });

      const res = await request(app).get("/api/swap").query(swapQuery());
      expect(res.status).toBe(402);
      expect(res.headers["x-ratelimit-limit"]).toBe("5");
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();

      quoteLimiter.destroy();
    });

    it("does not rate-limit requests that carry a PAYMENT-SIGNATURE", async () => {
      const clock = 1000;
      const quoteLimiter = new QuoteRateLimiter(
        { maxRequests: 1, windowMs: 60_000 },
        { now: () => clock },
      );

      const { app } = createTestApp({ quoteLimiter });
      const q = swapQuery();

      // Use up the quota
      await request(app).get("/api/swap").query(q);

      // Next bare request should be blocked
      const blocked = await request(app).get("/api/swap").query(q);
      expect(blocked.status).toBe(429);

      // But a request with PAYMENT-SIGNATURE should bypass the rate limiter
      // (it'll fail for other reasons, but it won't be 429)
      const { payload } = await signEIP3009Payload(buyerWallet);
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

      const paymentRes = await request(app)
        .get("/api/swap")
        .query(q)
        .set("PAYMENT-SIGNATURE", encoded);

      // Should NOT be 429 — could be 402 (state not found) or another error
      expect(paymentRes.status).not.toBe(429);

      quoteLimiter.destroy();
    });
  });

  // ── Settlement limiting ───────────────────────────────────────────

  describe("settlement limiting (503)", () => {
    it("returns 503 when settlement capacity is exhausted", async () => {
      const settlementLimiter = new SettlementLimiter(1);
      // Exhaust the capacity
      settlementLimiter.acquire();

      const { app, store } = createTestApp({ settlementLimiter });

      // Create a QUOTED state so the payment gets to the settlement step
      const { mockSwapState } = await import("../mocks/index.js");
      await store.create(MOCK_DEPOSIT_ADDRESS, mockSwapState());

      // Sign a valid payload
      const { payload } = await signEIP3009Payload(buyerWallet);
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

      const res = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      // The request should be rejected with 503 since there's no settlement capacity.
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("SETTLEMENT_CAPACITY_EXCEEDED");

      settlementLimiter.release();
    });

    it("releases the slot after a successful settlement", async () => {
      const settlementLimiter = new SettlementLimiter(1);
      const { app, store } = createTestApp({ settlementLimiter });

      // Create a QUOTED state
      const { mockSwapState } = await import("../mocks/index.js");
      await store.create(MOCK_DEPOSIT_ADDRESS, mockSwapState());

      const { payload } = await signEIP3009Payload(buyerWallet);
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

      // This should succeed and release the slot
      const res = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(200);

      // The slot should have been released
      expect(settlementLimiter.current).toBe(0);
    });
  });
});
