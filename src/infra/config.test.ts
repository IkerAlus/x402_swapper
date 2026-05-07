import { describe, it, expect, vi, afterEach } from "vitest";
import { GatewayConfigSchema, loadConfigFromEnv } from "./config.js";

/** Minimal valid env that satisfies every required field. */
function validEnv(): Record<string, string> {
  return {
    ONE_CLICK_JWT: "test-jwt-token",
    ORIGIN_NETWORK: "eip155:8453",
    ORIGIN_ASSET_IN: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ORIGIN_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ORIGIN_RPC_URLS: "https://mainnet.base.org,https://base.drpc.org",
    FACILITATOR_PRIVATE_KEY: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    GATEWAY_REFUND_ADDRESS: "0x1234567890abcdef1234567890abcdef12345678",
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
    });
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

  describe("operatorMarginBps bounds (0..1000 integer)", () => {
    it("accepts the boundary values 0 and 1000", () => {
      expect(GatewayConfigSchema.parse({ ...validSchemaInput(), operatorMarginBps: 0 }).operatorMarginBps).toBe(0);
      expect(GatewayConfigSchema.parse({ ...validSchemaInput(), operatorMarginBps: 1000 }).operatorMarginBps).toBe(1000);
    });

    it.each([-1, 1001, 30.5])("rejects out-of-range value %s", (value) => {
      expect(GatewayConfigSchema.safeParse({ ...validSchemaInput(), operatorMarginBps: value }).success).toBe(false);
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

  it("throws on missing required env vars", () => {
    expect(() => loadConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow();
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
