/**
 * Tests for the Verifier module.
 *
 * Uses injectable ChainReader and InMemoryStateStore to avoid real RPC calls.
 * EIP-712 signatures are generated using ethers.js Wallet.signTypedData so
 * the tests exercise actual cryptographic verification, not mocked signatures.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  verifyPayment,
  extractChainId,
  validateRequirementsMatch,
  type ChainReader,
  type VerifierOptions,
} from "./verifier.js";
import { InMemoryStateStore } from "../storage/store.js";
import type {
  SwapState,
  PaymentPayloadRecord,
  PaymentRequirementsRecord,
} from "../types.js";
import type { GatewayConfig } from "../infra/config.js";
import { mockGatewayConfig } from "../mocks/mock-config.js";
import {
  authorizationTypes,
  permit2WitnessTypes,
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

const TEST_CHAIN_ID = 8453; // Base mainnet
const TEST_NETWORK = "eip155:8453";
const TEST_TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TEST_DEPOSIT_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

/** Generate a random ethers Wallet for test signing. */
function randomWallet(): ethers.Wallet {
  return ethers.Wallet.createRandom();
}

/**
 * Minimal valid `GatewayConfig` for verifier tests. Delegates to the
 * shared `mockGatewayConfig` fixture (same defaults used by the rest of
 * the suite) so verifier + integration tests stay in lockstep.
 */
function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return mockGatewayConfig(overrides);
}

/** Build a mock PaymentRequirementsRecord. */
function makeRequirements(
  overrides: Partial<PaymentRequirementsRecord> = {},
): PaymentRequirementsRecord {
  return {
    scheme: "exact",
    network: TEST_NETWORK,
    asset: TEST_TOKEN_ADDRESS,
    amount: "10500000",
    payTo: TEST_DEPOSIT_ADDRESS,
    maxTimeoutSeconds: 270,
    extra: {
      name: "USD Coin",
      version: "2",
      assetTransferMethod: "eip3009",
    },
    ...overrides,
  };
}

/** Build a SwapState in QUOTED phase. */
function makeQuotedState(
  requirements: PaymentRequirementsRecord,
  overrides: Partial<SwapState> = {},
): SwapState {
  const now = Date.now();
  return {
    depositAddress: requirements.payTo,
    quoteResponse: {
      correlationId: "corr-test",
      timestamp: new Date().toISOString(),
      signature: "sig-test",
      quoteRequest: { swapType: "EXACT_OUTPUT" },
      quote: {
        depositAddress: requirements.payTo,
        amountIn: requirements.amount,
        amountInFormatted: "10.50",
        amountInUsd: "10.50",
        minAmountIn: "10000000",
        amountOut: "10000000",
        amountOutFormatted: "10.00",
        amountOutUsd: "10.00",
        minAmountOut: "9950000",
        deadline: new Date(now + 300_000).toISOString(), // 5min from now
        timeEstimate: 60,
      },
    },
    paymentRequirements: requirements,
    phase: "QUOTED",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Sign an EIP-3009 TransferWithAuthorization message with a real wallet.
 * Returns the full ExactEIP3009Payload.
 */
async function signEIP3009(
  wallet: ethers.Wallet,
  params: {
    to: string;
    value: string;
    validAfter?: string;
    validBefore?: string;
    nonce?: string;
    tokenName?: string;
    tokenVersion?: string;
    tokenAddress?: string;
    chainId?: number;
  },
): Promise<{ authorization: Record<string, string>; signature: string }> {
  const domain: ethers.TypedDataDomain = {
    name: params.tokenName ?? "USD Coin",
    version: params.tokenVersion ?? "2",
    chainId: params.chainId ?? TEST_CHAIN_ID,
    verifyingContract: params.tokenAddress ?? TEST_TOKEN_ADDRESS,
  };

  const types = {
    TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
      (f) => ({ name: f.name, type: f.type }),
    ),
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const message = {
    from: wallet.address,
    to: params.to,
    value: BigInt(params.value).toString(),
    validAfter: params.validAfter ?? "0",
    validBefore: params.validBefore ?? String(nowSec + 3600),
    nonce: params.nonce ?? ethers.hexlify(ethers.randomBytes(32)),
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    authorization: message,
    signature,
  };
}

/**
 * Sign a Permit2 PermitWitnessTransferFrom message with a real wallet.
 */
async function signPermit2(
  wallet: ethers.Wallet,
  params: {
    to: string;
    amount: string;
    deadline?: string;
    validAfter?: string;
    nonce?: string;
    tokenAddress?: string;
    chainId?: number;
  },
): Promise<{ permit2Authorization: Record<string, unknown>; signature: string }> {
  const domain: ethers.TypedDataDomain = {
    name: "Permit2",
    verifyingContract: PERMIT2_ADDRESS,
    chainId: params.chainId ?? TEST_CHAIN_ID,
  };

  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [key, fields] of Object.entries(permit2WitnessTypes)) {
    types[key] = fields.map((f: { name: string; type: string }) => ({
      name: f.name,
      type: f.type,
    }));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const message = {
    permitted: {
      token: params.tokenAddress ?? TEST_TOKEN_ADDRESS,
      amount: BigInt(params.amount).toString(),
    },
    spender: x402ExactPermit2ProxyAddress,
    nonce: params.nonce ?? "1",
    deadline: params.deadline ?? String(nowSec + 3600),
    witness: {
      to: params.to,
      validAfter: params.validAfter ?? "0",
    },
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    permit2Authorization: {
      ...message,
      from: wallet.address,
    },
    signature,
  };
}

/** Create a mock ChainReader that returns configurable values. */
function mockChainReader(
  overrides: {
    balance?: bigint;
    allowance?: bigint;
    chainId?: number;
    balanceError?: Error;
    allowanceError?: Error;
  } = {},
): ChainReader {
  return {
    async readContract(
      _address: string,
      _abi: readonly unknown[],
      method: string,
      _args: unknown[],
    ): Promise<unknown> {
      if (method === "balanceOf") {
        if (overrides.balanceError) throw overrides.balanceError;
        return overrides.balance ?? BigInt("1000000000"); // 1000 USDC default
      }
      if (method === "allowance") {
        if (overrides.allowanceError) throw overrides.allowanceError;
        return overrides.allowance ?? BigInt("1000000000000"); // large default
      }
      return BigInt(0);
    },
    async getChainId(): Promise<number> {
      return overrides.chainId ?? TEST_CHAIN_ID;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// EIP-3009 verification tests
// ═══════════════════════════════════════════════════════════════════════

describe("verifyPayment — EIP-3009", () => {
  let store: InMemoryStateStore;
  let cfg: GatewayConfig;
  let reader: ChainReader;
  const opts: VerifierOptions = { skipOnChainChecks: true };

  beforeEach(() => {
    store = new InMemoryStateStore();
    cfg = testConfig();
    reader = mockChainReader();
  });

  it("should verify a valid EIP-3009 payment and transition to VERIFIED", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);

    expect(result.valid).toBe(true);
    expect(result.signerAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());

    // Check state was updated
    const updated = await store.get(state.depositAddress);
    expect(updated!.phase).toBe("VERIFIED");
    expect(updated!.signerAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(updated!.paymentPayload).toBeDefined();
  });

  it("should reject if no swap state exists for the deposit address", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No swap state found");
  });

  it("should reject if state is not in QUOTED phase", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs, { phase: "BROADCASTING" });
    await store.create(state.depositAddress, state);

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("already in progress");
  });

  it("should return cached success if state is SETTLED", async () => {
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs, {
      phase: "SETTLED",
      signerAddress: "0xCACHED",
    });
    await store.create(state.depositAddress, state);

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: {} as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(true);
    expect(result.signerAddress).toBe("0xCACHED");
  });

  it("should reject and expire if quote deadline has passed", async () => {
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    // Set deadline to the past
    state.quoteResponse.quote.deadline = new Date(Date.now() - 1000).toISOString();
    await store.create(state.depositAddress, state);

    const wallet = randomWallet();
    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");

    // State should be EXPIRED
    const updated = await store.get(state.depositAddress);
    expect(updated!.phase).toBe("EXPIRED");
  });

  it("should reject if accepted requirements don't match stored", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Modify accepted requirements to mismatch
    const wrongReqs = makeRequirements({ scheme: "upto" });

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: wrongReqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Scheme mismatch");
  });

  it("should reject if authorization.to doesn't match deposit address", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Sign with wrong recipient
    const signed = await signEIP3009(wallet, {
      to: "0x" + "00".repeat(20),
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("recipient mismatch");
  });

  it("should reject if authorization amount is too low", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Sign with lower amount
    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "100", // way below 10500000
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("amount too low");
  });

  it("should reject if validBefore is in the past", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
      validBefore: "1000", // epoch second 1000 — long past
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("should reject if signature is from wrong signer", async () => {
    const realBuyer = randomWallet();
    const impostor = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Sign with impostor but set authorization.from to realBuyer
    const nowSec = Math.floor(Date.now() / 1000);
    const domain: ethers.TypedDataDomain = {
      name: "USD Coin",
      version: "2",
      chainId: TEST_CHAIN_ID,
      verifyingContract: TEST_TOKEN_ADDRESS,
    };
    const types = {
      TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
        (f) => ({ name: f.name, type: f.type }),
      ),
    };
    const message = {
      from: realBuyer.address, // claim to be realBuyer
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
      validAfter: "0",
      validBefore: String(nowSec + 3600),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };
    // But sign with impostor's key
    const signature = await impostor.signTypedData(domain, types, message);

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: { authorization: message, signature } as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Signer mismatch");
  });

  it("should verify with on-chain balance check when enabled", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    // Sufficient balance
    const goodReader = mockChainReader({ balance: BigInt("100000000") });
    const result = await verifyPayment(payload, store, goodReader, cfg);
    expect(result.valid).toBe(true);
  });

  it("should reject on insufficient on-chain balance", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signEIP3009(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    // Insufficient balance
    const poorReader = mockChainReader({ balance: BigInt("100") });
    const result = await verifyPayment(payload, store, poorReader, cfg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Insufficient token balance");
  });

  it("should not update state on failed verification", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Sign with wrong recipient → will fail
    const signed = await signEIP3009(wallet, {
      to: "0x" + "00".repeat(20),
      value: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    await verifyPayment(payload, store, reader, cfg, opts);

    // State should remain QUOTED
    const unchanged = await store.get(state.depositAddress);
    expect(unchanged!.phase).toBe("QUOTED");
    expect(unchanged!.signerAddress).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Permit2 verification tests
// ═══════════════════════════════════════════════════════════════════════

describe("verifyPayment — Permit2", () => {
  let store: InMemoryStateStore;
  let cfg: GatewayConfig;
  let reader: ChainReader;
  const opts: VerifierOptions = { skipOnChainChecks: true };

  beforeEach(() => {
    store = new InMemoryStateStore();
    cfg = testConfig({ tokenSupportsEip3009: false });
    reader = mockChainReader();
  });

  it("should verify a valid Permit2 payment and transition to VERIFIED", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signPermit2(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      amount: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);

    expect(result.valid).toBe(true);
    expect(result.signerAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());

    const updated = await store.get(state.depositAddress);
    expect(updated!.phase).toBe("VERIFIED");
  });

  it("should reject if permit2Authorization.spender is wrong", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signPermit2(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      amount: "10500000",
    });

    // Tamper with spender
    (signed.permit2Authorization as Record<string, unknown>).spender = "0x" + "FF".repeat(20);

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("spender mismatch");
  });

  it("should reject if witness.to doesn't match deposit address", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Sign to wrong recipient
    const signed = await signPermit2(wallet, {
      to: "0x" + "00".repeat(20),
      amount: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("witness.to mismatch");
  });

  it("should reject if permitted.token doesn't match required asset", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    // Sign with wrong token
    const signed = await signPermit2(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      amount: "10500000",
      tokenAddress: "0x" + "AA".repeat(20), // different token
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("token mismatch");
  });

  it("should reject if permitted amount is too low", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signPermit2(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      amount: "100", // too low
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("amount too low");
  });

  it("should reject if deadline is in the past", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signPermit2(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      amount: "10500000",
      deadline: "1000", // epoch 1000 — very old
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    const result = await verifyPayment(payload, store, reader, cfg, opts);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("deadline expired");
  });

  it("should reject on insufficient Permit2 allowance", async () => {
    const wallet = randomWallet();
    const reqs = makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    });
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const signed = await signPermit2(wallet, {
      to: TEST_DEPOSIT_ADDRESS,
      amount: "10500000",
    });

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: signed as unknown as Record<string, unknown>,
    };

    // Good balance, insufficient Permit2 allowance
    const lowAllowanceReader = mockChainReader({
      balance: BigInt("100000000"),
      allowance: BigInt("0"),
    });

    const result = await verifyPayment(payload, store, lowAllowanceReader, cfg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Insufficient Permit2 allowance");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Unrecognized payload format
// ═══════════════════════════════════════════════════════════════════════

describe("verifyPayment — unrecognized payload", () => {
  it("should reject payloads with neither authorization nor permit2Authorization", async () => {
    const store = new InMemoryStateStore();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs);
    await store.create(state.depositAddress, state);

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: { garbage: "data" }, // no authorization or permit2Authorization
    };

    const result = await verifyPayment(
      payload,
      store,
      mockChainReader(),
      testConfig(),
      { skipOnChainChecks: true },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unrecognized payload format");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Terminal state handling
// ═══════════════════════════════════════════════════════════════════════

describe("verifyPayment — terminal states", () => {
  it("should reject FAILED state", async () => {
    const store = new InMemoryStateStore();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs, { phase: "FAILED" });
    await store.create(state.depositAddress, state);

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: {},
    };

    const result = await verifyPayment(
      payload,
      store,
      mockChainReader(),
      testConfig(),
      { skipOnChainChecks: true },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("terminal state");
  });

  it("should reject EXPIRED state", async () => {
    const store = new InMemoryStateStore();
    const reqs = makeRequirements();
    const state = makeQuotedState(reqs, { phase: "EXPIRED" });
    await store.create(state.depositAddress, state);

    const payload: PaymentPayloadRecord = {
      x402Version: 2,
      accepted: reqs,
      payload: {},
    };

    const result = await verifyPayment(
      payload,
      store,
      mockChainReader(),
      testConfig(),
      { skipOnChainChecks: true },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("terminal state");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractChainId (unit tests)
// ═══════════════════════════════════════════════════════════════════════

describe("extractChainId", () => {
  it("should extract chain ID from eip155 network string", () => {
    expect(extractChainId("eip155:8453")).toBe(8453);
    expect(extractChainId("eip155:1")).toBe(1);
    expect(extractChainId("eip155:42161")).toBe(42161);
  });

  it("should throw on non-eip155 networks", () => {
    expect(() => extractChainId("solana:mainnet")).toThrow("Unsupported network format");
  });

  it("should throw on malformed network strings", () => {
    expect(() => extractChainId("eip155")).toThrow("Unsupported network format");
    expect(() => extractChainId("eip155:abc")).toThrow("Invalid chain ID");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateRequirementsMatch (unit tests)
// ═══════════════════════════════════════════════════════════════════════

describe("validateRequirementsMatch", () => {
  const stored = makeRequirements();

  it("should return null for matching requirements", () => {
    const accepted = makeRequirements();
    expect(validateRequirementsMatch(accepted, stored)).toBeNull();
  });

  it("should accept case-insensitive address matching", () => {
    const accepted = makeRequirements({
      asset: TEST_TOKEN_ADDRESS.toUpperCase(),
      payTo: TEST_DEPOSIT_ADDRESS.toUpperCase(),
    });
    expect(validateRequirementsMatch(accepted, stored)).toBeNull();
  });

  it("should accept higher amount from buyer", () => {
    const accepted = makeRequirements({ amount: "20000000" }); // more than 10500000
    expect(validateRequirementsMatch(accepted, stored)).toBeNull();
  });

  it("should detect scheme mismatch", () => {
    const accepted = makeRequirements({ scheme: "upto" });
    expect(validateRequirementsMatch(accepted, stored)).toContain("Scheme mismatch");
  });

  it("should detect network mismatch", () => {
    const accepted = makeRequirements({ network: "eip155:1" });
    expect(validateRequirementsMatch(accepted, stored)).toContain("Network mismatch");
  });

  it("should detect asset mismatch", () => {
    const accepted = makeRequirements({ asset: "0x" + "AB".repeat(20) });
    expect(validateRequirementsMatch(accepted, stored)).toContain("Asset mismatch");
  });

  it("should detect payTo mismatch", () => {
    const accepted = makeRequirements({ payTo: "0x" + "CD".repeat(20) });
    expect(validateRequirementsMatch(accepted, stored)).toContain("PayTo mismatch");
  });

  it("should detect amount too low", () => {
    const accepted = makeRequirements({ amount: "100" });
    expect(validateRequirementsMatch(accepted, stored)).toContain("Amount too low");
  });
});
