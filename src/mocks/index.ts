/**
 * Mock data — re-exports all mocks for convenient single-import usage.
 *
 * @example
 * ```ts
 * import {
 *   mockGatewayConfig,
 *   signEIP3009Payload,
 *   mockChainReader,
 *   mockBroadcastFn,
 * } from "./mocks/index.js";
 * ```
 */

// Wallets
export {
  buyerWallet,
  facilitatorWallet,
  BUYER_ADDRESS,
  FACILITATOR_ADDRESS,
  BUYER_PRIVATE_KEY,
  FACILITATOR_PRIVATE_KEY,
} from "./mock-wallets.js";

// Config
export {
  mockGatewayConfig,
  mockFastPollConfig,
  DESTINATION_PRESETS,
  CHAIN_ID,
  NETWORK,
  USDC_ADDRESS,
  TOKEN_NAME,
  TOKEN_VERSION,
  ORIGIN_ASSET_IN,
} from "./mock-config.js";

// x402 payloads (with real EIP-712 signatures)
export {
  mockPaymentRequirements,
  signEIP3009Payload,
  signPermit2Payload,
} from "./mock-x402-payloads.js";

// 1CS API responses
export {
  MOCK_DEPOSIT_ADDRESS,
  mockSwapInputs,
  mockQuoteResponse,
  mockDepositNotifyResponse,
  mockHappyPathStatusSequence,
  mockFailedStatusSequence,
  mockRefundedStatusSequence,
} from "./mock-1cs-responses.js";

// Higher-level fixtures (compose the lower-level mocks)
export {
  mockSwapState,
  mockSwapStateInPhase,
  mockProtectedRoute,
} from "./mock-fixtures.js";

// Chain reader (verifier dependency)
export {
  mockChainReader,
} from "./mock-chain-reader.js";
export type { MockChainReaderOptions } from "./mock-chain-reader.js";

// Settler dependencies
export {
  MOCK_TX_HASH,
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
} from "./mock-settler-deps.js";
export type {
  MockBroadcastOptions,
  MockDepositNotifyOptions,
  MockStatusPollOptions,
} from "./mock-settler-deps.js";
