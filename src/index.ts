/**
 * x402-1CS Gateway — public library surface.
 *
 * Pure barrel file: re-exports every named symbol consumers need. No
 * runtime side effects — importing this module will NOT load config,
 * open network connections, or exit the process.
 *
 * The runnable HTTP gateway lives in `src/server.ts` and is started via
 * `npx env-cmd npx tsx src/server.ts` (see `README.md` § "Start the
 * gateway"). Library consumers import types and helpers from here and
 * wire up their own runtime.
 */

// ── Configuration ───────────────────────────────────────────────────
export { GatewayConfigSchema, loadConfigFromEnv } from "./infra/config.js";
export type { GatewayConfig } from "./infra/config.js";

// ── Types ───────────────────────────────────────────────────────────
export * from "./types.js";

// ── State Store ─────────────────────────────────────────────────────
export {
  SqliteStateStore,
  InMemoryStateStore,
  createStateStore,
  validatePhaseTransition,
  StateNotFoundError,
  InvalidPhaseTransitionError,
} from "./storage/store.js";
export type { SqliteStoreOptions, CreateStoreOptions } from "./storage/store.js";

// ── Quote Engine ────────────────────────────────────────────────────
export {
  buildPaymentRequirements,
  defaultQuoteFn,
  configureOneClickSdk,
  buildQuoteDeadline,
  buildSwapQuoteRequest,
  applyOperatorMargin,
  validateBuyerDestination,
  validateDeadline,
  mapToPaymentRequirements,
  computeMaxTimeoutSeconds,
  toQuoteResponseRecord,
  diagnoseQuoteRequest,
} from "./payment/quote-engine.js";
export type { BuildPaymentRequirementsResult, QuoteFn, QuoteRequestShape } from "./payment/quote-engine.js";

// ── Protected Routes ────────────────────────────────────────────────
export {
  PROTECTED_ROUTES,
  validateProtectedRoute,
  validateProtectedRoutes,
  buildProtectedRoutes,
  buildSwapHandler,
} from "./http/protected-routes.js";
export type {
  ProtectedRoute,
  ProtectedMethod,
  RoutePricing,
  SwapPricing,
  RequestWithSwapState,
} from "./http/protected-routes.js";

// ── Swap Input ──────────────────────────────────────────────────────
export {
  SwapRequestInputSchema,
  SwapRequestInputJsonSchema,
} from "./http/swap-input.js";

// ── Verifier ────────────────────────────────────────────────────────
export {
  verifyPayment,
  extractChainId,
  validateRequirementsMatch,
  createChainReader,
} from "./payment/verifier.js";
export type { VerifyResult, ChainReader, VerifierOptions } from "./payment/verifier.js";

// ── Settler ─────────────────────────────────────────────────────────
export {
  settlePayment,
  pollUntilTerminal,
  buildSettlementResponse,
  buildCrossChainSettlementExtra,
  extractDestinationChain,
  createBroadcastFn,
  createDepositNotifyFn,
  createStatusPollFn,
} from "./payment/settler.js";
export type {
  BroadcastFn,
  BroadcastResult,
  DepositNotifyFn,
  DepositNotifyResult,
  StatusPollFn,
  StatusPollResult,
  GasOptions,
  SettlerOptions,
} from "./payment/settler.js";

// ── Middleware ──────────────────────────────────────────────────────
export { createX402Middleware, createGatewayApp } from "./http/middleware.js";
export type { MiddlewareDeps } from "./http/middleware.js";

// ── Provider Pool ──────────────────────────────────────────────────
export { ProviderPool } from "./infra/provider-pool.js";
export type { ProviderPoolOptions } from "./infra/provider-pool.js";
