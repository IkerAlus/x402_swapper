/**
 * Quote Engine — translates 1CS quotes into x402 PaymentRequirements.
 *
 * Translation layer between the NEAR Intents 1Click Swap API and the x402
 * payment protocol for the swap-as-resource service. It:
 *
 * 1. Validates the buyer's destination format against the destination chain
 * 2. Calls `POST /v0/quote` with `swapType: EXACT_INPUT` and the buyer's
 *    destination + amount + (optional) refund address
 * 3. Applies the operator margin to the 1CS-quoted `amountIn`
 * 4. Maps the 1CS response into an x402 `PaymentRequirements` object
 *    (with `payTo = depositAddress`, the foundational trick)
 * 5. Persists a new `SwapState` (phase = QUOTED) keyed by the deposit address
 * 6. Returns both for the middleware to build the 402 response
 *
 * Slippage upside flows to the buyer (EXACT_INPUT semantics): the destination
 * amount becomes the variable, the buyer's signed authorisation is locked
 * to the exact `amountIn`. The operator earns the configured margin on top
 * of 1CS's quote — surfaced transparently in `extra.crossChain.operatorFee`.
 */

import type { GatewayConfig } from "../infra/config.js";
import type { QuoteResponse, SwapRequestInput } from "../types.js";
import {
  OneClickService,
  OpenAPI,
  OneClickApiError,
  QuoteRequest,
} from "../types.js";
import type {
  PaymentRequirementsRecord,
  QuoteResponseRecord,
  SwapState,
  StateStore,
  AssetTransferMethod,
  CrossChainQuoteExtra,
} from "../types.js";
import {
  QuoteUnavailableError,
  AuthenticationError,
  ServiceUnavailableError,
  DeadlineTooShortError,
  InvalidInputError,
  GatewayError,
} from "../types.js";
import type { ErrorContext } from "../types.js";
import {
  EVM_CHAIN_PREFIXES,
  NON_EVM_CHAIN_PREFIXES,
  extractChainPrefix,
  isValidNearAccount,
  isNearNativeAsset,
} from "./chain-prefixes.js";

/**
 * Referral tag passed to every 1CS `/v0/quote` request so x402 indexers
 * (e.g. x402scan) can attribute on-chain settlements that originate from
 * this gateway. Constant by design — every quote we issue carries it.
 */
const ONECLICK_REFERRAL = "x402-test";

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/** Result of a successful quote-to-requirements build. */
export interface BuildPaymentRequirementsResult {
  /** The x402 PaymentRequirements to include in the 402 response. */
  requirements: PaymentRequirementsRecord;
  /** The SwapState that was persisted to the store (phase = QUOTED). */
  state: SwapState;
}

/**
 * Function signature for requesting a 1CS quote.
 *
 * In production this delegates to `OneClickService.getQuote`; in tests
 * it can be replaced with a stub to avoid real HTTP calls.
 */
export type QuoteFn = (
  request: Parameters<typeof OneClickService.getQuote>[0],
) => Promise<QuoteResponse>;

/** Default production implementation — calls the real 1CS SDK. */
export const defaultQuoteFn: QuoteFn = (request) =>
  OneClickService.getQuote(request);

/**
 * Build an x402 `PaymentRequirements` object by requesting a 1CS quote
 * for the buyer's destination.
 *
 * Configures the 1CS SDK, validates the buyer's destination format, calls
 * `/v0/quote` with EXACT_INPUT, applies the operator margin, maps the
 * response to x402 fields, persists the new SwapState, and returns both.
 *
 * @param cfg          Validated gateway configuration.
 * @param store        State persistence layer.
 * @param _resourceUrl The URL of the protected resource (reserved for logging/tracing).
 * @param inputs       Buyer-supplied destination params from the parsed query string.
 * @param quoteFn      Injectable quote function (defaults to real 1CS SDK call).
 *
 * @throws {InvalidInputError}       Buyer's destination/recipient combination is malformed (400)
 * @throws {QuoteUnavailableError}   1CS returned 400 (bad asset pair, etc.) (503)
 * @throws {AuthenticationError}     1CS returned 401 (JWT expired/invalid) (503)
 * @throws {ServiceUnavailableError} 1CS returned 5xx or network error (503)
 * @throws {DeadlineTooShortError}   Quote deadline leaves < quoteExpiryBufferSec (503)
 */
export async function buildPaymentRequirements(
  cfg: GatewayConfig,
  store: StateStore,
  _resourceUrl: string,
  inputs: SwapRequestInput,
  quoteFn: QuoteFn = defaultQuoteFn,
): Promise<BuildPaymentRequirementsResult> {
  // ── 1. Configure the 1CS SDK ──────────────────────────────────────
  configureOneClickSdk(cfg);

  // ── 2. Hard-fail on chain-format mismatches before quoting ────────
  //    Catches the common "EVM destination + NEAR address" class of bugs
  //    before paying for an upstream quote. Returns 400 INVALID_INPUT.
  validateBuyerDestination(inputs);

  // ── 3. Build + send the quote request ─────────────────────────────
  const deadline = buildQuoteDeadline(cfg);
  const quoteRequest = buildSwapQuoteRequest(cfg, inputs, deadline);
  const quoteResponse = await requestQuote(quoteRequest, quoteFn);

  // ── 4. Validate the response ──────────────────────────────────────
  const depositAddress = quoteResponse.quote.depositAddress;
  if (!depositAddress) {
    throw new QuoteUnavailableError(
      "1CS quote response missing depositAddress",
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(depositAddress)) {
    throw new QuoteUnavailableError(
      `1CS quote returned invalid depositAddress: "${depositAddress}"`,
    );
  }

  const amountIn = quoteResponse.quote.amountIn;
  if (!amountIn || amountIn === "0") {
    throw new QuoteUnavailableError(
      `1CS quote returned invalid amountIn: "${amountIn ?? "undefined"}"`,
    );
  }

  validateDeadline(quoteResponse, cfg);

  // ── 5. Apply operator margin ──────────────────────────────────────
  const margin = applyOperatorMargin(amountIn, cfg.operatorMarginBps);

  // ── 6. Map to x402 PaymentRequirements ────────────────────────────
  const requirements = mapToPaymentRequirements(quoteResponse, cfg, inputs, margin);

  // ── 7. Persist SwapState ──────────────────────────────────────────
  const now = Date.now();
  const state: SwapState = {
    depositAddress,
    swapInputs: inputs,
    operatorMarginBps: cfg.operatorMarginBps,
    quoteResponse: toQuoteResponseRecord(quoteResponse),
    paymentRequirements: requirements,
    phase: "QUOTED",
    createdAt: now,
    updatedAt: now,
  };

  await store.create(depositAddress, state);

  return { requirements, state };
}

// ═══════════════════════════════════════════════════════════════════════
// Internal helpers (exported for unit testing where noted)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configure the global 1CS SDK settings (base URL + JWT).
 *
 * The SDK uses a mutable singleton (`OpenAPI`) for config, so we set it
 * before each call. This is safe in a single-process gateway.
 */
export function configureOneClickSdk(cfg: GatewayConfig): void {
  OpenAPI.BASE = cfg.oneClickBaseUrl;
  OpenAPI.TOKEN = cfg.oneClickJwt;
}

/**
 * Compute an ISO-8601 deadline for the 1CS quote.
 *
 * We use the configured `maxPollTimeMs` plus a generous buffer so the
 * deposit address stays active long enough for the full settlement flow.
 * The deadline is the point after which 1CS will refund unmatched deposits.
 */
export function buildQuoteDeadline(cfg: GatewayConfig): string {
  // Give enough time for: buyer signing + on-chain tx + polling
  // Use maxPollTimeMs as the primary budget, add 2 minutes for signing + broadcast
  const deadlineMs = Date.now() + cfg.maxPollTimeMs + 120_000;
  return new Date(deadlineMs).toISOString();
}

/**
 * Construct the 1CS QuoteRequest for a swap-as-resource flow.
 *
 * Key design decisions:
 * - `swapType: EXACT_INPUT` — buyer signs for an exact `amountIn`; slippage
 *   upside on the destination amount accrues to the buyer (D2 in plan).
 * - `dry: false` — we need a real deposit address.
 * - `refundTo: inputs.refundAddress ?? cfg.gatewayRefundAddress` — buyer's
 *   per-request refund target wins; gateway address is the fallback (D6).
 * - `depositType: ORIGIN_CHAIN` — the buyer deposits on the EVM origin chain.
 * - `recipientType: DESTINATION_CHAIN` — buyer receives on the destination chain
 *   they specified. (`INTENTS` would park funds inside NEAR Intents, which
 *   is not a use case for this product.)
 */
export function buildSwapQuoteRequest(
  cfg: GatewayConfig,
  inputs: SwapRequestInput,
  deadline: string,
): Parameters<typeof OneClickService.getQuote>[0] {
  return {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: 50, // 0.5% — reasonable default for stablecoins
    originAsset: cfg.originAssetIn,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: inputs.destinationAsset,
    amount: inputs.amountIn,
    refundTo: inputs.refundAddress ?? cfg.gatewayRefundAddress,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: inputs.destinationAddress,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline,
    referral: ONECLICK_REFERRAL,
  };
}

/**
 * Apply the operator margin (basis points) to the 1CS-quoted `amountIn`.
 *
 * Returns both the new amount the buyer signs for and the margin amount in
 * isolation, so the receipt and `extra.crossChain.operatorFee` can surface
 * the breakdown to the buyer transparently.
 *
 * Implementation uses BigInt arithmetic to preserve full precision on
 * stablecoin smallest-unit values (USDC has 6 decimals; uint256 fits).
 */
export function applyOperatorMargin(
  amountIn: string,
  bps: number,
): { amountWithMargin: string; marginAmount: string } {
  if (bps < 0 || bps > 1000 || !Number.isInteger(bps)) {
    throw new Error(`operatorMarginBps out of range: ${bps}`);
  }
  const base = BigInt(amountIn);
  const margin = (base * BigInt(bps)) / 10000n;
  return {
    amountWithMargin: (base + margin).toString(),
    marginAmount: margin.toString(),
  };
}

/**
 * Hard-fail on buyer-destination format mismatches before sending a quote
 * request to 1CS. Catches the common "EVM destination chain + NEAR-format
 * recipient" class of bugs and returns a structured 400 instead of relying
 * on 1CS to reject (which surfaces as 503 with a less actionable message).
 *
 * Reuses the chain-prefix helpers from {@link ../payment/chain-prefixes.js}.
 * The unknown-prefix case is a warning (the buyer may know about a chain
 * we don't recognise yet); only true mismatches fail.
 */
export function validateBuyerDestination(inputs: SwapRequestInput): void {
  const { destinationAsset, destinationAddress } = inputs;
  const prefix = extractChainPrefix(destinationAsset);
  const isEvmRecipient = /^0x[a-fA-F0-9]{40}$/.test(destinationAddress);

  const reasons: string[] = [];

  if (prefix !== null && EVM_CHAIN_PREFIXES.includes(prefix)) {
    if (!isEvmRecipient) {
      reasons.push(
        `destinationAddress "${destinationAddress}" is not an EVM address (0x + 40 hex) but destinationAsset targets ${prefix}`,
      );
    }
  } else if (prefix !== null && NON_EVM_CHAIN_PREFIXES.includes(prefix)) {
    if (isEvmRecipient) {
      reasons.push(
        `destinationAddress "${destinationAddress}" looks like an EVM address but destinationAsset targets ${prefix}`,
      );
    }
  } else if (isNearNativeAsset(destinationAsset)) {
    if (isEvmRecipient) {
      reasons.push(
        `destinationAddress "${destinationAddress}" looks like an EVM address but destinationAsset is NEAR-native`,
      );
    } else if (!isValidNearAccount(destinationAddress)) {
      reasons.push(
        `destinationAddress "${destinationAddress}" is not a valid NEAR account ('.near'/'.tg' suffix or 64-char implicit)`,
      );
    }
  }
  // Unknown prefix → let 1CS validate; we don't reject what we don't understand.

  if (reasons.length > 0) {
    throw new InvalidInputError(
      `Buyer destination format mismatch: ${reasons.join("; ")}`,
      { reasons, destinationAsset, destinationAddress },
    );
  }
}

/**
 * Call the 1CS `/v0/quote` endpoint, mapping SDK errors to gateway errors.
 *
 * Every thrown error carries a server-side `context` bag (quote fields +
 * diagnosis hints) so operators can tell a recipient typo from a transient
 * upstream outage without grepping multiple logs. The client-facing path
 * never sees this context — it's consumed only by `logServerError`.
 */
async function requestQuote(
  quoteRequest: Parameters<typeof OneClickService.getQuote>[0],
  quoteFn: QuoteFn,
): Promise<QuoteResponse> {
  try {
    return await quoteFn(quoteRequest);
  } catch (err: unknown) {
    // Pass through GatewayErrors untouched — an injected quoteFn (or a
    // future wrapper) may have already produced a structured error we
    // shouldn't obscure by re-wrapping as a network failure.
    if (err instanceof GatewayError) {
      throw err;
    }
    if (err instanceof OneClickApiError) {
      const ctx = buildQuoteDiagnosticContext(quoteRequest, err.status);
      switch (err.status) {
        case 400:
          throw new QuoteUnavailableError(
            `1CS quote rejected (400): ${extractErrorMessage(err)}`,
            ctx,
          );
        case 401:
          throw new AuthenticationError(
            `1CS authentication failed (401): ${extractErrorMessage(err)}`,
            ctx,
          );
        default:
          if (err.status >= 500) {
            throw new ServiceUnavailableError(
              `1CS service error (${err.status}): ${extractErrorMessage(err)}`,
              ctx,
            );
          }
          throw new QuoteUnavailableError(
            `1CS unexpected error (${err.status}): ${extractErrorMessage(err)}`,
            ctx,
          );
      }
    }
    // Network error or other non-HTTP failure
    throw new ServiceUnavailableError(
      `1CS unreachable: ${err instanceof Error ? err.message : String(err)}`,
      buildQuoteDiagnosticContext(quoteRequest, "network"),
    );
  }
}

/**
 * Build the `ErrorContext` attached to every quote-related gateway error.
 * Contains the outgoing request fields plus the list of diagnostic hints
 * from {@link diagnoseQuoteRequest} so operators see the likely cause in a
 * single stderr line.
 */
function buildQuoteDiagnosticContext(
  req: Parameters<typeof OneClickService.getQuote>[0],
  upstreamStatus: number | string,
): ErrorContext {
  return {
    originAsset: req.originAsset,
    destinationAsset: req.destinationAsset,
    recipient: req.recipient,
    amount: req.amount,
    refundTo: req.refundTo,
    upstreamStatus,
    hints: diagnoseQuoteRequest({
      originAsset: req.originAsset,
      destinationAsset: req.destinationAsset,
      recipient: req.recipient,
      amount: req.amount,
      refundTo: req.refundTo,
    }),
  };
}

/**
 * Validate that the quote deadline leaves enough time for the full flow.
 *
 * The 1CS quote includes a `deadline` field — if fewer than
 * `quoteExpiryBufferSec` seconds remain, we reject the quote.
 */
export function validateDeadline(quoteResponse: QuoteResponse, cfg: GatewayConfig): void {
  const quoteDeadline = quoteResponse.quote.deadline;
  if (!quoteDeadline) {
    // No deadline means the quote doesn't expire (unlikely for non-dry).
    return;
  }

  const deadlineMs = new Date(quoteDeadline).getTime();
  const remainingSec = (deadlineMs - Date.now()) / 1_000;

  if (remainingSec < cfg.quoteExpiryBufferSec) {
    throw new DeadlineTooShortError(
      `1CS quote deadline too short: ${remainingSec.toFixed(0)}s remaining, ` +
        `need at least ${cfg.quoteExpiryBufferSec}s`,
    );
  }
}

/**
 * Map a 1CS QuoteResponse to an x402 PaymentRequirements record.
 *
 * Field mapping:
 *
 * | x402 field          | Source                    | Derivation                                          |
 * |---------------------|---------------------------|-----------------------------------------------------|
 * | scheme              | static                    | "exact" — standard EVM exact scheme                 |
 * | network             | cfg.originNetwork         | CAIP-2 chain ID (e.g. "eip155:8453")                |
 * | asset               | cfg.originTokenAddress    | ERC-20 contract address on origin chain             |
 * | amount              | quote.amountIn + margin   | EXACT_INPUT amountIn × (10000 + bps) / 10000        |
 * | payTo               | quote.depositAddress      | 1CS deposit address (the foundational trick)        |
 * | maxTimeoutSeconds   | quote.deadline - now      | seconds until deadline, minus safety buffer         |
 * | extra.name          | cfg.tokenName             | EIP-712 domain name (e.g. "USD Coin")               |
 * | extra.version       | cfg.tokenVersion          | EIP-712 domain version (e.g. "2")                   |
 * | extra.assetTransferMethod | cfg.tokenSupportsEip3009 | "eip3009" if supported, else "permit2"        |
 * | extra.crossChain    | quoteResponse + inputs    | {@link CrossChainQuoteExtra} — informational, with  |
 * |                     |                           | operatorFee breakdown surfaced for the buyer        |
 */
export function mapToPaymentRequirements(
  quoteResponse: QuoteResponse,
  cfg: GatewayConfig,
  inputs: SwapRequestInput,
  margin: { amountWithMargin: string; marginAmount: string },
): PaymentRequirementsRecord {
  const quote = quoteResponse.quote;
  const depositAddress = quote.depositAddress!;

  const maxTimeoutSeconds = computeMaxTimeoutSeconds(quote.deadline, cfg.quoteExpiryBufferSec);

  const assetTransferMethod: AssetTransferMethod = cfg.tokenSupportsEip3009
    ? "eip3009"
    : "permit2";

  return {
    scheme: "exact",
    network: cfg.originNetwork,
    asset: cfg.originTokenAddress,
    // EXACT_INPUT semantics: the buyer signed for an exact `amountIn` in
    // their request; we add the operator margin on top so the buyer's
    // x402 authorisation covers (1CS amountIn + operator fee). Slippage
    // upside on the destination amount accrues to the buyer.
    amount: margin.amountWithMargin,
    // The fundamental trick: payTo is the 1CS deposit address, not a merchant.
    // Funds land here, 1CS routes them cross-chain to inputs.destinationAddress.
    payTo: depositAddress,
    maxTimeoutSeconds,
    extra: {
      name: cfg.tokenName,
      version: cfg.tokenVersion,
      assetTransferMethod,
      crossChain: buildCrossChainExtra(quoteResponse, cfg, inputs, margin),
    },
  };
}

/**
 * Build the informational `extra.crossChain` block carried on every 402
 * envelope. Surfaces the buyer's destination, the 1CS quote breakdown,
 * the operator margin, and the effective refund target.
 *
 * Keys that the 1CS quote does not populate (e.g. `refundFee`,
 * `depositMemo` — both chain-dependent) are omitted from the output
 * rather than emitted as `undefined`, so serialised JSON stays tight.
 */
function buildCrossChainExtra(
  quoteResponse: QuoteResponse,
  cfg: GatewayConfig,
  inputs: SwapRequestInput,
  margin: { marginAmount: string },
): CrossChainQuoteExtra {
  const quote = quoteResponse.quote;
  const out: CrossChainQuoteExtra = {
    protocol: "1cs",
    quoteId: quoteResponse.correlationId,
    destinationRecipient: inputs.destinationAddress,
    destinationAsset: inputs.destinationAsset,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    amountInUsd: quote.amountInUsd,
    refundTo: inputs.refundAddress ?? cfg.gatewayRefundAddress,
    operatorFee: {
      bps: cfg.operatorMarginBps,
      amount: margin.marginAmount,
      currency: "USDC",
    },
  };
  if (quote.refundFee !== undefined) out.refundFee = quote.refundFee;
  if (quote.depositMemo !== undefined) out.depositMemo = quote.depositMemo;
  return out;
}

/**
 * Compute `maxTimeoutSeconds` from a 1CS deadline string.
 *
 * Returns the number of seconds between now and the deadline, minus the
 * safety buffer. Falls back to a generous 10-minute timeout if no
 * deadline is provided.
 */
export function computeMaxTimeoutSeconds(
  deadline: string | undefined,
  bufferSec: number,
): number {
  if (!deadline) {
    return 600; // 10-minute fallback
  }
  const deadlineMs = new Date(deadline).getTime();
  const remainingSec = Math.floor((deadlineMs - Date.now()) / 1_000);
  // Subtract buffer so the buyer's signed auth expires before the deposit address does
  return Math.max(remainingSec - bufferSec, 60); // floor at 60s minimum
}

/**
 * Convert an SDK `QuoteResponse` to our serialization-safe `QuoteResponseRecord`.
 */
export function toQuoteResponseRecord(qr: QuoteResponse): QuoteResponseRecord {
  return {
    correlationId: qr.correlationId,
    timestamp: qr.timestamp,
    signature: qr.signature,
    // Store the full quoteRequest as a generic record for serialization
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    quoteRequest: qr.quoteRequest as unknown as Record<string, unknown>,
    quote: {
      depositAddress: qr.quote.depositAddress,
      depositMemo: qr.quote.depositMemo,
      amountIn: qr.quote.amountIn,
      amountInFormatted: qr.quote.amountInFormatted,
      amountInUsd: qr.quote.amountInUsd,
      minAmountIn: qr.quote.minAmountIn,
      amountOut: qr.quote.amountOut,
      amountOutFormatted: qr.quote.amountOutFormatted,
      amountOutUsd: qr.quote.amountOutUsd,
      minAmountOut: qr.quote.minAmountOut,
      deadline: qr.quote.deadline,
      timeWhenInactive: qr.quote.timeWhenInactive,
      timeEstimate: qr.quote.timeEstimate,
      refundFee: qr.quote.refundFee,
    },
  };
}

/**
 * Extract a human-readable error message from a 1CS ApiError body.
 */
function extractErrorMessage(err: InstanceType<typeof OneClickApiError>): string {
  if (err.body && typeof err.body === "object" && "message" in err.body) {
    return String((err.body as { message: unknown }).message);
  }
  return err.statusText || err.message;
}

// ═══════════════════════════════════════════════════════════════════════
// Quote-request diagnostics
//
// Shared helper used by the runtime quote error wrapper to produce
// human-readable hints identifying the most common operator/buyer mistakes.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fields relevant to recipient/asset diagnosis. Kept narrow so the runtime
 * quote error wrapper (which passes the outgoing 1CS request) can call it.
 */
export interface QuoteRequestShape {
  originAsset?: string;
  destinationAsset?: string;
  recipient?: string;
  amount?: string;
  refundTo?: string;
}

/**
 * Inspect a 1CS quote request for patterns that usually indicate a
 * configuration / address mistake. Returns a list of human-readable hints;
 * empty when nothing suspicious is found.
 *
 * Detects:
 *  - Whitespace or `#` in any string field (typical `.env` copy-paste bug:
 *    leading space after `=` or inline comments).
 *  - Recipient format that does not match the destination chain:
 *      - EVM destination but recipient is not `0x`+40 hex chars
 *      - NEAR-native destination but recipient is not a valid NEAR account
 *      - Non-EVM destination (Stellar, Solana, Bitcoin, ...) but recipient
 *        looks like an EVM address
 *  - Unknown chain prefix in `destinationAsset` — we can't validate the
 *    recipient format, so we surface this as a hint.
 *
 * Used by the runtime error wrapper (`buildQuoteDiagnosticContext`) so
 * operators see the likely cause when 1CS rejects a quote upstream.
 * The pre-quote validator {@link validateBuyerDestination} hard-fails on
 * the same chain-mismatch class without going through this string-based
 * path.
 */
export function diagnoseQuoteRequest(req: QuoteRequestShape): string[] {
  const hints: string[] = [];

  // 1. Whitespace / inline-comment artefacts.
  for (const field of [
    "originAsset",
    "destinationAsset",
    "recipient",
    "amount",
    "refundTo",
  ] as const) {
    const value = req[field];
    if (typeof value === "string" && /\s|#/.test(value)) {
      hints.push(
        `${field} "${value}" contains whitespace or '#' — check your input for leading spaces or inline comments`,
      );
    }
  }

  // 2. Recipient format vs destination chain.
  const destinationAsset = req.destinationAsset ?? "";
  const recipient = req.recipient ?? "";
  const destPrefix = extractChainPrefix(destinationAsset);
  const isEvmRecipient = /^0x[a-fA-F0-9]{40}$/.test(recipient);

  if (destPrefix !== null && EVM_CHAIN_PREFIXES.includes(destPrefix)) {
    if (!isEvmRecipient) {
      hints.push(
        `recipient "${recipient}" does not look like an EVM address (expected 0x + 40 hex chars) but destinationAsset targets ${destPrefix}`,
      );
    }
  } else if (destPrefix !== null && NON_EVM_CHAIN_PREFIXES.includes(destPrefix)) {
    if (isEvmRecipient) {
      hints.push(
        `recipient "${recipient}" looks like an EVM address but destinationAsset targets ${destPrefix}`,
      );
    }
  } else if (isNearNativeAsset(destinationAsset)) {
    if (isEvmRecipient) {
      hints.push(
        `recipient "${recipient}" looks like an EVM address but destinationAsset resolves to a NEAR-native token; recipient should be a NEAR account`,
      );
    } else if (recipient && !isValidNearAccount(recipient)) {
      hints.push(
        `recipient "${recipient}" does not appear to be a valid NEAR account (expected a '.near' or '.tg' suffix, or a 64-char implicit account ID)`,
      );
    }
  } else if (destPrefix !== null) {
    hints.push(
      `destinationAsset has chain prefix "${destPrefix}" which is not in the known chain list — recipient format cannot be validated automatically`,
    );
  }

  return hints;
}
