/**
 * x402 Client — public API.
 *
 * @example
 * ```ts
 * import { X402Client, signPayment } from "./client/index.js";
 * ```
 *
 * @module client
 */

// Main client class
export { X402Client } from "./x402-client.js";

// Signing utilities (for advanced / step-by-step usage)
export {
  signPayment,
  signEIP3009,
  signPermit2,
  extractChainId,
} from "./signer.js";

// Types
export type {
  // Config
  X402ClientConfig,
  // Protocol types
  PaymentRequired,
  PaymentRequirements,
  AssetTransferMethod,
  PaymentPayload,
  PaymentResponse,
  CrossChainSettlement,
  // Signing types
  EIP3009SignedPayload,
  EIP3009Authorization,
  Permit2SignedPayload,
  Permit2Authorization,
  // Result types
  ResourceRequestResult,
  PaymentResult,
  PayAndFetchResult,
} from "./types.js";
