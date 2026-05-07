/**
 * x402 Middleware — Express middleware wiring quote-engine → verifier → settler.
 *
 * Implements the full x402 HTTP flow as an Express middleware for the
 * swap-as-resource service:
 *
 * 1. **No PAYMENT-SIGNATURE header** → parse + Zod-validate buyer's query
 *    string → call Quote Engine → return 402 with `PAYMENT-REQUIRED` header
 *    containing the `PaymentRequired` envelope.
 * 2. **PAYMENT-SIGNATURE present** → decode → look up SwapState by deposit
 *    address (the buyer's `swapInputs` are already persisted there from
 *    the QUOTED phase, so the query string on retry is informational only):
 *    - Not found → return fresh 402 (re-parse + re-validate query)
 *    - Expired → delete stale state, return fresh 402
 *    - Already SETTLED → attach state to req, return cached 200 + PAYMENT-RESPONSE
 *    - QUOTED → call Verifier → on success → call Settler → attach state →
 *      return 200
 * 3. Errors → appropriate HTTP status + PAYMENT-RESPONSE where applicable.
 *
 * Internal design notes (cross-referenced in body comments):
 * - **D-M1**: Uses `@x402/core/http` for header encoding/decoding
 * - **D-M2**: Custom middleware (not `x402HTTPResourceServer`) — we are the facilitator
 * - **D-M3**: Empty body `{}` for 402 responses (body shape unspecified by x402)
 * - **D-M4**: Single `accepts` entry
 * - **D-M5**: Awaits full cross-chain settlement before calling next()
 * - **D-M6**: Expired quotes → fresh 402
 *
 * @module middleware
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, SettleResponse, Network } from "@x402/core/types";
import type { GatewayConfig } from "../infra/config.js";
import type {
  StateStore,
  PaymentPayloadRecord,
  SwapRequestInput,
  SwapState,
} from "../types.js";
import { GatewayError, InvalidInputError } from "../types.js";
import { buildPaymentRequirements } from "../payment/quote-engine.js";
import type { QuoteFn } from "../payment/quote-engine.js";
import { verifyPayment } from "../payment/verifier.js";
import type { ChainReader } from "../payment/verifier.js";
import { settlePayment } from "../payment/settler.js";
import type {
  BroadcastFn,
  DepositNotifyFn,
  StatusPollFn,
  SettlerOptions,
} from "../payment/settler.js";
import type {
  QuoteRateLimiter,
  SettlementLimiter,
} from "../infra/rate-limiter.js";
import type { ProtectedRoute } from "./protected-routes.js";

// ═══════════════════════════════════════════════════════════════════════
// Express request augmentation
// ═══════════════════════════════════════════════════════════════════════

declare module "express-serve-static-core" {
  interface Request {
    /**
     * SwapState attached by the middleware after the buyer's payment has
     * been verified, broadcast, and 1CS reports SUCCESS. The route handler
     * (`buildSwapHandler`) reads this to build the receipt body.
     */
    swapState?: SwapState;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dependencies injected into the middleware.
 *
 * All external I/O is abstracted behind these interfaces, matching the
 * injectable pattern established in the verifier and settler modules.
 */
export interface MiddlewareDeps {
  /** Gateway configuration. */
  cfg: GatewayConfig;
  /** State persistence layer. */
  store: StateStore;
  /** On-chain reader for verifier balance/allowance checks. */
  chainReader: ChainReader;
  /** On-chain transaction broadcaster. */
  broadcastFn: BroadcastFn;
  /** 1CS deposit notification. */
  depositNotifyFn: DepositNotifyFn;
  /** 1CS status poller. */
  statusPollFn: StatusPollFn;
  /**
   * The route descriptor this middleware instance is bound to. Carries the
   * Zod input validator the middleware uses to parse `req.query` before
   * quoting, plus the JSON Schema mirror used by discovery surfaces.
   */
  route: ProtectedRoute;
  /** Injectable 1CS quote function. */
  quoteFn?: QuoteFn;
  /** Settler tuning options. */
  settlerOptions?: SettlerOptions;
  /**
   * Resource description for the x402 PaymentRequired envelope.
   * @default { url: req.originalUrl }
   */
  resourceDescription?: string;
  /** Per-IP rate limiter for quote (402) generation. */
  quoteLimiter?: QuoteRateLimiter;
  /** Concurrent settlement limiter. */
  settlementLimiter?: SettlementLimiter;
}

// ═══════════════════════════════════════════════════════════════════════
// Middleware factory
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an Express middleware that implements the x402 payment flow.
 *
 * Attach this middleware to the swap route:
 *
 * ```ts
 * const x402 = createX402Middleware({ ...deps, route });
 * app.get(route.path, x402, route.handler);
 * ```
 *
 * When a client requests the protected route:
 * - Without payment → parse query → 402 with `PAYMENT-REQUIRED` header
 * - With valid payment → settlement → 200 with `PAYMENT-RESPONSE` header + next()
 *
 * @param deps Injected dependencies (config, store, chain reader, broadcaster, route, etc.)
 * @returns Express middleware function
 */
export function createX402Middleware(deps: MiddlewareDeps): RequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handleX402Request(req, res, next, deps);
    } catch (err) {
      handleError(res, err);
    }
  }) as RequestHandler;
}

// ═══════════════════════════════════════════════════════════════════════
// Core request handler
// ═══════════════════════════════════════════════════════════════════════

/**
 * Process an incoming request through the x402 payment flow.
 */
async function handleX402Request(
  req: Request,
  res: Response,
  next: NextFunction,
  deps: MiddlewareDeps,
): Promise<void> {
  const paymentSignatureHeader = req.headers["payment-signature"] as string | undefined;

  // ── No payment header → return 402 with fresh quote ──────────────
  if (!paymentSignatureHeader) {
    if (deps.quoteLimiter) {
      const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const rl = deps.quoteLimiter.check(clientIp);
      if (!rl.allowed) {
        res.status(429);
        res.setHeader("Retry-After", String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
        res.setHeader("X-RateLimit-Limit", String(rl.limit));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));
        res.json({ error: "RATE_LIMITED", message: "Too many quote requests. Try again later." });
        return;
      }
      res.setHeader("X-RateLimit-Limit", String(rl.limit));
      res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));
    }

    const inputs = parseAndValidateInputs(req, res, deps);
    if (!inputs) return; // 400 already sent by parseAndValidateInputs

    await returnPaymentRequired(req, res, deps, inputs);
    return;
  }

  // ── Decode the buyer's payment payload ────────────────────────────
  let paymentPayload: PaymentPayloadRecord;
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentSignatureHeader) as unknown as PaymentPayloadRecord;
  } catch {
    res.status(400).json({ error: "Invalid PAYMENT-SIGNATURE header" });
    return;
  }

  // ── Look up the swap state ────────────────────────────────────────
  const depositAddress = paymentPayload.accepted?.payTo;
  if (!depositAddress) {
    res.status(400).json({ error: "Payment payload missing accepted.payTo" });
    return;
  }

  const state = await deps.store.get(depositAddress);

  // State not found → re-parse query, return fresh 402.
  if (!state) {
    console.warn(`[x402] State not found for deposit address: ${depositAddress} — returning fresh 402`);
    const inputs = parseAndValidateInputs(req, res, deps);
    if (!inputs) return;
    await returnPaymentRequired(req, res, deps, inputs);
    return;
  }

  // State expired → delete and return fresh 402 (re-parsing the query).
  const quoteDeadline = state.quoteResponse.quote.deadline;
  if (quoteDeadline && Date.now() > new Date(quoteDeadline).getTime()) {
    console.warn(`[x402] Quote expired for ${depositAddress} (deadline: ${quoteDeadline}) — returning fresh 402`);
    await deps.store.delete(depositAddress);
    const inputs = parseAndValidateInputs(req, res, deps);
    if (!inputs) return;
    await returnPaymentRequired(req, res, deps, inputs);
    return;
  }

  // Already settled → attach state and return cached success.
  if (state.phase === "SETTLED" && state.settlementResponse) {
    const settleResponse = toSettleResponse(state.settlementResponse);
    res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    req.swapState = state;
    next();
    return;
  }

  // Already in progress (BROADCASTING, BROADCAST, POLLING) → reject.
  if (state.phase !== "QUOTED") {
    res.status(409).json({
      error: `Swap already in progress (phase: ${state.phase})`,
    });
    return;
  }

  // ── Verify the payment ────────────────────────────────────────────
  const verifyResult = await verifyPayment(
    paymentPayload,
    deps.store,
    deps.chainReader,
    deps.cfg,
  );

  if (!verifyResult.valid) {
    // Verification failed → return 402 with error, re-quoting using the
    // buyer's already-persisted swapInputs (no need to re-parse query).
    console.warn(`[x402] Verification failed for ${depositAddress}: ${verifyResult.error}`);
    const { requirements } = await buildPaymentRequirements(
      deps.cfg,
      deps.store,
      req.originalUrl,
      state.swapInputs,
      deps.quoteFn,
    );

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: verifyResult.error,
      resource: {
        url: req.originalUrl,
        description: deps.resourceDescription,
      },
      accepts: [toPaymentRequirements(requirements)],
    };

    res.status(402);
    res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
    res.json({});
    return;
  }

  // ── Check settlement capacity ──────────────────────────────────────
  if (deps.settlementLimiter && !deps.settlementLimiter.acquire()) {
    res.status(503).json({
      error: "SETTLEMENT_CAPACITY_EXCEEDED",
      message: "Too many settlements in progress. Try again shortly.",
    });
    return;
  }

  // ── Settle the payment ────────────────────────────────────────────
  try {
    const settlementResponse = await settlePayment(
      depositAddress,
      deps.store,
      deps.broadcastFn,
      deps.depositNotifyFn,
      deps.statusPollFn,
      deps.cfg,
      deps.settlerOptions,
    );

    // Reload the now-SETTLED state and attach it for the route handler.
    const finalState = await deps.store.get(depositAddress);

    const settleResponse = toSettleResponse(settlementResponse);
    res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    if (finalState) req.swapState = finalState;
    next();
  } finally {
    deps.settlementLimiter?.release();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Input parsing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse `req.query` against the route's Zod validator. On failure, write a
 * 400 `INVALID_INPUT` response with field-level details and return null.
 * On success, return the typed input.
 *
 * Express parses the query string into a `ParsedQs` (a record of strings or
 * arrays of strings); the validator coerces this into the typed
 * {@link SwapRequestInput}. Unknown keys fail Zod's `additionalProperties:
 * false` shape if present (the schema is closed via `z.object` defaults).
 */
function parseAndValidateInputs(
  req: Request,
  res: Response,
  deps: MiddlewareDeps,
): SwapRequestInput | null {
  const parsed = deps.route.inputValidator.safeParse(req.query);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    // Match the error envelope shape used by `handleError` for
    // `InvalidInputError` (correlationId for log correlation, even though
    // we never logged this one — operators get a stable identifier to
    // quote on support).
    res.status(400).json({
      error: "INVALID_INPUT",
      message: "Request input failed validation.",
      details,
      correlationId: generateCorrelationId(),
    });
    return null;
  }
  return parsed.data as SwapRequestInput;
}

// ═══════════════════════════════════════════════════════════════════════
// 402 response builder
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build and send a 402 Payment Required response with a fresh 1CS quote
 * for the buyer's destination.
 */
async function returnPaymentRequired(
  req: Request,
  res: Response,
  deps: MiddlewareDeps,
  inputs: SwapRequestInput,
): Promise<void> {
  const { requirements } = await buildPaymentRequirements(
    deps.cfg,
    deps.store,
    req.originalUrl,
    inputs,
    deps.quoteFn,
  );

  console.log(
    `[x402] 402 issued for ${req.originalUrl} → deposit=${requirements.payTo}, amount=${requirements.amount}`,
  );

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: req.originalUrl,
      description: deps.resourceDescription,
    },
    accepts: [toPaymentRequirements(requirements)],
  };

  res.status(402);
  res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  res.json({});
}

// ═══════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════

/**
 * Client-safe messages keyed by `GatewayError.code`. Intentionally vague —
 * full details (upstream error bodies, RPC endpoints, wallet balances,
 * stack traces) are logged server-side and identified via the correlation
 * ID included in every error response.
 *
 * **Do not include** internal state (balances, file paths, tx hashes that
 * weren't already visible to the client, upstream error payloads) in any
 * value here.
 */
const CLIENT_SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // Buyer input (400)
  INVALID_INPUT:
    "Request input is invalid. See `details` for the field-level reasons.",

  // Quote / 1CS reachability (503)
  QUOTE_UNAVAILABLE:
    "Unable to obtain a swap quote at this time. Please try again shortly.",
  AUTHENTICATION_ERROR:
    "Gateway cannot authenticate with the swap provider.",
  SERVICE_UNAVAILABLE:
    "Upstream swap service is temporarily unavailable. Please try again shortly.",
  DEADLINE_TOO_SHORT:
    "Quote deadline is too short to complete the payment safely. Please retry.",
  INSUFFICIENT_GAS:
    "Gateway is temporarily unable to process settlements. Please try again shortly.",

  // Settlement (502 / 504)
  SWAP_FAILED:
    "The cross-chain swap failed. If your payment was broadcast, contact the gateway operator with the correlation ID.",
  SWAP_TIMEOUT:
    "Settlement did not complete within the timeout. Contact the gateway operator with the correlation ID if you were charged.",
  BROADCAST_FAILED:
    "Failed to broadcast the payment transaction. Please retry.",
  POLL_FAILED:
    "Failed to observe the swap status after broadcast. Contact the gateway operator with the correlation ID if you were charged.",
  TX_REVERTED:
    "The payment transaction reverted on-chain. Please retry.",
  TX_NOT_MINED:
    "The payment transaction was not mined within the expected time. Contact the gateway operator with the correlation ID if you were charged.",

  // Protocol / payload (4xx, 5xx)
  NONCE_ALREADY_USED:
    "Payment authorization nonce has already been used. Request a fresh quote and sign again.",
  UNKNOWN_PAYLOAD:
    "Payment payload format not recognized.",
  MISSING_SIGNATURE:
    "Payment payload is missing a required signature.",
  STATE_NOT_FOUND:
    "No swap state found for this deposit address.",
  INVALID_PHASE:
    "Swap is not in a state that can be settled.",
  INCOMPLETE_STATE:
    "Swap state is incomplete. Request a fresh quote and sign again.",
});

/** Fallback when a GatewayError carries an unmapped code. */
const DEFAULT_GATEWAY_CLIENT_MESSAGE =
  "Gateway request failed. Contact the gateway operator with the correlation ID.";

/** Generic message returned for any non-GatewayError (500 INTERNAL_ERROR). */
const DEFAULT_INTERNAL_CLIENT_MESSAGE =
  "An unexpected error occurred. Contact the gateway operator with the correlation ID.";

/**
 * Generate a short correlation ID (8 hex chars) used to tie a client-facing
 * error response to the detailed server-side log entry. Short enough to
 * quote verbally, long enough to identify one request among thousands.
 */
function generateCorrelationId(): string {
  return Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
}

/** Map a GatewayError to its client-safe message. */
function clientMessageFor(err: GatewayError): string {
  return CLIENT_SAFE_MESSAGES[err.code] ?? DEFAULT_GATEWAY_CLIENT_MESSAGE;
}

/**
 * Log the full error details server-side for operator debugging.
 *
 * Output goes to stderr via `console.error` and contains:
 *  - ISO timestamp and correlation ID
 *  - HTTP method, path, client IP (as available)
 *  - For `GatewayError`: name, code, HTTP status, and full message
 *  - For any `Error`: name and full message
 *  - For non-Error throws: the stringified value
 *  - The full stack trace (separate log line)
 *
 * This output **must never** reach the HTTP client. Only the correlation
 * ID is echoed back so operators can grep logs on incident reports.
 */
function logServerError(
  correlationId: string,
  req: Request | undefined,
  err: unknown,
): void {
  const timestamp = new Date().toISOString();
  const method = req?.method ?? "-";
  const path = req?.originalUrl ?? "-";
  const ip = req?.ip ?? req?.socket?.remoteAddress ?? "-";
  const prefix = `[x402][error][${timestamp}][cid=${correlationId}] ${method} ${path} from ${ip}`;

  if (err instanceof GatewayError) {
    console.error(
      `${prefix} — ${err.name} (code=${err.code}, httpStatus=${err.httpStatus}): ${err.message}`,
    );
    if (err.context && Object.keys(err.context).length > 0) {
      console.error(
        `[x402][error][cid=${correlationId}] context: ${JSON.stringify(err.context, null, 2)}`,
      );
    }
    if (err.stack) console.error(err.stack);
    return;
  }
  if (err instanceof Error) {
    console.error(`${prefix} — ${err.name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    return;
  }
  console.error(`${prefix} — Non-Error thrown: ${String(err)}`);
}

/**
 * Map errors to appropriate HTTP responses.
 *
 * Gateway errors carry their own `httpStatus`; unknown errors become 500.
 * For settlement failures (502, 504), we include a PAYMENT-RESPONSE header
 * with `success: false` so the client can interpret the failure.
 *
 * `InvalidInputError` (400) carries structured `context.reasons` from the
 * pre-quote validator — surface those in the response so the buyer can
 * see which field is malformed without grepping server logs.
 *
 * All error responses carry a short `correlationId`; the full error (name,
 * message, stack) is logged server-side under that ID so operators can
 * investigate without the client ever seeing internal details.
 */
function handleError(res: Response, err: unknown): void {
  const correlationId = generateCorrelationId();
  logServerError(correlationId, res.req, err);

  if (err instanceof InvalidInputError) {
    const reasons = Array.isArray(err.context?.reasons)
      ? (err.context.reasons as string[])
      : undefined;
    res.status(err.httpStatus).json({
      error: err.code,
      message: clientMessageFor(err),
      details: reasons,
      correlationId,
    });
    return;
  }

  if (err instanceof GatewayError) {
    const status = err.httpStatus;
    const clientMsg = clientMessageFor(err);

    if (status === 502 || status === 504) {
      const failResponse: SettleResponse = {
        success: false,
        errorReason: err.code,
        errorMessage: clientMsg,
        transaction: "",
        network: "" as Network,
      };

      try {
        res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(failResponse));
      } catch {
        // If encoding fails, still send the error response
      }
    }

    res.status(status).json({
      error: err.code,
      message: clientMsg,
      correlationId,
    });
    return;
  }

  // Unknown error — never reveal raw message or stack to the client.
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: DEFAULT_INTERNAL_CLIENT_MESSAGE,
    correlationId,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert our internal `PaymentRequirementsRecord` to the x402 `PaymentRequirements`
 * type. The only difference is `network` — ours is `string`, x402's is a
 * template literal `${string}:${string}`.
 */
function toPaymentRequirements(
  record: import("../types.js").PaymentRequirementsRecord,
): import("@x402/core/types").PaymentRequirements {
  return {
    ...record,
    network: record.network as Network,
  };
}

/**
 * Convert our internal `SettlementResponseRecord` to the x402 `SettleResponse`
 * type expected by `encodePaymentResponseHeader`.
 */
function toSettleResponse(
  record: import("../types.js").SettlementResponseRecord,
): SettleResponse {
  return {
    success: record.success,
    errorReason: record.errorReason,
    errorMessage: record.errorMessage,
    payer: record.payer,
    transaction: record.transaction,
    network: record.network as import("@x402/core/types").Network,
    extensions: record.extra ? { crossChain: record.extra } : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Express app factory (convenience)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a minimal Express app with the x402 middleware mounted on the
 * route from `deps.route`.
 *
 * Useful for testing and simple deployments. For production, mount
 * routes individually using `createX402Middleware()`.
 *
 * ```ts
 * const app = await createGatewayApp(deps, route.handler);
 * ```
 */
export async function createGatewayApp(
  deps: MiddlewareDeps,
  handler: RequestHandler,
): Promise<import("express").Express> {
  const express = await import("express");
  const app = express.default();

  app.use(express.default.json());
  const x402 = createX402Middleware(deps);
  const method = deps.route.method.toLowerCase() as "get" | "post";
  app[method](deps.route.path, x402, handler);

  return app;
}
