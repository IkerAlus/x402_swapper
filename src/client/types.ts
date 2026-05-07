/**
 * Client-side type definitions for interacting with an x402-1CS gateway.
 *
 * These types describe the HTTP protocol from the buyer's perspective:
 * the 402 response envelope, payment requirements, signed payloads,
 * and settlement receipts.
 *
 * @module client/types
 */

// ═══════════════════════════════════════════════════════════════════════
// 402 Response — PaymentRequired envelope
// ═══════════════════════════════════════════════════════════════════════

/**
 * The decoded `PAYMENT-REQUIRED` header from a 402 response.
 * This is the top-level envelope that the gateway sends to the buyer.
 */
export interface PaymentRequired {
  x402Version: number;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepts: PaymentRequirements[];
  error?: string;
  extensions?: Record<string, unknown>;
}

/**
 * A single payment option from the `accepts` array.
 * The buyer picks one, signs it, and sends it back.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    assetTransferMethod: AssetTransferMethod;
    [key: string]: unknown;
  };
}

/** Supported EVM asset transfer methods. */
export type AssetTransferMethod = "eip3009" | "permit2";

// ═══════════════════════════════════════════════════════════════════════
// Signed Payment Payload (PAYMENT-SIGNATURE)
// ═══════════════════════════════════════════════════════════════════════

/**
 * The payload sent in the `PAYMENT-SIGNATURE` header.
 * Contains the accepted requirements and the buyer's cryptographic proof.
 */
export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: EIP3009SignedPayload | Permit2SignedPayload;
  extensions?: Record<string, unknown>;
}

/**
 * EIP-3009 `transferWithAuthorization` signed payload.
 */
export interface EIP3009SignedPayload {
  signature: string;
  authorization: EIP3009Authorization;
}

/**
 * The EIP-3009 authorization fields that get signed via EIP-712.
 */
export interface EIP3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Permit2 `permitWitnessTransferFrom` signed payload.
 */
export interface Permit2SignedPayload {
  signature: string;
  permit2Authorization: Permit2Authorization;
}

/**
 * Permit2 authorization fields that get signed via EIP-712.
 */
export interface Permit2Authorization {
  from: string;
  permitted: {
    token: string;
    amount: string;
  };
  spender: string;
  nonce: string;
  deadline: string;
  witness: {
    to: string;
    validAfter: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Settlement Response (PAYMENT-RESPONSE)
// ═══════════════════════════════════════════════════════════════════════

/**
 * The decoded `PAYMENT-RESPONSE` header from a successful 200 or failed 502/504.
 */
export interface PaymentResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: {
    crossChain?: CrossChainSettlement;
    [key: string]: unknown;
  };
}

/**
 * Cross-chain settlement metadata from the 1CS swap.
 */
export interface CrossChainSettlement {
  settlementType: "crosschain-1cs";
  destinationTxHashes?: Array<{ hash: string; explorerUrl: string }>;
  destinationChain?: string;
  destinationAmount?: string;
  destinationAsset?: string;
  swapStatus: string;
  correlationId?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Client Configuration
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configuration for the x402 client.
 */
export interface X402ClientConfig {
  /** Base URL of the gateway (e.g. "http://localhost:3402"). */
  gatewayUrl: string;

  /**
   * Custom fetch implementation. Defaults to the global `fetch`.
   * Useful for testing or environments without native fetch.
   */
  fetch?: typeof globalThis.fetch;
}

// ═══════════════════════════════════════════════════════════════════════
// Client Result Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Result of requesting a protected resource (step 1 of the protocol).
 * Uses a `kind` discriminant for reliable type narrowing.
 */
export type ResourceRequestResult =
  | {
      kind: "payment-required";
      status: 402;
      paymentRequired: PaymentRequired;
    }
  | {
      kind: "success";
      status: 200;
      body: unknown;
      paymentResponse?: PaymentResponse;
    }
  | {
      kind: "error";
      status: number;
      error: string;
      body?: unknown;
    };

/**
 * Result of submitting a signed payment (step 4 of the protocol).
 */
export type PaymentResult =
  | {
      success: true;
      status: 200;
      body: unknown;
      paymentResponse: PaymentResponse;
    }
  | {
      success: false;
      status: number;
      error: string;
      paymentResponse?: PaymentResponse;
    };

/**
 * Full end-to-end result of the pay-and-fetch flow.
 */
export type PayAndFetchResult =
  | {
      success: true;
      body: unknown;
      paymentResponse?: PaymentResponse;
      paymentRequired: PaymentRequired;
    }
  | {
      success: false;
      error: string;
      status: number;
      paymentRequired?: PaymentRequired;
      paymentResponse?: PaymentResponse;
    };
