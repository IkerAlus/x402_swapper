/**
 * Deterministic test wallets for reproducible mock data.
 *
 * These wallets use fixed private keys so that generated signatures
 * are deterministic across test runs. NEVER use these keys for real funds.
 */

import { ethers } from "ethers";

// ═══════════════════════════════════════════════════════════════════════
// Private keys — deterministic, NOT FOR PRODUCTION
// ═══════════════════════════════════════════════════════════════════════

/** Buyer's private key — the wallet that signs x402 payment authorizations. */
export const BUYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Facilitator's private key — the gateway wallet that broadcasts on-chain txs. */
export const FACILITATOR_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// ═══════════════════════════════════════════════════════════════════════
// Wallet instances
// ═══════════════════════════════════════════════════════════════════════

/** Buyer wallet — used to sign EIP-3009 and Permit2 payloads. */
export const buyerWallet = new ethers.Wallet(BUYER_PRIVATE_KEY);

/** Facilitator wallet — used for gas checks and broadcasting. */
export const facilitatorWallet = new ethers.Wallet(FACILITATOR_PRIVATE_KEY);

/** Buyer's checksummed address. */
export const BUYER_ADDRESS = buyerWallet.address;

/** Facilitator's checksummed address. */
export const FACILITATOR_ADDRESS = facilitatorWallet.address;
