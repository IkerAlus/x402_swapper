import { describe, it, expect } from "vitest";
import {
  buildPaymentRequirements,
  configureOneClickSdk,
  buildSwapQuoteRequest,
  buildQuoteDeadline,
  applyOperatorMargin,
  validateBuyerDestination,
  mapToPaymentRequirements,
  computeMaxTimeoutSeconds,
  validateDeadline,
  toQuoteResponseRecord,
  diagnoseQuoteRequest,
} from "./quote-engine.js";
import type { QuoteFn } from "./quote-engine.js";
import {
  QuoteUnavailableError,
  AuthenticationError,
  ServiceUnavailableError,
  DeadlineTooShortError,
  InvalidInputError,
  OneClickApiError,
  OpenAPI,
} from "../types.js";
import type { QuoteResponse, SwapRequestInput, SwapState, StateStore } from "../types.js";
import type { GatewayConfig } from "../infra/config.js";
import { mockGatewayConfig, DESTINATION_PRESETS } from "../mocks/index.js";

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return mockGatewayConfig(overrides);
}

function testInputs(overrides: Partial<SwapRequestInput> = {}): SwapRequestInput {
  return {
    ...DESTINATION_PRESETS.near,
    amountIn: "10000000",
    ...overrides,
  };
}

function mockQuoteResponse(overrides?: Partial<QuoteResponse["quote"]>): QuoteResponse {
  const deadline = new Date(Date.now() + 600_000).toISOString();
  return {
    correlationId: "corr-123",
    timestamp: new Date().toISOString(),
    signature: "mock-signature",
    quoteRequest: {
      dry: false,
      swapType: "EXACT_INPUT" as const,
      amount: "10000000",
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: DESTINATION_PRESETS.near.destinationAsset,
      recipient: DESTINATION_PRESETS.near.destinationAddress,
      refundTo: "0x1234567890abcdef1234567890abcdef12345678",
      slippageTolerance: 50,
      depositType: "ORIGIN_CHAIN" as const,
      refundType: "ORIGIN_CHAIN" as const,
      recipientType: "DESTINATION_CHAIN" as const,
      deadline,
    },
    quote: {
      depositAddress: "0xDEADBEEF1234567890abcdef1234567890abcdef",
      amountIn: "10000000",
      amountInFormatted: "10.00",
      amountInUsd: "10.00",
      minAmountIn: "10000000",
      amountOut: "9985000",
      amountOutFormatted: "9.985",
      amountOutUsd: "9.99",
      minAmountOut: "9950000",
      deadline,
      timeWhenInactive: new Date(Date.now() + 500_000).toISOString(),
      timeEstimate: 30,
      ...overrides,
    },
  };
}

function mockQuoteFn(response: QuoteResponse): QuoteFn {
  return async () => response;
}

function capturingQuoteFn(response: QuoteResponse) {
  let captured: Parameters<QuoteFn>[0] | undefined;
  const fn: QuoteFn = async (req) => {
    captured = req;
    return response;
  };
  return { fn, getCaptured: () => captured };
}

function failingQuoteFn(status: number, body?: unknown): QuoteFn {
  return async () => {
    throw new OneClickApiError(
      { method: "POST", url: "/v0/quote" },
      { url: "/v0/quote", ok: false, status, statusText: `Error ${status}`, body: body ?? {} },
      `Request failed with status ${status}`,
    );
  };
}

function makeMockStore(): StateStore {
  const states = new Map<string, SwapState>();
  return {
    create: async (addr, state) => {
      states.set(addr, state);
    },
    get: async (addr) => states.get(addr) ?? null,
    update: async (addr, patch) => {
      const current = states.get(addr);
      if (current) states.set(addr, { ...current, ...patch });
    },
    listExpired: async () => [],
    listByPhase: async () => [],
    delete: async (addr) => {
      states.delete(addr);
    },
    close: async () => {},
  };
}

// ═══════════════════════════════════════════════════════════════════════
// configureOneClickSdk + buildQuoteDeadline (tiny SDK glue)
// ═══════════════════════════════════════════════════════════════════════

describe("configureOneClickSdk", () => {
  it("sets OpenAPI.BASE and OpenAPI.TOKEN from cfg", () => {
    configureOneClickSdk(testConfig({
      oneClickJwt: "fresh-jwt",
      oneClickBaseUrl: "https://custom.1click.example.com",
    }));
    expect(OpenAPI.BASE).toBe("https://custom.1click.example.com");
    expect(OpenAPI.TOKEN).toBe("fresh-jwt");
  });
});

describe("buildQuoteDeadline", () => {
  it("returns ISO string at maxPollTimeMs + 120s in the future", () => {
    const before = Date.now();
    const result = buildQuoteDeadline(testConfig({ maxPollTimeMs: 300_000 }));
    const deadlineMs = new Date(result).getTime();
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 300_000 + 120_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildSwapQuoteRequest — assert the full shape we send to 1CS
// ═══════════════════════════════════════════════════════════════════════

describe("buildSwapQuoteRequest", () => {
  it("threads cfg + buyer inputs into the full 1CS request shape", () => {
    const cfg = testConfig({ originAssetIn: "nep141:base-0xorigin.omft.near" });
    const inputs = testInputs({
      destinationAsset: "nep141:arb-0xaf88.omft.near",
      destinationAddress: "0xabcd1234abcd1234abcd1234abcd1234abcd1234",
      amountIn: "5000000",
    });
    const req = buildSwapQuoteRequest(cfg, inputs, "2026-01-01T00:00:00Z");

    expect(req).toMatchObject({
      swapType: "EXACT_INPUT",
      originAsset: cfg.originAssetIn,
      destinationAsset: inputs.destinationAsset,
      recipient: inputs.destinationAddress,
      amount: inputs.amountIn,
      recipientType: "DESTINATION_CHAIN",
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      deadline: "2026-01-01T00:00:00Z",
    });
  });

  it("uses buyer's refundAddress when supplied; falls back to cfg.gatewayRefundAddress otherwise", () => {
    const cfg = testConfig({ gatewayRefundAddress: "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed" });

    expect(
      buildSwapQuoteRequest(cfg, testInputs({ refundAddress: "0xbeef".padEnd(42, "0") }), "2026-01-01T00:00:00Z").refundTo,
    ).toBe("0xbeef".padEnd(42, "0"));

    expect(
      buildSwapQuoteRequest(cfg, testInputs(), "2026-01-01T00:00:00Z").refundTo,
    ).toBe(cfg.gatewayRefundAddress);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// applyOperatorMargin — BigInt math + bounds
// ═══════════════════════════════════════════════════════════════════════

describe("applyOperatorMargin", () => {
  it("computes 30 bps margin (0.3%) precisely on a stablecoin amount", () => {
    const result = applyOperatorMargin("10000000", 30);
    expect(result.amountWithMargin).toBe("10030000");
    expect(result.marginAmount).toBe("30000");
  });

  it("returns the original amount when bps=0 (free deployment)", () => {
    expect(applyOperatorMargin("10000000", 0)).toEqual({
      amountWithMargin: "10000000",
      marginAmount: "0",
    });
  });

  it("preserves precision on amounts that exceed Number.MAX_SAFE_INTEGER", () => {
    // 10^18 (1 ETH in wei) — guards against accidental Number coercion.
    const result = applyOperatorMargin("1000000000000000000", 30);
    expect(result.amountWithMargin).toBe("1003000000000000000");
  });

  it("throws on out-of-range bps (negative, >1000, or non-integer)", () => {
    expect(() => applyOperatorMargin("10000000", -1)).toThrow(/out of range/);
    expect(() => applyOperatorMargin("10000000", 1001)).toThrow(/out of range/);
    expect(() => applyOperatorMargin("10000000", 30.5)).toThrow(/out of range/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateBuyerDestination — pre-quote chain-format hard-fail
// ═══════════════════════════════════════════════════════════════════════

describe("validateBuyerDestination", () => {
  it("accepts every preset in DESTINATION_PRESETS", () => {
    for (const preset of Object.values(DESTINATION_PRESETS)) {
      expect(() => validateBuyerDestination(testInputs(preset))).not.toThrow();
    }
  });

  it.each([
    ["NEAR address on an EVM chain", { ...DESTINATION_PRESETS.arbitrum, destinationAddress: "alice.near" }],
    ["EVM address on a NEAR-native asset", { ...DESTINATION_PRESETS.near, destinationAddress: "0x1234567890abcdef1234567890abcdef12345678" }],
    ["EVM address on a non-EVM (Stellar) chain", { ...DESTINATION_PRESETS.stellar, destinationAddress: "0x1234567890abcdef1234567890abcdef12345678" }],
  ])("rejects %s with InvalidInputError + structured reasons", (_label, inputs) => {
    try {
      validateBuyerDestination(testInputs(inputs));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidInputError);
      const reasons = (err as InvalidInputError).context?.reasons;
      expect(Array.isArray(reasons) && (reasons as string[]).length > 0).toBe(true);
    }
  });

  it("passes through unknown chain prefixes (1CS may know chains we don't)", () => {
    expect(() =>
      validateBuyerDestination(testInputs({
        destinationChain: "futurechain",
        destinationAsset: "nep141:futurechain-0xabc.omft.near",
        destinationAddress: "alice.near",
      })),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateDeadline
// ═══════════════════════════════════════════════════════════════════════

describe("validateDeadline", () => {
  it("rejects deadlines closer than the buffer; accepts otherwise; passes when no deadline", () => {
    const cfg = testConfig({ quoteExpiryBufferSec: 60 });
    expect(() =>
      validateDeadline(mockQuoteResponse({ deadline: new Date(Date.now() + 30_000).toISOString() }), cfg),
    ).toThrow(DeadlineTooShortError);
    expect(() =>
      validateDeadline(mockQuoteResponse({ deadline: new Date(Date.now() + 600_000).toISOString() }), cfg),
    ).not.toThrow();

    const noDeadline = mockQuoteResponse();
    delete noDeadline.quote.deadline;
    expect(() => validateDeadline(noDeadline, cfg)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// mapToPaymentRequirements
// ═══════════════════════════════════════════════════════════════════════

describe("mapToPaymentRequirements", () => {
  it("uses amountWithMargin as x402 amount and the deposit address as payTo", () => {
    // The two foot-guns: forgetting the margin (operator earns nothing) or
    // forgetting payTo = deposit address (the trick that makes the gateway work).
    const cfg = testConfig({ operatorMarginBps: 30 });
    const response = mockQuoteResponse();
    const margin = applyOperatorMargin(response.quote.amountIn, cfg.operatorMarginBps);

    const req = mapToPaymentRequirements(response, cfg, testInputs(), margin);

    expect(req.amount).toBe(margin.amountWithMargin);
    expect(req.amount).toBe("10030000"); // 10M + 0.3%
    expect(req.payTo).toBe(response.quote.depositAddress);
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe(cfg.originNetwork);
  });

  it("populates extra.crossChain with operatorFee, destinationRecipient, destinationAsset, and refundTo (buyer wins)", () => {
    const cfg = testConfig({
      operatorMarginBps: 50,
      gatewayRefundAddress: "0xfacefacefacefacefacefacefacefacefaceface",
    });
    const response = mockQuoteResponse();
    const margin = applyOperatorMargin(response.quote.amountIn, cfg.operatorMarginBps);

    // Buyer-supplied refundAddress wins.
    const inputs = testInputs({
      ...DESTINATION_PRESETS.arbitrum,
      refundAddress: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
    });
    const cross = mapToPaymentRequirements(response, cfg, inputs, margin).extra.crossChain as {
      operatorFee: { bps: number; amount: string; currency: string };
      destinationRecipient: string;
      destinationAsset: string;
      refundTo: string;
    };

    expect(cross.operatorFee).toEqual({ bps: 50, amount: margin.marginAmount, currency: "USDC" });
    expect(cross.destinationRecipient).toBe(inputs.destinationAddress);
    expect(cross.destinationAsset).toBe(inputs.destinationAsset);
    expect(cross.refundTo).toBe(inputs.refundAddress);

    // Buyer omits refundAddress → falls back to gateway address.
    const noRefund = mapToPaymentRequirements(response, cfg, testInputs(), margin).extra.crossChain as { refundTo: string };
    expect(noRefund.refundTo).toBe(cfg.gatewayRefundAddress);
  });

  it("threads tokenSupportsEip3009 into extra.assetTransferMethod (eip3009 vs permit2)", () => {
    const response = mockQuoteResponse();
    const margin = applyOperatorMargin(response.quote.amountIn, 30);

    expect(
      mapToPaymentRequirements(response, testConfig({ tokenSupportsEip3009: true }), testInputs(), margin).extra
        .assetTransferMethod,
    ).toBe("eip3009");
    expect(
      mapToPaymentRequirements(response, testConfig({ tokenSupportsEip3009: false }), testInputs(), margin).extra
        .assetTransferMethod,
    ).toBe("permit2");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// computeMaxTimeoutSeconds + toQuoteResponseRecord (small helpers)
// ═══════════════════════════════════════════════════════════════════════

describe("computeMaxTimeoutSeconds", () => {
  it("returns 600 fallback when deadline is undefined; floors at 60 for short deadlines", () => {
    expect(computeMaxTimeoutSeconds(undefined, 30)).toBe(600);
    expect(computeMaxTimeoutSeconds(new Date(Date.now() + 5_000).toISOString(), 30)).toBe(60);
    const longDeadline = new Date(Date.now() + 600_000).toISOString();
    const result = computeMaxTimeoutSeconds(longDeadline, 30);
    expect(result).toBeGreaterThan(560);
    expect(result).toBeLessThanOrEqual(570);
  });
});

describe("toQuoteResponseRecord", () => {
  it("preserves correlationId, timestamp, signature, and key quote fields", () => {
    const response = mockQuoteResponse();
    const record = toQuoteResponseRecord(response);
    expect(record.correlationId).toBe(response.correlationId);
    expect(record.signature).toBe(response.signature);
    expect(record.quote.depositAddress).toBe(response.quote.depositAddress);
    expect(record.quote.amountIn).toBe(response.quote.amountIn);
    expect(record.quote.amountOut).toBe(response.quote.amountOut);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildPaymentRequirements (the main entry point — happy path + failure modes)
// ═══════════════════════════════════════════════════════════════════════

describe("buildPaymentRequirements", () => {
  it("returns requirements + persists state with swapInputs and operatorMarginBps on the happy path", async () => {
    const cfg = testConfig();
    const store = makeMockStore();
    const inputs = testInputs();
    const response = mockQuoteResponse();

    const result = await buildPaymentRequirements(cfg, store, "/api/swap", inputs, mockQuoteFn(response));

    expect(result.requirements.payTo).toBe(response.quote.depositAddress);
    expect(result.state).toMatchObject({
      phase: "QUOTED",
      swapInputs: inputs,
      operatorMarginBps: cfg.operatorMarginBps,
      depositAddress: response.quote.depositAddress,
    });
    const stored = await store.get(response.quote.depositAddress!);
    expect(stored?.depositAddress).toBe(response.quote.depositAddress);
  });

  it("forwards buyer-supplied destination into the 1CS quote request (EXACT_INPUT)", async () => {
    const inputs = testInputs(DESTINATION_PRESETS.arbitrum);
    const { fn, getCaptured } = capturingQuoteFn(mockQuoteResponse());

    await buildPaymentRequirements(testConfig(), makeMockStore(), "/api/swap", inputs, fn);

    expect(getCaptured()).toMatchObject({
      destinationAsset: inputs.destinationAsset,
      recipient: inputs.destinationAddress,
      amount: inputs.amountIn,
      swapType: "EXACT_INPUT",
    });
  });

  it("rejects buyer destination format mismatches before contacting 1CS", async () => {
    const inputs = testInputs({
      ...DESTINATION_PRESETS.arbitrum,
      destinationAddress: "alice.near",
    });
    const { fn, getCaptured } = capturingQuoteFn(mockQuoteResponse());

    await expect(
      buildPaymentRequirements(testConfig(), makeMockStore(), "/api/swap", inputs, fn),
    ).rejects.toThrow(InvalidInputError);
    expect(getCaptured()).toBeUndefined();
  });

  it("throws QuoteUnavailableError on missing/malformed depositAddress or zero amountIn", async () => {
    const noAddr = mockQuoteResponse();
    delete (noAddr.quote as { depositAddress?: string }).depositAddress;
    await expect(
      buildPaymentRequirements(testConfig(), makeMockStore(), "/api/swap", testInputs(), mockQuoteFn(noAddr)),
    ).rejects.toThrow(QuoteUnavailableError);

    await expect(
      buildPaymentRequirements(testConfig(), makeMockStore(), "/api/swap", testInputs(), mockQuoteFn(mockQuoteResponse({ depositAddress: "not-an-address" }))),
    ).rejects.toThrow(/invalid depositAddress/);

    await expect(
      buildPaymentRequirements(testConfig(), makeMockStore(), "/api/swap", testInputs(), mockQuoteFn(mockQuoteResponse({ amountIn: "0" }))),
    ).rejects.toThrow(/invalid amountIn/);
  });

  it.each([
    [400, QuoteUnavailableError],
    [401, AuthenticationError],
    [503, ServiceUnavailableError],
  ] as const)("maps 1CS %i to the corresponding gateway error", async (status, ErrorClass) => {
    await expect(
      buildPaymentRequirements(
        testConfig(),
        makeMockStore(),
        "/api/swap",
        testInputs(),
        failingQuoteFn(status, { message: "upstream" }),
      ),
    ).rejects.toThrow(ErrorClass);
  });

  it("maps network errors to ServiceUnavailableError", async () => {
    const networkErr: QuoteFn = async () => { throw new Error("Network connection refused"); };
    await expect(
      buildPaymentRequirements(testConfig(), makeMockStore(), "/api/swap", testInputs(), networkErr),
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("attaches diagnostic context (upstreamStatus + recipient + destinationAsset) on 1CS errors", async () => {
    try {
      await buildPaymentRequirements(
        testConfig(),
        makeMockStore(),
        "/api/swap",
        testInputs(),
        failingQuoteFn(400),
      );
      throw new Error("should have thrown");
    } catch (err) {
      const ctx = (err as QuoteUnavailableError).context;
      expect(ctx?.upstreamStatus).toBe(400);
      expect(ctx?.recipient).toBeDefined();
      expect(ctx?.destinationAsset).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// diagnoseQuoteRequest — distinct from validateBuyerDestination: this is
// the soft post-1CS-error diagnoser whose hints land in operator logs.
// ═══════════════════════════════════════════════════════════════════════

describe("diagnoseQuoteRequest", () => {
  it("returns no hints for a clean quote", () => {
    expect(
      diagnoseQuoteRequest({
        originAsset: "nep141:base-0xabc.omft.near",
        destinationAsset: "nep141:usdt.tether-token.near",
        recipient: "alice.near",
        amount: "1000000",
        refundTo: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ).toEqual([]);
  });

  it("flags whitespace/inline-comment artifacts in any field (.env copy-paste bugs)", () => {
    expect(
      diagnoseQuoteRequest({ recipient: " alice.near" }).some((h) => h.includes("whitespace")),
    ).toBe(true);
    expect(
      diagnoseQuoteRequest({ destinationAsset: "nep141:usdt.tether-token.near #comment" }).some((h) =>
        h.includes("#"),
      ),
    ).toBe(true);
  });

  it("flags chain-format mismatches and unknown prefixes", () => {
    // EVM destination + NEAR address
    expect(
      diagnoseQuoteRequest({
        destinationAsset: "nep141:arb-0xaf88.omft.near",
        recipient: "alice.near",
      }).some((h) => h.toLowerCase().includes("evm address")),
    ).toBe(true);

    // Unknown chain prefix
    expect(
      diagnoseQuoteRequest({
        destinationAsset: "nep141:futurechain-0xabc.omft.near",
        recipient: "0x1234567890abcdef1234567890abcdef12345678",
      }).some((h) => h.includes("futurechain")),
    ).toBe(true);
  });
});
