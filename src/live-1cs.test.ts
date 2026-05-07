/**
 * Live 1CS API integration tests.
 *
 * These tests call the REAL 1Click Swap API — they are **skipped by default**
 * and only run when the `ONE_CLICK_JWT` environment variable is set.
 *
 * Usage:
 *   ONE_CLICK_JWT="<jwt>" npx vitest run src/live-1cs.test.ts
 *   ONE_CLICK_JWT="<jwt>" npm run test:live
 *
 * No funds are spent: quote requests use either `dry: true` or non-dry mode
 * that generates a deposit address but never receives a deposit. The gateway
 * middleware tests use real 1CS quotes but mock the on-chain broadcast layer.
 *
 * @module live-1cs
 */

import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ethers } from "ethers";

import { createX402Middleware } from "./http/middleware.js";
import type { MiddlewareDeps } from "./http/middleware.js";
import { InMemoryStateStore } from "./storage/store.js";
import type { GatewayConfig } from "./infra/config.js";
import {
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  mockChainReader,
  mockProtectedRoute,
  signEIP3009Payload,
  buyerWallet,
  MOCK_TX_HASH,
} from "./mocks/index.js";
import type { SwapRequestInput } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Skip guard — only run when JWT is available
// ═══════════════════════════════════════════════════════════════════════

const JWT = process.env.ONE_CLICK_JWT;
const BASE_URL = process.env.ONE_CLICK_BASE_URL ?? "https://1click.chaindefuser.com";

const describeIfLive = JWT ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════
// Constants — correct asset IDs for the live 1CS API
// ═══════════════════════════════════════════════════════════════════════

/**
 * IMPORTANT: The live 1CS API expects `nep141:` prefixed asset IDs.
 *
 * @see https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
 */
const LIVE_ORIGIN_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const LIVE_DESTINATION_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const LIVE_DESTINATION_ADDRESS = "test.near";
const LIVE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LIVE_NETWORK = "eip155:8453";
const LIVE_AMOUNT_IN = "1000000"; // 1 USDC

const SWAP_PATH = "/api/swap";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function liveSwapInputs(): SwapRequestInput {
  return {
    destinationChain: "near",
    destinationAsset: LIVE_DESTINATION_ASSET,
    destinationAddress: LIVE_DESTINATION_ADDRESS,
    amountIn: LIVE_AMOUNT_IN,
  };
}

function liveSwapQuery(): Record<string, string> {
  const i = liveSwapInputs();
  return {
    destinationChain: i.destinationChain,
    destinationAsset: i.destinationAsset,
    destinationAddress: i.destinationAddress,
    amountIn: i.amountIn,
  };
}

/** Build a GatewayConfig wired to the real 1CS API. */
function liveConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const facilitatorWallet = ethers.Wallet.createRandom();

  return {
    oneClickJwt: JWT!,
    oneClickBaseUrl: BASE_URL,
    originNetwork: LIVE_NETWORK,
    originAssetIn: LIVE_ORIGIN_ASSET,
    originTokenAddress: LIVE_USDC_ADDRESS,
    originRpcUrls: ["https://mainnet.base.org"],
    facilitatorPrivateKey: facilitatorWallet.privateKey,
    gatewayRefundAddress: facilitatorWallet.address,
    operatorMarginBps: 30,
    maxPollTimeMs: 300_000,
    pollIntervalBaseMs: 2_000,
    pollIntervalMaxMs: 30_000,
    quoteExpiryBufferSec: 30,
    rateLimitQuotesPerWindow: 100,
    rateLimitWindowMs: 60_000,
    maxConcurrentSettlements: 10,
    quoteGcIntervalMs: 0,
    quoteGcGracePeriodMs: 300_000,
    tokenName: "USD Coin",
    tokenVersion: "2",
    tokenSupportsEip3009: true,
    ownershipProofs: [],
    ...overrides,
  };
}

/** Build MiddlewareDeps using the real 1CS quoteFn but mocked settlement. */
function liveDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  const cfg = liveConfig();
  return {
    cfg,
    store: new InMemoryStateStore(),
    chainReader: mockChainReader(),
    broadcastFn: mockBroadcastFn(),
    depositNotifyFn: mockDepositNotifyFn(),
    statusPollFn: mockStatusPollFn(),
    route: mockProtectedRoute(),
    // NO quoteFn override — uses the real defaultQuoteFn (hits live 1CS API)
    ...overrides,
  };
}

function createLiveTestApp(deps: MiddlewareDeps): express.Express {
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
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describeIfLive("Live 1CS API Integration", () => {
  const LIVE_TIMEOUT = 30_000;

  beforeAll(() => {
    OpenAPI.BASE = BASE_URL;
    OpenAPI.TOKEN = JWT;
  });

  // ── 1. Authentication ────────────────────────────────────────────

  describe("Authentication", () => {
    it("accepts the JWT and returns a dry quote", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: true,
        swapType: QuoteRequest.swapType.EXACT_INPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: LIVE_AMOUNT_IN,
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: LIVE_DESTINATION_ADDRESS,
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      expect(resp).toBeDefined();
      expect(resp.correlationId).toBeTruthy();
      expect(resp.quote).toBeDefined();
      expect(resp.quote.amountIn).toBeTruthy();
      expect(resp.quote.amountOut).toBeTruthy();
    }, LIVE_TIMEOUT);
  });

  // ── 2. Dry quote structure validation ────────────────────────────

  describe("Dry quote response structure", () => {
    it("returns all expected fields for an EXACT_INPUT dry quote", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: true,
        swapType: QuoteRequest.swapType.EXACT_INPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: LIVE_AMOUNT_IN,
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: LIVE_DESTINATION_ADDRESS,
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      expect(typeof resp.correlationId).toBe("string");
      expect(typeof resp.timestamp).toBe("string");

      const amountIn = BigInt(resp.quote.amountIn);
      const amountOut = BigInt(resp.quote.amountOut);
      // EXACT_INPUT: amountIn echoes the buyer's request; amountOut is variable.
      expect(amountIn).toBe(BigInt(LIVE_AMOUNT_IN));
      expect(amountOut).toBeGreaterThan(0n);

      expect(resp.quote.amountInFormatted).toBeTruthy();
      expect(resp.quote.amountOutFormatted).toBeTruthy();
      expect(resp.quote.timeEstimate).toBeGreaterThan(0);
    }, LIVE_TIMEOUT);
  });

  // ── 3. Real (non-dry) quote ──────────────────────────────────────

  describe("Real quote (non-dry)", () => {
    it("returns a deposit address for a non-dry EXACT_INPUT quote", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: false,
        swapType: QuoteRequest.swapType.EXACT_INPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: LIVE_AMOUNT_IN,
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: LIVE_DESTINATION_ADDRESS,
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      expect(resp.quote.depositAddress).toBeTruthy();
      expect(resp.quote.depositAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

      expect(resp.quote.deadline).toBeTruthy();
      const quoteDeadline = new Date(resp.quote.deadline!).getTime();
      expect(quoteDeadline).toBeGreaterThan(Date.now());

      expect(resp.signature).toBeTruthy();
    }, LIVE_TIMEOUT);
  });

  // ── 4. Error handling ────────────────────────────────────────────

  describe("Error handling", () => {
    it("rejects an invalid origin asset with 400", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      try {
        await OneClickService.getQuote({
          dry: true,
          swapType: QuoteRequest.swapType.EXACT_INPUT,
          slippageTolerance: 50,
          originAsset: "nep141:nonexistent-token.near",
          depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
          destinationAsset: LIVE_DESTINATION_ASSET,
          amount: LIVE_AMOUNT_IN,
          refundTo: "0x0000000000000000000000000000000000000001",
          refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
          recipient: LIVE_DESTINATION_ADDRESS,
          recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
          deadline,
        });
        expect.unreachable("Expected 1CS to reject invalid asset");
      } catch (err: any) {
        expect(err.status).toBe(400);
      }
    }, LIVE_TIMEOUT);

    it("rejects an expired deadline", async () => {
      const deadline = new Date(Date.now() - 60_000).toISOString();
      try {
        await OneClickService.getQuote({
          dry: true,
          swapType: QuoteRequest.swapType.EXACT_INPUT,
          slippageTolerance: 50,
          originAsset: LIVE_ORIGIN_ASSET,
          depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
          destinationAsset: LIVE_DESTINATION_ASSET,
          amount: LIVE_AMOUNT_IN,
          refundTo: "0x0000000000000000000000000000000000000001",
          refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
          recipient: LIVE_DESTINATION_ADDRESS,
          recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
          deadline,
        });
        expect.unreachable("Expected 1CS to reject expired deadline");
      } catch (err: any) {
        expect(err.status).toBe(400);
      }
    }, LIVE_TIMEOUT);
  });

  // ── 5. Gateway 402 flow with real 1CS quote ──────────────────────

  describe("Gateway 402 flow with real 1CS quote", () => {
    it("returns a valid 402 response using a real 1CS quote", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);

      const res = await request(app).get(SWAP_PATH).query(liveSwapQuery());

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();

      const pr = decodePaymentRequiredHeader(res.headers["payment-required"]);
      expect(pr.x402Version).toBe(2);
      expect(pr.accepts).toHaveLength(1);

      const accepted = pr.accepts[0]!;
      expect(accepted.scheme).toBe("exact");
      expect(accepted.network).toBe(LIVE_NETWORK);
      expect(accepted.asset.toLowerCase()).toBe(LIVE_USDC_ADDRESS.toLowerCase());
      expect(accepted.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);

      // Amount is amountIn × (10000 + bps) / 10000 — at least the buyer's amountIn.
      expect(BigInt(accepted.amount)).toBeGreaterThanOrEqual(BigInt(LIVE_AMOUNT_IN));
      expect(accepted.maxTimeoutSeconds).toBeGreaterThan(0);
      expect(accepted.extra.name).toBe("USD Coin");
      expect(accepted.extra.assetTransferMethod).toBe("eip3009");

      // Resource URL preserves the buyer's query (Express's originalUrl).
      expect(pr.resource.url).toMatch(/^\/api\/swap\?/);

      // The cross-chain extra should carry the buyer's destination + operator fee
      const cross = (accepted.extra.crossChain as any);
      expect(cross.destinationRecipient).toBe(LIVE_DESTINATION_ADDRESS);
      expect(cross.destinationAsset).toBe(LIVE_DESTINATION_ASSET);
      expect(cross.operatorFee.bps).toBe(30);
    }, LIVE_TIMEOUT);
  });

  // ── 6. Full 402 → sign → 200 (real quote, mocked settlement) ──────

  describe("Full 402 → sign → settle flow (real quote, mocked broadcast)", () => {
    it("completes the full x402 flow using a real 1CS quote", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);
      const query = liveSwapQuery();

      // Step 1: GET without payment → 402 (real 1CS quote)
      const initialRes = await request(app).get(SWAP_PATH).query(query);
      expect(initialRes.status).toBe(402);

      // Step 2: Decode the real 1CS-backed 402 response
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;
      expect(accepted.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);

      // Step 3: Sign EIP-3009 against the real deposit address/amount
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
        requirements: {
          payTo: accepted.payTo,
          amount: accepted.amount,
          maxTimeoutSeconds: accepted.maxTimeoutSeconds,
        },
      });

      // Step 4: Retry with PAYMENT-SIGNATURE → settle (broadcast is mocked)
      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get(SWAP_PATH)
        .query(query)
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(200);
      // Body is `{}` by design (D14 — receipt is in the PAYMENT-RESPONSE header).
      expect(paymentRes.body).toEqual({});
      expect(paymentRes.headers["payment-response"]).toBeDefined();
    }, LIVE_TIMEOUT);
  });

  // ── 7. X402Client end-to-end against real 1CS quote ──────────────

  describe("X402Client end-to-end against real 1CS quote", () => {
    it("payAndFetch completes the full x402 flow via the client library", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);

      const server = await new Promise<import("http").Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as import("net").AddressInfo).port;

      try {
        const { X402Client } = await import("./client/index.js");
        const client = new X402Client({ gatewayUrl: `http://127.0.0.1:${port}` });

        const result = await client.payAndFetch(buyerWallet, SWAP_PATH, {
          query: liveSwapQuery(),
        });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.body).toEqual({});
        expect(result.paymentResponse).toBeDefined();
        expect(result.paymentResponse.success).toBe(true);
        expect(result.paymentResponse.transaction).toBe(MOCK_TX_HASH);

        expect(result.paymentRequired).toBeDefined();
        const accepted = result.paymentRequired.accepts[0]!;
        expect(accepted.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(accepted.network).toBe(LIVE_NETWORK);
        expect(accepted.asset.toLowerCase()).toBe(LIVE_USDC_ADDRESS.toLowerCase());
      } finally {
        server.close();
      }
    }, LIVE_TIMEOUT);
  });

  // ── 8. Quote engine error mapping ─────────────────────────────────

  describe("Quote engine 1CS error mapping", () => {
    it("maps 1CS 401 (bad JWT) to gateway 503", async () => {
      const deps = liveDeps({
        cfg: liveConfig({ oneClickJwt: "invalid-jwt-token" }),
      });
      const app = createLiveTestApp(deps);

      const res = await request(app).get(SWAP_PATH).query(liveSwapQuery());
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("AUTHENTICATION_ERROR");
    }, LIVE_TIMEOUT);

    it("maps 1CS 400 (bad asset) to gateway 503", async () => {
      const deps = liveDeps({
        cfg: liveConfig({ originAssetIn: "nep141:nonexistent.near" }),
      });
      const app = createLiveTestApp(deps);

      const res = await request(app).get(SWAP_PATH).query(liveSwapQuery());
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("QUOTE_UNAVAILABLE");
    }, LIVE_TIMEOUT);
  });
});
