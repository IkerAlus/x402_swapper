/**
 * End-to-end tests — full x402 HTTP protocol compliance.
 *
 * These tests simulate a real x402 client interacting with the gateway
 * over HTTP via supertest. Every test follows the complete protocol:
 *
 *   1. Client → GET /resource (no payment header)
 *   2. Gateway → 402 + PAYMENT-REQUIRED header (base64 JSON)
 *   3. Client decodes requirements, picks one from `accepts[]`, signs payment
 *   4. Client → GET /resource + PAYMENT-SIGNATURE header (base64 JSON)
 *   5. Gateway verifies → broadcasts → polls 1CS → settles
 *   6. Gateway → 200 + PAYMENT-RESPONSE header + resource body
 *
 * All external I/O (RPC, 1CS API) is mocked via injectable deps.
 * Cryptographic signatures are real (ethers.Wallet.signTypedData).
 *
 * @module e2e
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

import { createX402Middleware } from "./http/middleware.js";
import type { MiddlewareDeps } from "./http/middleware.js";
import { InMemoryStateStore } from "./storage/store.js";
import type { QuoteFn } from "./payment/quote-engine.js";
import type { QuoteResponse, PaymentPayloadRecord } from "./types.js";

import {
  mockFastPollConfig,
  mockChainReader,
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  mockQuoteResponse,
  mockPaymentRequirements,
  mockFailedStatusSequence,
  mockRefundedStatusSequence,
  signEIP3009Payload,
  signPermit2Payload,
  buyerWallet,
  BUYER_ADDRESS,
  MOCK_DEPOSIT_ADDRESS,
  MOCK_TX_HASH,
  mockSwapInputs,
  mockProtectedRoute,
} from "./mocks/index.js";
import type { SwapRequestInput } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Swap query helpers
// ═══════════════════════════════════════════════════════════════════════

const SWAP_PATH = "/api/swap";
const OTHER_PATH = "/api/other";

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

function getWithSwapQuery(app: express.Express, path: string): request.Test {
  return request(app).get(path).query(swapQuery());
}

// ═══════════════════════════════════════════════════════════════════════
// x402 client simulator
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simulates what a real x402 client does:
 * 1. Makes a request without payment
 * 2. Receives 402 + decodes PAYMENT-REQUIRED
 * 3. Picks a payment option from `accepts`
 * 4. Signs the payment
 * 5. Retries with PAYMENT-SIGNATURE
 */
async function x402ClientFlow(
  app: express.Express,
  path: string,
  signer: typeof buyerWallet,
  method: "eip3009" | "permit2" = "eip3009",
): Promise<{
  initialResponse: request.Response;
  paymentRequired: PaymentRequired;
  paymentResponse: request.Response;
}> {
  const query = swapQuery();

  // Step 1: Request without payment → 402
  const initialResponse = await request(app).get(path).query(query);
  expect(initialResponse.status).toBe(402);
  expect(initialResponse.headers["payment-required"]).toBeDefined();

  // Step 2: Decode the 402 response
  const paymentRequired = decodePaymentRequiredHeader(
    initialResponse.headers["payment-required"],
  );
  expect(paymentRequired.x402Version).toBe(2);
  expect(paymentRequired.accepts.length).toBeGreaterThan(0);

  // Step 3: Pick the first payment option
  const accepted = paymentRequired.accepts[0]!;

  // Step 4: Sign the payment
  let signedPayload: PaymentPayloadRecord;
  if (method === "eip3009") {
    const { payload } = await signEIP3009Payload(signer, {
      to: accepted.payTo,
      value: accepted.amount,
    });
    signedPayload = payload;
  } else {
    const { payload } = await signPermit2Payload(signer, {
      to: accepted.payTo,
      amount: accepted.amount,
    });
    signedPayload = payload;
  }

  // Step 5: Retry with payment (same query string preserves URL stability)
  const encoded = encodePaymentSignatureHeader(signedPayload as any);
  const paymentResponse = await request(app)
    .get(path)
    .query(query)
    .set("PAYMENT-SIGNATURE", encoded);

  return { initialResponse, paymentRequired, paymentResponse };
}

// ═══════════════════════════════════════════════════════════════════════
// Test setup
// ═══════════════════════════════════════════════════════════════════════

function createMockQuoteFn(): QuoteFn {
  return async () => mockQuoteResponse() as unknown as QuoteResponse;
}

function buildDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    cfg: mockFastPollConfig(),
    store: new InMemoryStateStore(),
    chainReader: mockChainReader(),
    broadcastFn: mockBroadcastFn(),
    depositNotifyFn: mockDepositNotifyFn(),
    statusPollFn: mockStatusPollFn(),
    quoteFn: createMockQuoteFn(),
    route: mockProtectedRoute(),
    ...overrides,
  };
}

function createTestApp(deps: MiddlewareDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.get(
    SWAP_PATH,
    createX402Middleware(deps),
    (_req, res) => {
      // Body is `{}` by design (D14 — receipt is in the PAYMENT-RESPONSE header).
      res.json({});
    },
  );
  // Second route to test path isolation. Uses a separate middleware instance
  // bound to its own ProtectedRoute (each route has its own input validator).
  app.get(
    OTHER_PATH,
    createX402Middleware({ ...deps, route: mockProtectedRoute({ path: OTHER_PATH }) }),
    (_req, res) => {
      res.json({});
    },
  );
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("E2E: Full x402 protocol compliance", () => {
  // ── Happy path: EIP-3009 ───────────────────────────────────────────

  describe("EIP-3009 happy path", () => {
    it("completes the full 402 → sign → 200 flow", async () => {
      const deps = buildDeps();
      const app = createTestApp(deps);

      const { paymentRequired, paymentResponse } = await x402ClientFlow(
        app, "/api/swap", buyerWallet, "eip3009",
      );

      // Verify 200 response
      expect(paymentResponse.status).toBe(200);
      expect(paymentResponse.body).toEqual({});

      // Verify PAYMENT-RESPONSE header
      expect(paymentResponse.headers["payment-response"]).toBeDefined();
      const settleResponse = decodePaymentResponseHeader(
        paymentResponse.headers["payment-response"],
      );
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.transaction).toBe(MOCK_TX_HASH);
      expect(settleResponse.network).toBe("eip155:8453");
      expect(settleResponse.payer?.toLowerCase()).toBe(BUYER_ADDRESS.toLowerCase());

      // Verify cross-chain metadata in extensions
      expect(settleResponse.extensions).toBeDefined();
      const crossChain = (settleResponse.extensions as any)?.crossChain;
      expect(crossChain?.settlementType).toBe("crosschain-1cs");
      expect(crossChain?.swapStatus).toBe("SUCCESS");
      expect(crossChain?.destinationTxHashes).toBeDefined();
      expect(crossChain?.correlationId).toBeTruthy();
    });

    it("includes correct PaymentRequired envelope in 402", async () => {
      const deps = buildDeps({ resourceDescription: "Premium API data" });
      const app = createTestApp(deps);

      const res = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(res.headers["payment-required"]);

      // Protocol envelope
      expect(pr.x402Version).toBe(2);
      expect(pr.error).toBeUndefined();

      // Resource info — Express's `originalUrl` includes the buyer's query string.
      expect(pr.resource.url).toMatch(/^\/api\/swap\?/);
      expect(pr.resource.description).toBe("Premium API data");

      // Accepts array — single entry for v1
      expect(pr.accepts).toHaveLength(1);
      const reqs = pr.accepts[0]!;
      expect(reqs.scheme).toBe("exact");
      expect(reqs.network).toBe("eip155:8453");
      expect(reqs.payTo).toBe(MOCK_DEPOSIT_ADDRESS);
      expect(BigInt(reqs.amount)).toBeGreaterThan(0n);
      expect(reqs.maxTimeoutSeconds).toBeGreaterThan(0);
      expect(reqs.extra.name).toBe("USD Coin");
      expect(reqs.extra.version).toBe("2");
      expect(reqs.extra.assetTransferMethod).toBe("eip3009");
    });
  });

  // ── Happy path: Permit2 ────────────────────────────────────────────

  describe("Permit2 happy path", () => {
    it("completes the full 402 → sign → 200 flow with Permit2", async () => {
      // Need to configure for Permit2
      const deps = buildDeps({
        cfg: mockFastPollConfig({ tokenSupportsEip3009: false }),
      });
      const app = createTestApp(deps);

      // First request gets 402 with permit2 method
      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      expect(initialRes.status).toBe(402);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      expect(pr.accepts[0]!.extra.assetTransferMethod).toBe("permit2");

      // Sign with Permit2
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signPermit2Payload(buyerWallet, {
        to: accepted.payTo,
        amount: accepted.amount,
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(200);
      expect(paymentRes.body).toEqual({});

      const settleResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(settleResponse.success).toBe(true);
    });
  });

  // ── Idempotent retry after settlement ──────────────────────────────

  describe("Idempotent retry", () => {
    it("returns cached 200 if client retries after settlement", async () => {
      const deps = buildDeps();
      const app = createTestApp(deps);

      // First flow: get 402, sign, settle → 200
      const { paymentResponse: firstResponse } = await x402ClientFlow(
        app, "/api/swap", buyerWallet,
      );
      expect(firstResponse.status).toBe(200);

      // Second attempt: same deposit address, already SETTLED
      // We need to re-encode the same payload
      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const retryRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      // Should return 200 with cached PAYMENT-RESPONSE
      expect(retryRes.status).toBe(200);
      expect(retryRes.headers["payment-response"]).toBeDefined();

      const cachedResponse = decodePaymentResponseHeader(
        retryRes.headers["payment-response"],
      );
      expect(cachedResponse.success).toBe(true);
      expect(cachedResponse.transaction).toBe(MOCK_TX_HASH);
    });
  });

  // ── 1CS swap failure: FAILED status ────────────────────────────────

  describe("1CS swap failure (FAILED)", () => {
    it("returns 502 with failure PAYMENT-RESPONSE when 1CS swap fails", async () => {
      const deps = buildDeps({
        statusPollFn: mockStatusPollFn({
          sequence: mockFailedStatusSequence(),
        }),
      });
      const app = createTestApp(deps);

      // Get 402
      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      expect(initialRes.status).toBe(402);

      // Decode and sign
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
      });

      // Send payment → should fail at polling stage
      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(502);
      expect(paymentRes.headers["payment-response"]).toBeDefined();

      const failResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(failResponse.success).toBe(false);
      expect(failResponse.errorReason).toBe("SWAP_FAILED");
    });
  });

  // ── 1CS swap failure: REFUNDED status ──────────────────────────────

  describe("1CS swap refund (REFUNDED)", () => {
    it("returns 502 with failure PAYMENT-RESPONSE when 1CS refunds", async () => {
      const deps = buildDeps({
        statusPollFn: mockStatusPollFn({
          sequence: mockRefundedStatusSequence(),
        }),
      });
      const app = createTestApp(deps);

      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(502);
      const failResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(failResponse.success).toBe(false);
      expect(failResponse.errorReason).toBe("SWAP_FAILED");
    });
  });

  // ── Broadcast failure ──────────────────────────────────────────────

  describe("Broadcast failure", () => {
    it("returns 502 when on-chain broadcast reverts", async () => {
      const deps = buildDeps({
        broadcastFn: mockBroadcastFn({
          eip3009Error: new Error("execution reverted: authorization is used"),
        }),
      });
      const app = createTestApp(deps);

      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(502);
      expect(paymentRes.headers["payment-response"]).toBeDefined();
    });
  });

  // ── Insufficient gas ──────────────────────────────────────────────

  describe("Insufficient facilitator gas", () => {
    it("returns 503 when facilitator wallet has no gas", async () => {
      const deps = buildDeps({
        broadcastFn: mockBroadcastFn({
          facilitatorBalance: 0n, // No gas
        }),
      });
      const app = createTestApp(deps);

      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(503);
      expect(paymentRes.body.error).toBe("INSUFFICIENT_GAS");
    });
  });

  // ── EIP-3009 nonce already used ────────────────────────────────────

  describe("Nonce already used (replay protection)", () => {
    it("returns 409 when EIP-3009 authorization nonce is already consumed", async () => {
      const deps = buildDeps({
        broadcastFn: mockBroadcastFn({
          nonceAlreadyUsed: true,
        }),
      });
      const app = createTestApp(deps);

      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(409);
      expect(paymentRes.body.error).toBe("NONCE_ALREADY_USED");
      // Client-facing message is sanitized — check that it mentions nonce
      // reuse generically without leaking the specific nonce bytes.
      expect(paymentRes.body.message.toLowerCase()).toContain("nonce");
      expect(paymentRes.body.message.toLowerCase()).toContain("already");
      expect(paymentRes.body.message).not.toMatch(/0x[0-9a-f]{64}/);
      expect(paymentRes.body.correlationId).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  // ── Verification failure: insufficient amount ──────────────────────

  describe("Verification failure: amount too low", () => {
    it("returns 402 when buyer signs for less than required amount", async () => {
      const deps = buildDeps();
      const app = createTestApp(deps);

      // Get 402
      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;

      // Sign for a tiny amount
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: "100", // Way below the required ~10.5 USDC
        requirements: { amount: "100" }, // Match the accepted.amount
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      // Should get 402 with error explaining the amount is too low
      expect(paymentRes.status).toBe(402);
      const pr2 = decodePaymentRequiredHeader(paymentRes.headers["payment-required"]);
      expect(pr2.error).toContain("Amount too low");
    });
  });

  // ── Verification failure: insufficient balance ─────────────────────

  describe("Verification failure: insufficient on-chain balance", () => {
    it("returns 402 when buyer has zero token balance", async () => {
      const deps = buildDeps({
        chainReader: mockChainReader({ tokenBalance: 0n }),
      });
      const app = createTestApp(deps);

      const initialRes = await getWithSwapQuery(app, SWAP_PATH);
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
      });

      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/swap")
        .set("PAYMENT-SIGNATURE", encoded);

      // Should get 402 — verification fails due to balance check
      expect(paymentRes.status).toBe(402);
      const pr2 = decodePaymentRequiredHeader(paymentRes.headers["payment-required"]);
      expect(pr2.error).toContain("Insufficient token balance");
    });
  });

  // ── State store transitions ────────────────────────────────────────

  describe("State store lifecycle", () => {
    it("progresses through all phases: QUOTED → VERIFIED → ... → SETTLED", async () => {
      const store = new InMemoryStateStore();
      const deps = buildDeps({ store });
      const app = createTestApp(deps);

      // After 402: QUOTED
      await getWithSwapQuery(app, SWAP_PATH);
      let state = await store.get(MOCK_DEPOSIT_ADDRESS);
      expect(state?.phase).toBe("QUOTED");

      // After payment: should end at SETTLED
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: MOCK_DEPOSIT_ADDRESS,
      });
      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      await getWithSwapQuery(app, SWAP_PATH).set("PAYMENT-SIGNATURE", encoded);

      state = await store.get(MOCK_DEPOSIT_ADDRESS);
      expect(state?.phase).toBe("SETTLED");
      expect(state?.originTxHash).toBe(MOCK_TX_HASH);
      expect(state?.signerAddress?.toLowerCase()).toBe(BUYER_ADDRESS.toLowerCase());
      expect(state?.oneClickStatus).toBe("SUCCESS");
      expect(state?.settledAt).toBeGreaterThan(0);
      expect(state?.settlementResponse?.success).toBe(true);
    });
  });

  // ── Non-fatal: 1CS deposit notification failure ────────────────────

  describe("Non-fatal 1CS notification", () => {
    it("still succeeds even if POST /deposit/submit fails", async () => {
      const deps = buildDeps({
        depositNotifyFn: mockDepositNotifyFn({
          error: new Error("1CS returned 500"),
        }),
      });
      const app = createTestApp(deps);

      const { paymentResponse } = await x402ClientFlow(
        app, "/api/swap", buyerWallet,
      );

      // Should still succeed — deposit notification is non-fatal
      expect(paymentResponse.status).toBe(200);
      const settleResponse = decodePaymentResponseHeader(
        paymentResponse.headers["payment-response"],
      );
      expect(settleResponse.success).toBe(true);
    });
  });

  // ── Multiple routes share the same middleware ──────────────────────

  describe("Route isolation", () => {
    it("different routes get independent 402 responses", async () => {
      const deps = buildDeps();
      const app = createTestApp(deps);

      const res1 = await getWithSwapQuery(app, SWAP_PATH);
      const res2 = await getWithSwapQuery(app, OTHER_PATH);

      expect(res1.status).toBe(402);
      expect(res2.status).toBe(402);

      const pr1 = decodePaymentRequiredHeader(res1.headers["payment-required"]);
      const pr2 = decodePaymentRequiredHeader(res2.headers["payment-required"]);

      // Both should include the correct resource URL (with the buyer's query).
      expect(pr1.resource.url).toMatch(/^\/api\/swap\?/);
      expect(pr2.resource.url).toMatch(/^\/api\/other\?/);
    });
  });
});
