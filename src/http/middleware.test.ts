/**
 * Tests for the x402 Middleware (Step 2.1).
 *
 * Uses supertest to drive an Express app with the x402 middleware,
 * and injectable dependency stubs to avoid real RPC/1CS calls.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { createX402Middleware } from "./middleware.js";
import type { MiddlewareDeps } from "./middleware.js";
import { InMemoryStateStore } from "../storage/store.js";
import type { StateStore, PaymentPayloadRecord, SwapState } from "../types.js";
import {
  mockGatewayConfig,
  mockFastPollConfig,
  mockChainReader,
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  MOCK_DEPOSIT_ADDRESS,
  mockQuoteResponse,
  MOCK_TX_HASH,
  buyerWallet,
  BUYER_ADDRESS,
  signEIP3009Payload,
  mockPaymentRequirements,
  mockSwapInputs,
  mockProtectedRoute,
  mockSwapState,
} from "../mocks/index.js";
import type { QuoteFn } from "../payment/quote-engine.js";
import type { QuoteResponse, SwapRequestInput } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

const SWAP_PATH = "/api/swap";

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

/** Send a GET to /api/swap with the buyer's destination query attached. */
function getSwap(app: express.Express, query: Record<string, string> = swapQuery()) {
  return request(app).get(SWAP_PATH).query(query);
}

/** Create a mock QuoteFn that returns a predictable quote. */
function createMockQuoteFn(): QuoteFn {
  return async (_req) => mockQuoteResponse() as unknown as QuoteResponse;
}

/** Build standard test deps. */
function buildDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  const store = new InMemoryStateStore();
  return {
    cfg: mockFastPollConfig(),
    store,
    chainReader: mockChainReader(),
    broadcastFn: mockBroadcastFn(),
    depositNotifyFn: mockDepositNotifyFn(),
    statusPollFn: mockStatusPollFn(),
    quoteFn: createMockQuoteFn(),
    route: mockProtectedRoute(),
    ...overrides,
  };
}

/** Create a test Express app with the x402 middleware. */
function createTestApp(deps: MiddlewareDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.get(SWAP_PATH, createX402Middleware(deps), (_req, res) => {
    res.json({});
  });
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("x402 Middleware", () => {
  let deps: MiddlewareDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = buildDeps();
    app = createTestApp(deps);
  });

  // ── 402 flow (no payment header) ───────────────────────────────────

  describe("No PAYMENT-SIGNATURE header", () => {
    it("returns 402 with PAYMENT-REQUIRED header", async () => {
      const res = await getSwap(app);

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();

      // Decode and verify the PaymentRequired envelope
      const paymentRequired = decodePaymentRequiredHeader(
        res.headers["payment-required"],
      );
      expect(paymentRequired.x402Version).toBe(2);
      expect(paymentRequired.accepts).toHaveLength(1);
      expect(paymentRequired.accepts[0].scheme).toBe("exact");
      expect(paymentRequired.accepts[0].payTo).toBe(MOCK_DEPOSIT_ADDRESS);
    });

    it("returns empty JSON body", async () => {
      const res = await getSwap(app);
      expect(res.body).toEqual({});
    });

    it("includes resource info in PaymentRequired", async () => {
      const depsWithDesc = buildDeps({ resourceDescription: "Premium API access" });
      const appWithDesc = createTestApp(depsWithDesc);

      const res = await getSwap(appWithDesc);
      const paymentRequired = decodePaymentRequiredHeader(
        res.headers["payment-required"],
      );
      // Express's `originalUrl` includes the buyer's query string (it's the
      // raw request line). The resource URL on the 402 envelope reflects that.
      expect(paymentRequired.resource.url).toMatch(/^\/api\/swap\?/);
      expect(paymentRequired.resource.description).toBe("Premium API access");
    });
  });

  // ── Invalid payment header ─────────────────────────────────────────

  describe("Invalid PAYMENT-SIGNATURE header", () => {
    it("returns 400 for malformed base64", async () => {
      const res = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", "not-valid-base64!!!");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid PAYMENT-SIGNATURE");
    });

    it("returns 400 for missing accepted.payTo", async () => {
      // Encode a payload without accepted.payTo
      const badPayload = { x402Version: 2, accepted: {}, payload: {} };
      const encoded = encodePaymentSignatureHeader(badPayload as any);

      const res = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("missing accepted.payTo");
    });
  });

  // ── State not found (stale deposit address) ────────────────────────

  describe("Payment with unknown deposit address", () => {
    it("returns fresh 402 when state not found", async () => {
      // Encode a payload referencing a deposit address not in the store
      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: {
          ...mockPaymentRequirements(),
          payTo: "0xunknown0000000000000000000000000000dead",
        },
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      // Re-quote on the retry needs the buyer's query (the middleware
      // re-parses inputs to build the fresh 402).
      const res = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();
    });
  });

  // ── Expired quote ──────────────────────────────────────────────────

  describe("Payment with expired quote", () => {
    it("deletes stale state and returns fresh 402", async () => {
      // Seed the store with an expired state
      const now = Date.now();
      const baseState = mockSwapState();
      const expiredState: SwapState = {
        ...baseState,
        quoteResponse: {
          ...baseState.quoteResponse,
          quote: {
            ...baseState.quoteResponse.quote,
            deadline: new Date(now - 60_000).toISOString(), // expired 1 min ago
          },
        },
        createdAt: now - 120_000,
        updatedAt: now - 120_000,
      };
      await deps.store.create(MOCK_DEPOSIT_ADDRESS, expiredState);

      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(402);

      // State should be deleted
      const stateAfter = await deps.store.get(MOCK_DEPOSIT_ADDRESS);
      // The old state is deleted, but a new one is created by the fresh quote
      expect(stateAfter?.phase).toBe("QUOTED");
    });
  });

  // ── Already settled (idempotent retry) ─────────────────────────────

  describe("Payment for already-settled swap", () => {
    it("returns 200 with cached PAYMENT-RESPONSE", async () => {
      // Seed a SETTLED state
      const now = Date.now();
      const settledState: SwapState = mockSwapState({
        phase: "SETTLED",
        signerAddress: BUYER_ADDRESS,
        originTxHash: MOCK_TX_HASH,
        settledAt: now,
        settlementResponse: {
          success: true,
          payer: BUYER_ADDRESS,
          transaction: MOCK_TX_HASH,
          network: "eip155:8453",
          extra: {
            settlementType: "crosschain-1cs",
            swapStatus: "SUCCESS",
            correlationId: "test-correlation-id",
          },
        },
      });
      await deps.store.create(MOCK_DEPOSIT_ADDRESS, settledState);

      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(200);
      expect(res.headers["payment-response"]).toBeDefined();
      // Body is `{}` by design (D14 — receipt is in the PAYMENT-RESPONSE header).
      expect(res.body).toEqual({});

      const paymentResponse = decodePaymentResponseHeader(
        res.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.transaction).toBe(MOCK_TX_HASH);
    });
  });

  // ── Swap in progress (duplicate request) ───────────────────────────

  describe("Payment for in-progress swap", () => {
    it("returns 409 when swap is already being settled", async () => {
      const inProgressState = mockSwapState({ phase: "BROADCASTING" });
      await deps.store.create(MOCK_DEPOSIT_ADDRESS, inProgressState);

      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already in progress");
    });
  });

  // ── Full happy path: quote → verify → settle → 200 ────────────────

  describe("Full settlement flow", () => {
    it("completes EIP-3009 payment and returns 200 with PAYMENT-RESPONSE", async () => {
      // Step 1: First request → 402 (creates QUOTED state)
      const initialRes = await getSwap(app);
      expect(initialRes.status).toBe(402);

      // Step 2: Decode the payment requirements from the 402
      const paymentRequired = decodePaymentRequiredHeader(
        initialRes.headers["payment-required"],
      );
      const requirements = paymentRequired.accepts[0];
      expect(requirements).toBeDefined();

      // Step 3: Sign an EIP-3009 payload (real EIP-712 signature)
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: requirements.payTo,
        value: requirements.amount,
      });

      // Step 4: Send the signed payment
      const encoded = encodePaymentSignatureHeader(signedPayload as any);

      const paymentRes = await request(app)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(200);
      // Body is `{}` by design (D14 — receipt is in the PAYMENT-RESPONSE header).
      expect(paymentRes.body).toEqual({});
      expect(paymentRes.headers["payment-response"]).toBeDefined();

      const paymentResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.transaction).toBeTruthy();
    });
  });

  // ── Settlement failure ─────────────────────────────────────────────

  describe("Settlement failure handling", () => {
    it("returns 502 with PAYMENT-RESPONSE on broadcast failure", async () => {
      // Create deps with a failing broadcaster
      const failDeps = buildDeps({
        broadcastFn: mockBroadcastFn({
          eip3009Error: new Error("RPC timeout"),
        }),
      });
      const failApp = createTestApp(failDeps);

      // Step 1: Get 402
      const initialRes = await getSwap(failApp);
      expect(initialRes.status).toBe(402);

      // Step 2: Decode requirements and sign
      const paymentRequired = decodePaymentRequiredHeader(
        initialRes.headers["payment-required"],
      );
      const requirements = paymentRequired.accepts[0];
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: requirements.payTo,
        value: requirements.amount,
      });

      // Step 3: Send the signed payment (should fail during broadcast)
      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(failApp)
        .get("/api/swap")
        .query(swapQuery())
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(502);
      expect(paymentRes.headers["payment-response"]).toBeDefined();

      const paymentResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(false);
    });
  });

  // ── Quote engine failure ───────────────────────────────────────────

  describe("Quote engine failure", () => {
    it("returns 503 when 1CS is unavailable", async () => {
      const failQuoteFn: QuoteFn = async () => {
        throw new Error("1CS unreachable");
      };
      const failDeps = buildDeps({ quoteFn: failQuoteFn });
      const failApp = createTestApp(failDeps);

      const res = await getSwap(failApp);
      expect(res.status).toBe(503);
    });
  });

  // ── Error sanitization (H2) ────────────────────────────────────────

  describe("Error response sanitization", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Silence + capture server-side error logs so they don't pollute
      // test output and so we can assert on what's logged.
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it("replaces raw 1CS error bodies with a generic client message (503)", async () => {
      // quoteFn throws a plain Error — this gets wrapped by the quote engine
      // into a ServiceUnavailableError whose .message includes the raw text.
      const failQuoteFn: QuoteFn = async () => {
        throw new Error("Internal 1CS trace: /srv/oneclick/route/v0/quote.ts:172 — RPC https://secret-internal.1cs:8080 returned 'JWT xyz expired'");
      };
      const failApp = createTestApp(buildDeps({ quoteFn: failQuoteFn }));

      const res = await getSwap(failApp);

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("SERVICE_UNAVAILABLE");
      // Client message must not leak any internals
      expect(res.body.message).not.toContain("1CS");
      expect(res.body.message).not.toContain("secret-internal");
      expect(res.body.message).not.toContain("/srv/");
      expect(res.body.message).not.toContain("JWT");
      expect(res.body.message).toMatch(/try again|unavailable/i);
      // Correlation ID present and well-formed
      expect(res.body.correlationId).toMatch(/^[0-9a-f]{8}$/);
      // Server-side log carries the full detail
      const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("secret-internal");
      expect(logged).toContain("JWT xyz expired");
      expect(logged).toContain(res.body.correlationId);
    });

    it("does not leak facilitator wallet balance in InsufficientGasError (503)", async () => {
      // broadcastFn throws InsufficientGasError directly; message leaks wei amounts.
      const { InsufficientGasError } = await import("../types.js");
      const leakyBroadcast = mockBroadcastFn({
        eip3009Error: new InsufficientGasError(
          "Facilitator gas balance too low: 123456789012345 wei, need at least 900000000000000 wei",
        ),
      });
      const failApp = createTestApp(buildDeps({ broadcastFn: leakyBroadcast }));

      // Get 402, sign, send
      const initial = await getSwap(failApp);
      const requirements = decodePaymentRequiredHeader(
        initial.headers["payment-required"],
      ).accepts[0];
      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: requirements.payTo,
        value: requirements.amount,
      });
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(failApp)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("INSUFFICIENT_GAS");
      // Client must not see wei balances
      expect(res.body.message).not.toMatch(/\d{10,}/);
      expect(res.body.message).not.toContain("wei");
      expect(res.body.message).not.toContain("Facilitator");
      expect(res.body.correlationId).toMatch(/^[0-9a-f]{8}$/);
      // Server log still has the full numbers
      const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("123456789012345");
      expect(logged).toContain("Facilitator gas balance too low");
    });

    it("returns generic 500 for non-GatewayError with no raw message leak", async () => {
      // Cause an unknown error by making the store.get throw a non-GatewayError.
      // We piggyback on the store dep — wrap store.get with a thrower.
      const leakyStore = {
        ...deps.store,
        async get(_addr: string) {
          throw new Error(
            "ENOENT: /etc/gateway/secrets/db.key — connection to postgres://admin:hunter2@10.0.0.5:5432/gateway refused",
          );
        },
      };
      const failApp = createTestApp(buildDeps({ store: leakyStore as any }));

      // First get 402 via the real store, then swap in leakyStore for the signed request.
      // Simpler: bypass the 402 by sending an arbitrary PAYMENT-SIGNATURE so store.get runs.
      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: { ...mockPaymentRequirements(), payTo: MOCK_DEPOSIT_ADDRESS },
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(failApp)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
      // Must not leak any secrets / internal paths / credentials
      expect(res.body.message).not.toContain("ENOENT");
      expect(res.body.message).not.toContain("/etc/");
      expect(res.body.message).not.toContain("postgres://");
      expect(res.body.message).not.toContain("hunter2");
      expect(res.body.message).not.toContain("10.0.0.5");
      expect(res.body.message).toMatch(/unexpected/i);
      expect(res.body.correlationId).toMatch(/^[0-9a-f]{8}$/);
      // But the server log captured everything
      const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("ENOENT");
      expect(logged).toContain("postgres://admin:hunter2");
    });

    it("sanitizes 502 PAYMENT-RESPONSE header too (settlement failure)", async () => {
      const leakyBroadcast = mockBroadcastFn({
        eip3009Error: new Error(
          "RPC https://mainnet.internal-rpc.example.com/key-abc123 timed out",
        ),
      });
      const failApp = createTestApp(buildDeps({ broadcastFn: leakyBroadcast }));

      const initial = await getSwap(failApp);
      const requirements = decodePaymentRequiredHeader(
        initial.headers["payment-required"],
      ).accepts[0];
      const { payload } = await signEIP3009Payload(buyerWallet, {
        to: requirements.payTo,
        value: requirements.amount,
      });
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(failApp)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(502);
      expect(res.headers["payment-response"]).toBeDefined();
      // JSON body sanitized
      expect(res.body.message).not.toContain("mainnet.internal-rpc");
      expect(res.body.message).not.toContain("key-abc123");
      expect(res.body.correlationId).toMatch(/^[0-9a-f]{8}$/);

      // PAYMENT-RESPONSE header's errorMessage is also sanitized
      const paymentResponse = decodePaymentResponseHeader(
        res.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(false);
      expect(paymentResponse.errorReason).toBe("BROADCAST_FAILED");
      expect(paymentResponse.errorMessage ?? "").not.toContain(
        "internal-rpc",
      );
      expect(paymentResponse.errorMessage ?? "").not.toContain("key-abc123");

      // Server log has the full RPC URL
      const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("mainnet.internal-rpc.example.com");
      expect(logged).toContain("key-abc123");
    });

    it("each error response has a distinct correlation ID", async () => {
      const failQuoteFn: QuoteFn = async () => {
        throw new Error("boom");
      };
      const failApp = createTestApp(buildDeps({ quoteFn: failQuoteFn }));

      const r1 = await getSwap(failApp);
      const r2 = await getSwap(failApp);
      expect(r1.body.correlationId).toMatch(/^[0-9a-f]{8}$/);
      expect(r2.body.correlationId).toMatch(/^[0-9a-f]{8}$/);
      expect(r1.body.correlationId).not.toBe(r2.body.correlationId);
    });

    it("logs err.context as a second stderr line when GatewayError carries context", async () => {
      // Throw a QuoteUnavailableError with a context bag (the shape the quote
      // engine produces on 1CS 400). The middleware must echo it into the log.
      const { QuoteUnavailableError } = await import("../types.js");
      const failQuoteFn: QuoteFn = async () => {
        throw new QuoteUnavailableError(
          "1CS quote rejected (400): Internal server error",
          {
            originAsset: "nep141:base-0x833589f...omft.near",
            destinationAsset: "nep141:usdt.tether-token.near",
            recipient: "merchantx402.nea",
            amount: "10000",
            refundTo: "0x1234567890abcdef1234567890abcdef12345678",
            upstreamStatus: 400,
            hints: [
              "recipient \"merchantx402.nea\" does not appear to be a valid NEAR account",
            ],
          },
        );
      };
      const failApp = createTestApp(buildDeps({ quoteFn: failQuoteFn }));

      const res = await getSwap(failApp);

      // Client response still sanitized (H2 invariant).
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("QUOTE_UNAVAILABLE");
      expect(res.body.message).not.toContain("merchantx402.nea");
      expect(res.body.message).not.toContain("Internal server error");
      expect(res.body).not.toHaveProperty("context");
      expect(res.body).not.toHaveProperty("hints");

      // Server log contains the context block.
      const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("context:");
      expect(logged).toContain("merchantx402.nea");
      expect(logged).toContain("valid NEAR account");
      expect(logged).toContain("\"upstreamStatus\": 400");
      expect(logged).toContain(res.body.correlationId);
    });

    it("omits the context line when GatewayError has no context", async () => {
      const { QuoteUnavailableError } = await import("../types.js");
      const failQuoteFn: QuoteFn = async () => {
        throw new QuoteUnavailableError("plain error, no context");
      };
      const failApp = createTestApp(buildDeps({ quoteFn: failQuoteFn }));

      const res = await getSwap(failApp);

      expect(res.status).toBe(503);
      const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("plain error, no context");
      expect(logged).not.toContain("context:"); // no context header emitted
    });
  });
});
