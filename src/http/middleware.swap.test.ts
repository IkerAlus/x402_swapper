/**
 * Swap-mode middleware tests — input validation surfacing and route-aware
 * behaviors specific to /api/swap.
 *
 * Out of scope (covered elsewhere, don't duplicate):
 *  - Zod field-level validation behavior — see swap-input.test.ts
 *  - Chain-format mismatch detection — see quote-engine.test.ts (validateBuyerDestination)
 *  - The generic 402 → sign → settle pipeline — see middleware.test.ts
 *
 * Here we assert only what the swap *middleware* layer adds: the
 * Zod/InvalidInputError → 400 envelope mapping, query-string round-trip
 * through Express, and req.swapState attachment for the route handler.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createX402Middleware } from "./middleware.js";
import type { MiddlewareDeps } from "./middleware.js";
import { InMemoryStateStore } from "../storage/store.js";
import {
  mockFastPollConfig,
  mockChainReader,
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  mockQuoteResponse,
  mockProtectedRoute,
  mockSwapInputs,
  mockSwapState,
  signEIP3009Payload,
  buyerWallet,
  MOCK_DEPOSIT_ADDRESS,
} from "../mocks/index.js";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { QuoteFn } from "../payment/quote-engine.js";
import type { QuoteResponse, SwapRequestInput } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

const SWAP_PATH = "/api/swap";

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

function buildDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    cfg: mockFastPollConfig(),
    store: new InMemoryStateStore(),
    chainReader: mockChainReader(),
    broadcastFn: mockBroadcastFn(),
    depositNotifyFn: mockDepositNotifyFn(),
    statusPollFn: mockStatusPollFn(),
    quoteFn: (async () => mockQuoteResponse() as unknown as QuoteResponse) as QuoteFn,
    route: mockProtectedRoute(),
    ...overrides,
  };
}

function makeApp(deps: MiddlewareDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.get(SWAP_PATH, createX402Middleware(deps), (req, res) => {
    res.json({ swapStateAttached: Boolean((req as express.Request & { swapState?: unknown }).swapState) });
  });
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// 400 envelope — what the middleware adds on top of the Zod validator
// ═══════════════════════════════════════════════════════════════════════

describe("middleware swap-mode — 400 INVALID_INPUT envelope", () => {
  let app: express.Express;
  beforeEach(() => { app = makeApp(buildDeps()); });

  it("propagates Zod failure as 400 INVALID_INPUT with field-level details + correlationId", async () => {
    const res = await request(app).get(SWAP_PATH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
    expect(typeof res.body.correlationId).toBe("string");
    const paths = (res.body.details as Array<{ path: string }>).map((d) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "destinationChain",
        "destinationAsset",
        "destinationAddress",
        "amountIn",
      ]),
    );
  });

  it("returns 402 (not 400) on a fully valid query — happy path", async () => {
    const res = await request(app).get(SWAP_PATH).query(swapQuery());
    expect(res.status).toBe(402);
    expect(res.headers["payment-required"]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateBuyerDestination → InvalidInputError → 400 surfacing
// (One end-to-end test that the quote-engine's InvalidInputError reaches
// the buyer as a 400 with the structured `reasons` from the error context.
// validateBuyerDestination's own correctness across chains is covered in
// quote-engine.test.ts.)
// ═══════════════════════════════════════════════════════════════════════

describe("middleware swap-mode — InvalidInputError surfacing", () => {
  it("surfaces validateBuyerDestination's chain-format mismatch as 400 with structured `reasons` in details", async () => {
    const app = makeApp(buildDeps());
    const res = await request(app)
      .get(SWAP_PATH)
      .query({
        destinationChain: "arbitrum",
        destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        destinationAddress: "alice.near",
        amountIn: "10000000",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
    expect((res.body.details as string[]).join(" ")).toMatch(/EVM|arbitrum/i);
  });

  it("does NOT reject unknown chain prefixes — request proceeds to 1CS (1CS may know chains we don't)", async () => {
    const app = makeApp(buildDeps());
    const res = await request(app)
      .get(SWAP_PATH)
      .query({
        destinationChain: "futurechain",
        destinationAsset: "nep141:futurechain-0xabc.omft.near",
        destinationAddress: "alice.near",
        amountIn: "10000000",
      });
    expect(res.status).toBe(402);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Express round-trip — query-string carriage of NEP-141 asset IDs
// ═══════════════════════════════════════════════════════════════════════

describe("middleware swap-mode — query-string carriage", () => {
  it("URL-decodes a long OMFT-bridged asset ID (containing `:` and `.`) round-trip", async () => {
    const app = makeApp(buildDeps());
    const longAsset = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    const res = await request(app)
      .get(SWAP_PATH)
      .query({
        destinationChain: "base",
        destinationAsset: longAsset,
        destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
        amountIn: "10000000",
      });
    expect(res.status).toBe(402);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// req.swapState attachment — the handler's contract
// ═══════════════════════════════════════════════════════════════════════

describe("middleware swap-mode — req.swapState attachment", () => {
  it("attaches the SETTLED state to req.swapState on cached 200 (already-settled retry)", async () => {
    const deps = buildDeps();
    const app = makeApp(deps);

    const settledState = mockSwapState({
      phase: "SETTLED",
      signerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      originTxHash: "0xabc",
      settledAt: Date.now(),
      settlementResponse: {
        success: true,
        transaction: "0xabc",
        network: "eip155:8453",
        extra: { settlementType: "crosschain-1cs", swapStatus: "SUCCESS" },
      },
    });
    await deps.store.create(MOCK_DEPOSIT_ADDRESS, settledState);

    const { payload } = await signEIP3009Payload(buyerWallet);
    const encoded = encodePaymentSignatureHeader(payload as any);

    const res = await request(app)
      .get(SWAP_PATH)
      .query(swapQuery())
      .set("PAYMENT-SIGNATURE", encoded);

    expect(res.status).toBe(200);
    expect(res.body.swapStateAttached).toBe(true);
  });
});
