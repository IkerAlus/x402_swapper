import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayConfigSchema, loadConfigFromEnv } from "./config.js";

/** Minimal valid env that satisfies every required field (default bps=30 → recipient required). */
function validEnv(): Record<string, string> {
  return {
    ONE_CLICK_JWT: "test-jwt-token",
    ORIGIN_NETWORK: "eip155:8453",
    ORIGIN_ASSET_IN: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ORIGIN_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ORIGIN_RPC_URLS: "https://mainnet.base.org,https://base.drpc.org",
    FACILITATOR_PRIVATE_KEY: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    GATEWAY_REFUND_ADDRESS: "0x1234567890abcdef1234567890abcdef12345678",
    OPERATOR_FEE_RECIPIENT: "operator.near", // required by D16 with default bps=30
  };
}

/** Minimal valid schema input (no env-var-name mapping). */
function validSchemaInput() {
  return {
    oneClickJwt: "jwt",
    originNetwork: "eip155:8453",
    originAssetIn: "nep141:base-0xabc",
    originTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    originRpcUrls: ["https://mainnet.base.org"],
    facilitatorPrivateKey: "0xabc",
    gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    operatorFeeRecipient: "operator.near", // required by D16 with default bps=30
  };
}

// ═══════════════════════════════════════════════════════════════════════
// GatewayConfigSchema (Zod schema for our config invariants)
// ═══════════════════════════════════════════════════════════════════════

describe("GatewayConfigSchema", () => {
  it("accepts a valid config and applies defaults for tuning fields", () => {
    const cfg = GatewayConfigSchema.parse(validSchemaInput());
    expect(cfg).toMatchObject({
      oneClickBaseUrl: "https://1click.chaindefuser.com",
      maxPollTimeMs: 300_000,
      pollIntervalBaseMs: 2_000,
      pollIntervalMaxMs: 30_000,
      quoteExpiryBufferSec: 30,
      tokenName: "USD Coin",
      tokenVersion: "2",
      tokenSupportsEip3009: true,
      operatorMarginBps: 30,
      // Persistence + shutdown defaults (TODO #2 + #3): in-memory by default,
      // 30 s flush interval if a file is set, 30 s shutdown grace.
      storeSaveIntervalMs: 30_000,
      shutdownGraceMs: 30_000,
    });
    expect(cfg.storeFilePath).toBeUndefined();
  });

  it.each([
    ["invalid CAIP-2 originNetwork", { originNetwork: "base-mainnet" }],
    ["invalid EVM originTokenAddress", { originTokenAddress: "not-an-address" }],
    ["empty originRpcUrls", { originRpcUrls: [] }],
  ])("rejects %s", (_label, override) => {
    expect(GatewayConfigSchema.safeParse({ ...validSchemaInput(), ...override }).success).toBe(false);
  });

  it("rejects an empty config (every required field flagged)", () => {
    expect(GatewayConfigSchema.safeParse({}).success).toBe(false);
  });

  describe("operatorMarginBps bounds (0..500 integer — 1CS appFees ceiling)", () => {
    it("accepts the boundary values 0 and 500 (with recipient when bps > 0)", () => {
      // bps=0: recipient is optional (no fee collected at all)
      expect(GatewayConfigSchema.parse({
        ...validSchemaInput(),
        operatorMarginBps: 0,
        operatorFeeRecipient: undefined,
      }).operatorMarginBps).toBe(0);
      // bps=500 (5%, the 1CS-imposed upper bound): recipient required and present
      expect(GatewayConfigSchema.parse({
        ...validSchemaInput(),
        operatorMarginBps: 500,
      }).operatorMarginBps).toBe(500);
    });

    it.each([-1, 501, 1000, 30.5])("rejects out-of-range value %s", (value) => {
      expect(GatewayConfigSchema.safeParse({ ...validSchemaInput(), operatorMarginBps: value }).success).toBe(false);
    });
  });

  // D16 — when bps > 0, OPERATOR_FEE_RECIPIENT is required and must be a
  // valid NEAR Intents account.
  describe("operatorFeeRecipient (D16)", () => {
    it("rejects when operatorMarginBps > 0 and operatorFeeRecipient is missing", () => {
      const result = GatewayConfigSchema.safeParse({
        ...validSchemaInput(),
        operatorMarginBps: 30,
        operatorFeeRecipient: undefined,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join(".") === "operatorFeeRecipient")).toBe(true);
      }
    });

    it("rejects when operatorFeeRecipient is not a valid NEAR Intents account (EVM address)", () => {
      const result = GatewayConfigSchema.safeParse({
        ...validSchemaInput(),
        operatorMarginBps: 30,
        operatorFeeRecipient: "0x1234567890abcdef1234567890abcdef12345678",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join(".") === "operatorFeeRecipient")).toBe(true);
      }
    });

    it("accepts named NEAR accounts (.near, .tg) and 64-char implicit hex when bps > 0", () => {
      for (const recipient of ["operator.near", "sub.operator.near", "ops.tg", "a".repeat(64)]) {
        const result = GatewayConfigSchema.safeParse({
          ...validSchemaInput(),
          operatorMarginBps: 30,
          operatorFeeRecipient: recipient,
        });
        expect(result.success, `recipient=${recipient} should pass`).toBe(true);
      }
    });

    it("ignores operatorFeeRecipient validity when operatorMarginBps = 0 (recipient is unused)", () => {
      // Even an EVM-format recipient passes when bps=0 — it'll never be used.
      const result = GatewayConfigSchema.safeParse({
        ...validSchemaInput(),
        operatorMarginBps: 0,
        operatorFeeRecipient: "0x1234567890abcdef1234567890abcdef12345678",
      });
      expect(result.success).toBe(true);
    });
  });

  // ── Persistence (TODO #2) and graceful shutdown (TODO #3) knobs ────
  describe("storeFilePath / storeSaveIntervalMs / shutdownGraceMs", () => {
    it("defaults: storeFilePath undefined (in-memory), saveInterval 30s, shutdownGrace 30s", () => {
      const cfg = GatewayConfigSchema.parse(validSchemaInput());
      expect(cfg.storeFilePath).toBeUndefined();
      expect(cfg.storeSaveIntervalMs).toBe(30_000);
      expect(cfg.shutdownGraceMs).toBe(30_000);
    });

    it("accepts a non-empty storeFilePath and overrides for the two intervals", () => {
      const cfg = GatewayConfigSchema.parse({
        ...validSchemaInput(),
        storeFilePath: "/var/lib/x402-swapper/state.db",
        storeSaveIntervalMs: 5_000,
        shutdownGraceMs: 60_000,
      });
      expect(cfg.storeFilePath).toBe("/var/lib/x402-swapper/state.db");
      expect(cfg.storeSaveIntervalMs).toBe(5_000);
      expect(cfg.shutdownGraceMs).toBe(60_000);
    });

    it("rejects empty-string storeFilePath (should be undefined, not '')", () => {
      // Empty strings are filtered to undefined by `orUndef` in loadConfigFromEnv
      // — but if a programmatic caller passes "" directly, the schema must
      // catch it. `.min(1)` enforces that.
      expect(
        GatewayConfigSchema.safeParse({ ...validSchemaInput(), storeFilePath: "" }).success,
      ).toBe(false);
    });

    it.each([
      ["storeSaveIntervalMs = 0", { storeSaveIntervalMs: 0 }],
      ["storeSaveIntervalMs negative", { storeSaveIntervalMs: -1 }],
      ["shutdownGraceMs = 0", { shutdownGraceMs: 0 }],
      ["shutdownGraceMs negative", { shutdownGraceMs: -100 }],
    ])("rejects %s (must be positive integer)", (_label, override) => {
      expect(
        GatewayConfigSchema.safeParse({ ...validSchemaInput(), ...override }).success,
      ).toBe(false);
    });
  });

  // ── SLIPPAGE_TOLERANCE_BPS (TODO #9) ───────────────────────────────
  describe("slippageToleranceBps", () => {
    it("defaults to 50 bps (0.5%)", () => {
      const cfg = GatewayConfigSchema.parse(validSchemaInput());
      expect(cfg.slippageToleranceBps).toBe(50);
    });

    it("accepts the boundary values 0 and 1000", () => {
      expect(
        GatewayConfigSchema.parse({ ...validSchemaInput(), slippageToleranceBps: 0 })
          .slippageToleranceBps,
      ).toBe(0);
      expect(
        GatewayConfigSchema.parse({ ...validSchemaInput(), slippageToleranceBps: 1000 })
          .slippageToleranceBps,
      ).toBe(1000);
    });

    it.each([-1, 1001, 25.5])("rejects out-of-range value %s", (value) => {
      expect(
        GatewayConfigSchema.safeParse({ ...validSchemaInput(), slippageToleranceBps: value }).success,
      ).toBe(false);
    });
  });

  // ── MAX_AMOUNT_IN cap (TODO #8) ────────────────────────────────────
  describe("maxAmountIn", () => {
    it("defaults to undefined (no cap)", () => {
      const cfg = GatewayConfigSchema.parse(validSchemaInput());
      expect(cfg.maxAmountIn).toBeUndefined();
    });

    it("accepts a positive-integer digit-string", () => {
      const cfg = GatewayConfigSchema.parse({ ...validSchemaInput(), maxAmountIn: "100000000" });
      expect(cfg.maxAmountIn).toBe("100000000");
    });

    it.each([
      ["empty string", ""],
      ["leading zero", "01"],
      ["zero", "0"],
      ["negative", "-1"],
      ["non-digit", "1e9"],
      ["decimal", "100.5"],
      ["whitespace", " 100 "],
    ])("rejects %s", (_label, value) => {
      expect(
        GatewayConfigSchema.safeParse({ ...validSchemaInput(), maxAmountIn: value }).success,
      ).toBe(false);
    });

    it("accepts uint256-class magnitudes (BigInt-safe)", () => {
      const huge = "1".padEnd(78, "0"); // ~10^77
      const cfg = GatewayConfigSchema.parse({ ...validSchemaInput(), maxAmountIn: huge });
      expect(cfg.maxAmountIn).toBe(huge);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// loadConfigFromEnv (env-var → typed config — our env mapping logic)
// ═══════════════════════════════════════════════════════════════════════

describe("loadConfigFromEnv", () => {
  it("parses required env vars and splits ORIGIN_RPC_URLS on comma", () => {
    const cfg = loadConfigFromEnv(validEnv() as unknown as NodeJS.ProcessEnv);
    expect(cfg.oneClickJwt).toBe("test-jwt-token");
    expect(cfg.originNetwork).toBe("eip155:8453");
    expect(cfg.originRpcUrls).toEqual(["https://mainnet.base.org", "https://base.drpc.org"]);
  });

  it("coerces numeric and boolean env vars from their string representations", () => {
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      MAX_POLL_TIME_MS: "120000",
      POLL_INTERVAL_BASE_MS: "5000",
      QUOTE_EXPIRY_BUFFER_SEC: "60",
      OPERATOR_MARGIN_BPS: "50",
      TOKEN_SUPPORTS_EIP3009: "false",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.maxPollTimeMs).toBe(120_000);
    expect(cfg.pollIntervalBaseMs).toBe(5_000);
    expect(cfg.quoteExpiryBufferSec).toBe(60);
    expect(cfg.operatorMarginBps).toBe(50);
    expect(cfg.tokenSupportsEip3009).toBe(false);
  });

  it("maps STORE_FILE_PATH / STORE_SAVE_INTERVAL_MS / SHUTDOWN_GRACE_MS env vars (TODO #2 + #3)", () => {
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      STORE_FILE_PATH: "/var/lib/x402-swapper/state.db",
      STORE_SAVE_INTERVAL_MS: "5000",
      SHUTDOWN_GRACE_MS: "60000",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.storeFilePath).toBe("/var/lib/x402-swapper/state.db");
    expect(cfg.storeSaveIntervalMs).toBe(5_000);
    expect(cfg.shutdownGraceMs).toBe(60_000);
  });

  it("treats empty STORE_FILE_PATH as 'unset' (falls back to in-memory)", () => {
    // Regression: `STORE_FILE_PATH=` in a .env file becomes `""` in
    // process.env; without `orUndef` it would fail Zod's `.min(1)`.
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      STORE_FILE_PATH: "",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.storeFilePath).toBeUndefined();
  });

  it("maps SLIPPAGE_TOLERANCE_BPS env var (TODO #9)", () => {
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      SLIPPAGE_TOLERANCE_BPS: "200", // 2% — wider than default for volatile pairs
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.slippageToleranceBps).toBe(200);
  });

  it("maps MAX_AMOUNT_IN env var (TODO #8)", () => {
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      MAX_AMOUNT_IN: "500000000", // 500 USDC at 6 decimals
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.maxAmountIn).toBe("500000000");
  });

  it("treats empty MAX_AMOUNT_IN as 'unset' (no cap)", () => {
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      MAX_AMOUNT_IN: "",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.maxAmountIn).toBeUndefined();
  });

  it("throws on missing required env vars", () => {
    expect(() => loadConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow();
  });

  it("treats empty-string env vars as 'unset' for optional/defaulted string fields", () => {
    // Regression: `dotenv` sets `process.env.X = ""` for blank `.env` lines
    // like `PUBLIC_BASE_URL=`. Without empty-string handling, `.url()` rejects
    // (would crash boot) and `.default()` is overridden with the empty string.
    const cfg = loadConfigFromEnv({
      ...validEnv(),
      PUBLIC_BASE_URL: "",
      ONE_CLICK_BASE_URL: "",
      TOKEN_NAME: "",
      TOKEN_VERSION: "",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.publicBaseUrl).toBeUndefined();
    expect(cfg.oneClickBaseUrl).toBe("https://1click.chaindefuser.com"); // default applied
    expect(cfg.tokenName).toBe("USD Coin");
    expect(cfg.tokenVersion).toBe("2");
  });

  it("parses ALLOWED_ORIGINS as a trimmed comma list; leaves undefined for unset/empty/whitespace-only", () => {
    expect(
      loadConfigFromEnv({
        ...validEnv(),
        ALLOWED_ORIGINS: "https://a.example, https://b.example ,https://c.example",
      } as unknown as NodeJS.ProcessEnv).allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example", "https://c.example"]);

    expect(loadConfigFromEnv(validEnv() as unknown as NodeJS.ProcessEnv).allowedOrigins).toBeUndefined();
    expect(
      loadConfigFromEnv({ ...validEnv(), ALLOWED_ORIGINS: " , ," } as unknown as NodeJS.ProcessEnv).allowedOrigins,
    ).toBeUndefined();
  });

  describe("discovery config (PUBLIC_BASE_URL + OWNERSHIP_PROOFS)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    afterEach(() => warnSpy?.mockRestore());

    it("defaults to no public URL and an empty proofs list", () => {
      const cfg = loadConfigFromEnv(validEnv() as unknown as NodeJS.ProcessEnv);
      expect(cfg.publicBaseUrl).toBeUndefined();
      expect(cfg.ownershipProofs).toEqual([]);
    });

    it("parses a valid PUBLIC_BASE_URL; rejects a non-URL value at schema parse", () => {
      expect(
        loadConfigFromEnv({
          ...validEnv(),
          PUBLIC_BASE_URL: "https://gateway.example.com",
        } as unknown as NodeJS.ProcessEnv).publicBaseUrl,
      ).toBe("https://gateway.example.com");

      expect(() =>
        loadConfigFromEnv({ ...validEnv(), PUBLIC_BASE_URL: "not-a-url" } as unknown as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it("parses OWNERSHIP_PROOFS as a trimmed comma list", () => {
      const cfg = loadConfigFromEnv({
        ...validEnv(),
        OWNERSHIP_PROOFS: " 0xaaa ,0xbbb ,  ,0xccc",
      } as unknown as NodeJS.ProcessEnv);
      expect(cfg.ownershipProofs).toEqual(["0xaaa", "0xbbb", "0xccc"]);
    });

    it("emits a warning when proofs are present but PUBLIC_BASE_URL is missing OR a proof is malformed", () => {
      // Case A: proofs without URL.
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadConfigFromEnv({
        ...validEnv(),
        OWNERSHIP_PROOFS: "0x" + "a".repeat(130),
      } as unknown as NodeJS.ProcessEnv);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("PUBLIC_BASE_URL is not");

      // Case B: malformed proof signature.
      warnSpy.mockClear();
      loadConfigFromEnv({
        ...validEnv(),
        PUBLIC_BASE_URL: "https://gateway.example.com",
        OWNERSHIP_PROOFS: "not-a-signature",
      } as unknown as NodeJS.ProcessEnv);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("malformed");
    });

    it("logs the recovered signer address for a valid ownership proof (operator-debug aid)", async () => {
      const { ethers } = await import("ethers");
      const { signOwnershipProof } = await import("../http/ownership-proof.js");
      const wallet = new ethers.Wallet("0x" + "ef".repeat(32));
      const proof = await signOwnershipProof(wallet, "https://gateway.example.com");

      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadConfigFromEnv({
        ...validEnv(),
        PUBLIC_BASE_URL: "https://gateway.example.com",
        OWNERSHIP_PROOFS: proof,
      } as unknown as NodeJS.ProcessEnv);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("recovered to");
      expect(logged).toContain(wallet.address.toLowerCase());
    });

    it("stays silent when discovery is fully unset", () => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadConfigFromEnv(validEnv() as unknown as NodeJS.ProcessEnv);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("Discovery check");
    });
  });
});
