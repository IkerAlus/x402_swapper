/**
 * Realistic GatewayConfig for testing.
 *
 * **Origin (buyer pay) side:** Targets Base mainnet USDC — the supported origin chain.
 * **Destination side:** This service is swap-as-resource — the buyer supplies the
 * destination per-request. {@link DESTINATION_PRESETS} provides ready-made buyer
 * destination inputs for parametrized multi-chain tests.
 *
 * All values are plausible production settings, except the private keys
 * and JWT which are test-only.
 */

import type { GatewayConfig } from "../infra/config.js";
import { FACILITATOR_PRIVATE_KEY, FACILITATOR_ADDRESS } from "./mock-wallets.js";

// ═══════════════════════════════════════════════════════════════════════
// Origin chain & token constants (Base mainnet USDC)
// ═══════════════════════════════════════════════════════════════════════

/** CAIP-2 identifier for Base mainnet. */
export const CHAIN_ID = 8453;
export const NETWORK = "eip155:8453";

/** USDC on Base — official contract address. */
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** EIP-712 domain metadata for Base USDC (must match on-chain values). */
export const TOKEN_NAME = "USD Coin";
export const TOKEN_VERSION = "2";

/**
 * 1CS asset identifiers.
 *
 * IMPORTANT: The live 1CS API requires `nep141:` prefixed asset IDs.
 * The short `base:0x...` or `near:nUSDC` format may work in some contexts
 * but the canonical format uses the full NEP-141 token account name.
 *
 * For mocked tests the exact format doesn't matter since we stub the 1CS SDK,
 * but these values mirror what production config should use.
 */
export const ORIGIN_ASSET_IN = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

// ═══════════════════════════════════════════════════════════════════════
// Buyer destination presets (per-request swap inputs)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pre-built buyer destination inputs for parametrized multi-chain tests.
 *
 * Each preset is a ready-to-use `{ destinationChain, destinationAsset,
 * destinationAddress }` triple suitable for splatting into a
 * `SwapRequestInput`. Pair with `amountIn` (and optionally `refundAddress`)
 * at the test site:
 *
 * ```typescript
 * const inputs = { ...DESTINATION_PRESETS.arbitrum, amountIn: "10000000" };
 * ```
 */
export const DESTINATION_PRESETS = {
  near: {
    destinationChain: "near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    destinationAddress: "alice.near",
  },
  arbitrum: {
    destinationChain: "arbitrum",
    destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
  },
  ethereum: {
    destinationChain: "ethereum",
    destinationAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    destinationAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  },
  polygon: {
    destinationChain: "polygon",
    destinationAsset: "nep141:polygon-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omft.near",
    destinationAddress: "0xfedcba9876543210fedcba9876543210fedcba98",
  },
  // Non-EVM destination presets
  stellar: {
    destinationChain: "stellar",
    destinationAsset: "nep141:stellar-GAXYZ1234567890abcdef.omft.near",
    destinationAddress: "GAXYZ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
  },
  solana: {
    destinationChain: "solana",
    destinationAsset: "nep141:solana-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.omft.near",
    destinationAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════
// Mock config
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a complete mock GatewayConfig for the swap service.
 *
 * @param overrides — Partial fields to customize for a specific test.
 */
export function mockGatewayConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    oneClickJwt: "mock-jwt-token-for-testing",
    oneClickBaseUrl: "https://1click.chaindefuser.com",
    originNetwork: NETWORK,
    originAssetIn: ORIGIN_ASSET_IN,
    originTokenAddress: USDC_ADDRESS,
    originRpcUrls: ["https://mainnet.base.org"],
    facilitatorPrivateKey: FACILITATOR_PRIVATE_KEY,
    gatewayRefundAddress: FACILITATOR_ADDRESS,
    operatorMarginBps: 30,           // 0.3% — service-default
    maxPollTimeMs: 300_000,          // 5 minutes
    pollIntervalBaseMs: 2_000,       // 2 seconds
    pollIntervalMaxMs: 30_000,       // 30 seconds
    quoteExpiryBufferSec: 30,
    rateLimitQuotesPerWindow: 20,
    rateLimitWindowMs: 60_000,
    maxConcurrentSettlements: 10,
    quoteGcIntervalMs: 0,            // Disabled in tests
    quoteGcGracePeriodMs: 300_000,
    tokenName: TOKEN_NAME,
    tokenVersion: TOKEN_VERSION,
    tokenSupportsEip3009: true,
    // Discovery defaults for tests: no URL, no proofs — keep the
    // gateway's core-payment tests independent of discovery publication.
    ownershipProofs: [],
    ...overrides,
  };
}

/**
 * Fast-polling config variant — for tests that need polling to complete quickly.
 */
export function mockFastPollConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return mockGatewayConfig({
    pollIntervalBaseMs: 1,
    pollIntervalMaxMs: 5,
    maxPollTimeMs: 5_000,
    ...overrides,
  });
}
