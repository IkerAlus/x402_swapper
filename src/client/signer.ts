/**
 * Payment Signer — produces EIP-712 signed payloads for x402 payments.
 *
 * This module handles the cryptographic signing step of the x402 protocol.
 * Given a set of payment requirements (from the 402 response), it constructs
 * the correct EIP-712 typed data and signs it with the buyer's wallet.
 *
 * Supports two asset transfer methods:
 * - **EIP-3009** (`transferWithAuthorization`) — gasless, preferred
 * - **Permit2** (`permitWitnessTransferFrom`) — requires prior on-chain approval
 *
 * @module client/signer
 */

import { ethers } from "ethers";
import {
  authorizationTypes,
  permit2WitnessTypes,
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
} from "@x402/evm";
import type {
  PaymentRequirements,
  PaymentPayload,
  EIP3009Authorization,
  Permit2Authorization,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sign a payment for the given requirements using the buyer's wallet.
 *
 * Automatically selects the signing method based on
 * `requirements.extra.assetTransferMethod`.
 *
 * @param wallet       The buyer's ethers.js Wallet (must have a private key).
 * @param requirements The payment requirements from the 402 response.
 * @param resourceUrl  The resource URL (included in the payload envelope).
 * @returns A fully constructed PaymentPayload ready for base64 encoding.
 */
export async function signPayment(
  wallet: ethers.Wallet,
  requirements: PaymentRequirements,
  resourceUrl?: string,
): Promise<PaymentPayload> {
  const method = requirements.extra.assetTransferMethod;

  if (method === "eip3009") {
    return signEIP3009(wallet, requirements, resourceUrl);
  } else if (method === "permit2") {
    return signPermit2(wallet, requirements, resourceUrl);
  } else {
    throw new Error(`Unsupported asset transfer method: ${String(method)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// EIP-3009 signing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sign an EIP-3009 `TransferWithAuthorization` for the given requirements.
 *
 * The authorization allows the gateway's facilitator to call
 * `transferWithAuthorization` on the token contract, moving USDC
 * from the buyer's wallet to the 1CS deposit address.
 */
export async function signEIP3009(
  wallet: ethers.Wallet,
  requirements: PaymentRequirements,
  resourceUrl?: string,
): Promise<PaymentPayload> {
  const chainId = extractChainId(requirements.network);
  const nowSec = Math.floor(Date.now() / 1000);

  // Build the authorization struct
  const authorization: EIP3009Authorization = {
    from: wallet.address,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: "0",
    validBefore: String(nowSec + requirements.maxTimeoutSeconds),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };

  // EIP-712 domain — must match the on-chain token contract
  const domain: ethers.TypedDataDomain = {
    name: requirements.extra.name,
    version: requirements.extra.version,
    chainId,
    verifyingContract: requirements.asset,
  };

  // EIP-712 types from the @x402/evm SDK
  const types = {
    TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
      (f) => ({ name: f.name, type: f.type }),
    ),
  };

  // The message to sign
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    x402Version: 2,
    ...(resourceUrl ? { resource: { url: resourceUrl } } : {}),
    accepted: requirements,
    payload: { signature, authorization },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Permit2 signing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sign a Permit2 `PermitWitnessTransferFrom` for the given requirements.
 *
 * The buyer must have previously approved the Permit2 contract
 * (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend their tokens.
 */
export async function signPermit2(
  wallet: ethers.Wallet,
  requirements: PaymentRequirements,
  resourceUrl?: string,
): Promise<PaymentPayload> {
  const chainId = extractChainId(requirements.network);
  const nowSec = Math.floor(Date.now() / 1000);

  const permit2Authorization: Permit2Authorization = {
    from: wallet.address,
    permitted: {
      token: requirements.asset,
      amount: requirements.amount,
    },
    spender: x402ExactPermit2ProxyAddress,
    nonce: String(Math.floor(Math.random() * 1_000_000)),
    deadline: String(nowSec + requirements.maxTimeoutSeconds),
    witness: {
      to: requirements.payTo,
      validAfter: "0",
    },
  };

  // Permit2 has a fixed EIP-712 domain
  const domain: ethers.TypedDataDomain = {
    name: "Permit2",
    verifyingContract: PERMIT2_ADDRESS,
    chainId,
  };

  // EIP-712 types from the @x402/evm SDK
  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [key, fields] of Object.entries(permit2WitnessTypes)) {
    types[key] = fields.map((f: { name: string; type: string }) => ({
      name: f.name,
      type: f.type,
    }));
  }

  // The message to sign
  const message = {
    permitted: permit2Authorization.permitted,
    spender: permit2Authorization.spender,
    nonce: permit2Authorization.nonce,
    deadline: permit2Authorization.deadline,
    witness: permit2Authorization.witness,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    x402Version: 2,
    ...(resourceUrl ? { resource: { url: resourceUrl } } : {}),
    accepted: requirements,
    payload: { signature, permit2Authorization },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract the numeric chain ID from a CAIP-2 network string.
 *
 * @example extractChainId("eip155:8453") → 8453
 */
export function extractChainId(network: string): number {
  const parts = network.split(":");
  if (parts.length !== 2 || parts[0] !== "eip155") {
    throw new Error(
      `Unsupported network format: ${network}. Expected eip155:<chainId>`,
    );
  }
  const chainId = parseInt(parts[1]!, 10);
  if (isNaN(chainId)) {
    throw new Error(`Invalid chain ID in network: ${network}`);
  }
  return chainId;
}
