/**
 * Settler — broadcasts the on-chain transfer and shepherds the 1CS swap to completion.
 *
 * After the verifier confirms the buyer's payment signature (phase =
 * VERIFIED), the settler:
 *
 * 1. **Broadcasts** the buyer's signed authorization on-chain (EIP-3009 or Permit2)
 * 2. **Notifies** the 1CS API of the deposit transaction (`POST /v0/deposit/submit`)
 * 3. **Polls** the 1CS status endpoint until a terminal status is reached
 * 4. **Builds** the x402 `SettleResponse` (PAYMENT-RESPONSE header) from the result
 *
 * Internal design decisions cross-referenced in body comments:
 * - **D-S1**: Dynamic gas estimation via `estimateGas()` + 20% buffer
 * - **D-S2**: 1 block confirmation (targeting L2s like Base)
 * - **D-S3**: Pre-check nonce via `authorizationState` before broadcasting
 * - **D-S4**: FAILED/REFUNDED → `SwapFailedError(502)`; automatic refund is
 *   tracked as a production-hardening item in `docs/TODO.md`
 * - **D-S5**: Injectable deps (BroadcastFn, DepositNotifyFn, StatusPollFn)
 * - **D-S6**: Happy-path broadcast; state-store persistence drives the
 *   `recoverInFlightSettlements` restart flow
 *
 * @module settler
 */

import { ethers } from "ethers";
import type { GatewayConfig } from "../infra/config.js";
import { configureOneClickSdk, applyOperatorMargin } from "./quote-engine.js";
import type { SettlementLimiter } from "../infra/rate-limiter.js";
import type {
  StateStore,
  SwapState,
  PaymentPayloadRecord,
  SettlementResponseRecord,
  CrossChainSettlementExtra,
  OneClickStatus,
  RefundInfo,
} from "../types.js";
import {
  OneClickService,
  TERMINAL_STATUSES,
  SwapFailedError,
  SwapTimeoutError,
  InsufficientGasError,
  GatewayError,
} from "../types.js";
import { extractSignatureFromAuth } from "./verifier.js";
import { NEP141_CHAIN_MAP } from "./chain-prefixes.js";

// ═══════════════════════════════════════════════════════════════════════
// Per-call timeout utility
// ═══════════════════════════════════════════════════════════════════════

/** Default per-call timeout for broadcast operations (60s).
 *  Covers estimateGas + sendTransaction + wait(1 confirmation) on mainnet. */
const BROADCAST_TIMEOUT_MS = 60_000;

/** Default per-call timeout for individual poll calls (15s). */
const POLL_CALL_TIMEOUT_MS = 15_000;

/**
 * Wrap a promise with a per-call timeout.
 * Rejects with a descriptive error if the operation exceeds the deadline.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
import {
  isEIP3009Payload,
  isPermit2Payload,
  eip3009ABI,
  x402ExactPermit2ProxyABI,
  x402ExactPermit2ProxyAddress,
} from "@x402/evm";
import type {
  ExactEIP3009Payload,
  ExactPermit2Payload,
  ExactEvmPayloadV2,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Injectable dependency types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Broadcasts a signed transaction and returns the confirmed receipt.
 *
 * In production, backed by an ethers.js `Wallet` connected to a provider.
 * In tests, replaced with a stub returning a mock receipt.
 */
export interface BroadcastFn {
  /**
   * Broadcast an EIP-3009 transferWithAuthorization.
   *
   * @param tokenAddress ERC-20 contract address.
   * @param auth         Authorization parameters from the payload.
   * @param signature    The buyer's EIP-712 signature.
   * @param gasOptions   Gas estimation overrides.
   * @returns The confirmed transaction hash.
   */
  broadcastEIP3009(
    tokenAddress: string,
    auth: ExactEIP3009Payload["authorization"],
    signature: string,
    gasOptions?: GasOptions,
  ): Promise<BroadcastResult>;

  /**
   * Broadcast a Permit2 settle call via the x402ExactPermit2Proxy.
   *
   * @param permit2Auth  Permit2 authorization from the payload.
   * @param signature    The buyer's EIP-712 signature.
   * @param gasOptions   Gas estimation overrides.
   * @returns The confirmed transaction hash.
   */
  broadcastPermit2(
    permit2Auth: ExactPermit2Payload["permit2Authorization"],
    signature: string,
    gasOptions?: GasOptions,
  ): Promise<BroadcastResult>;

  /**
   * Check if an EIP-3009 authorization nonce has already been used.
   *
   * @param tokenAddress ERC-20 contract address.
   * @param authorizer   The signer's address.
   * @param nonce        The authorization nonce (bytes32).
   * @returns true if the nonce is already consumed.
   */
  checkAuthorizationState(
    tokenAddress: string,
    authorizer: string,
    nonce: string,
  ): Promise<boolean>;

  /**
   * Get the facilitator wallet's native token balance (for gas checks).
   */
  getFacilitatorBalance(): Promise<bigint>;
}

/**
 * Notifies the 1CS API that a deposit transaction has been broadcast.
 *
 * In production, calls `OneClickService.submitDepositTx`.
 * In tests, replaced with a stub.
 */
export type DepositNotifyFn = (
  txHash: string,
  depositAddress: string,
) => Promise<DepositNotifyResult>;

/**
 * Polls the 1CS status endpoint for a single deposit address.
 *
 * In production, calls `OneClickService.getExecutionStatus`.
 * In tests, replaced with a stub.
 */
export type StatusPollFn = (
  depositAddress: string,
) => Promise<StatusPollResult>;

// ═══════════════════════════════════════════════════════════════════════
// Supporting types
// ═══════════════════════════════════════════════════════════════════════

export interface GasOptions {
  /** Gas limit override (skips estimateGas). */
  gasLimit?: bigint;
  /** Buffer multiplier for estimated gas (e.g. 1.2 for +20%). */
  gasBufferMultiplier?: number;
}

export interface BroadcastResult {
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
}

export interface DepositNotifyResult {
  status: string;
  correlationId?: string;
}

export interface StatusPollResult {
  status: OneClickStatus;
  swapDetails?: {
    originChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    destinationChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    refundedAmount?: string;
    amountIn?: string;
    amountOut?: string;
    /** Human-readable destination amount (e.g. `"9.985"`), when 1CS reports it. */
    amountOutFormatted?: string;
    /** USD value of the destination amount, when 1CS reports it. */
    amountOutUsd?: string;
    /** Realised slippage from 1CS, when available. */
    slippage?: number;
  };
}

export interface SettlerOptions {
  /**
   * Minimum gas balance (in wei) the facilitator needs to broadcast.
   * @default 1_000_000_000_000_000n (0.001 ETH)
   */
  minGasBalance?: bigint;

  /**
   * Gas buffer multiplier for `estimateGas()`.
   * @default 1.2 (+20%)
   */
  gasBufferMultiplier?: number;

  /**
   * Number of block confirmations to wait after broadcast.
   * @default 1 (suitable for L2s like Base)
   */
  confirmations?: number;

  /**
   * Timeout (ms) for the entire broadcast operation
   * (estimateGas + sendTransaction + wait for confirmations).
   * @default 60_000 (60s)
   */
  broadcastTimeoutMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Settle a verified payment by broadcasting the on-chain tx,
 * notifying 1CS, polling for completion, and building the response.
 *
 * This is the main entry point for the settler module. It expects the
 * swap state to be in `VERIFIED` phase (set by the verifier).
 *
 * @param depositAddress  The 1CS deposit address (primary key in the store).
 * @param store           State persistence layer.
 * @param broadcastFn     Injectable broadcaster.
 * @param depositNotifyFn Injectable 1CS deposit notification.
 * @param statusPollFn    Injectable 1CS status poller.
 * @param cfg             Validated gateway configuration.
 * @param options         Optional settler configuration.
 *
 * @returns SettlementResponseRecord for the PAYMENT-RESPONSE header.
 *
 * @throws {SwapFailedError}       1CS swap reached FAILED or REFUNDED.
 * @throws {SwapTimeoutError}      Polling exceeded maxPollTimeMs.
 * @throws {InsufficientGasError}  Facilitator wallet lacks gas funds.
 * @throws {GatewayError}          Other settlement failures.
 */
export async function settlePayment(
  depositAddress: string,
  store: StateStore,
  broadcastFn: BroadcastFn,
  depositNotifyFn: DepositNotifyFn,
  statusPollFn: StatusPollFn,
  cfg: GatewayConfig,
  options: SettlerOptions = {},
): Promise<SettlementResponseRecord> {
  // ── 1. Load and validate state ────────────────────────────────────
  const state = await store.get(depositAddress);
  if (!state) {
    throw new GatewayError(
      `No swap state found for deposit address: ${depositAddress}`,
      "STATE_NOT_FOUND",
      500,
    );
  }

  if (state.phase !== "VERIFIED") {
    // If already settled, return cached response
    if (state.phase === "SETTLED" && state.settlementResponse) {
      return state.settlementResponse;
    }
    throw new GatewayError(
      `Cannot settle swap in phase ${state.phase}; expected VERIFIED`,
      "INVALID_PHASE",
      500,
    );
  }

  if (!state.paymentPayload || !state.signerAddress) {
    throw new GatewayError(
      "Swap state is missing paymentPayload or signerAddress",
      "INCOMPLETE_STATE",
      500,
    );
  }

  // ── 2. Check facilitator gas balance ──────────────────────────────
  const minGas = options.minGasBalance ?? 1_000_000_000_000_000n; // 0.001 ETH
  try {
    const balance = await broadcastFn.getFacilitatorBalance();
    if (balance < minGas) {
      throw new InsufficientGasError(
        `Facilitator gas balance too low: ${balance.toString()} wei, need at least ${minGas.toString()} wei`,
      );
    }
  } catch (err) {
    if (err instanceof InsufficientGasError) throw err;
    // Non-fatal: if we can't check balance, proceed optimistically
  }

  // ── 3. Broadcast the on-chain transaction ─────────────────────────
  let broadcastResult: BroadcastResult;
  try {
    await store.update(depositAddress, { phase: "BROADCASTING" });
    console.log(`[x402] ▶ Broadcasting origin tx for ${depositAddress}...`);

    broadcastResult = await withTimeout(
      broadcastTransaction(
        state.paymentPayload,
        state.paymentRequirements.asset,
        broadcastFn,
        options,
      ),
      options.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS,
      "Broadcast",
    );

    await store.update(depositAddress, {
      phase: "BROADCAST",
      originTxHash: broadcastResult.txHash,
    });
    console.log(
      `[x402] ✓ Origin tx broadcast for ${depositAddress}: tx=${broadcastResult.txHash}, block=${broadcastResult.blockNumber}`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await failSwap(store, depositAddress, `Broadcast failed: ${errorMsg}`);
    throw err instanceof GatewayError
      ? err
      : new GatewayError(`Broadcast failed: ${errorMsg}`, "BROADCAST_FAILED", 502);
  }

  // ── 4. Notify 1CS of the deposit ──────────────────────────────────
  // Record the outcome so we can include it in any downstream SwapTimeoutError.
  // The notify response's `status` field can hint at early 1CS-side validation
  // problems (e.g. invalid destination), which are otherwise invisible until
  // polling eventually times out.
  let notifyOutcome: string;
  try {
    configureOneClickSdk(cfg);
    const notifyResult = await depositNotifyFn(broadcastResult.txHash, depositAddress);
    notifyOutcome = `deposit-notify OK (status=${notifyResult.status}${notifyResult.correlationId ? `, correlationId=${notifyResult.correlationId}` : ""})`;
    console.log(`[x402] ✓ ${notifyOutcome} for ${depositAddress} (tx: ${broadcastResult.txHash})`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyOutcome = `deposit-notify FAILED (${errMsg})`;
    // Non-fatal: 1CS may detect the deposit on its own via chain monitoring.
    // Log prominently and continue to polling.
    console.warn(
      `[x402] ⚠️  Deposit notify failed for ${depositAddress} (tx: ${broadcastResult.txHash}):`,
      errMsg,
    );
  }

  // ── 5. Poll 1CS for terminal status ───────────────────────────────
  let pollResult: StatusPollResult;
  try {
    await store.update(depositAddress, { phase: "POLLING" });
    console.log(
      `[x402] ⏳ Polling 1CS status for ${depositAddress} (budget: ${Math.round(cfg.maxPollTimeMs / 1000)}s)...`,
    );

    pollResult = await pollUntilTerminal(
      depositAddress,
      statusPollFn,
      store,
      cfg,
    );
  } catch (err) {
    if (err instanceof SwapTimeoutError) {
      // Augment the timeout message with the earlier notify outcome so
      // operators can tell whether 1CS ever acknowledged the deposit.
      const augmented = new SwapTimeoutError(`${err.message} | ${notifyOutcome}`);
      await failSwap(store, depositAddress, augmented.message);
      throw augmented;
    }
    if (err instanceof SwapFailedError) {
      await failSwap(store, depositAddress, err.message);
      throw err;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    await failSwap(store, depositAddress, `Polling failed: ${errorMsg}`);
    throw new GatewayError(`Polling failed: ${errorMsg}`, "POLL_FAILED", 502);
  }

  // ── 6. Build the settlement response ──────────────────────────────
  const response = buildSettlementResponse(
    state,
    broadcastResult,
    pollResult,
    cfg,
  );

  console.log(
    `[x402] ✅ Settled ${depositAddress} → 1CS status=${pollResult.status}, destChain=${extractDestinationChain(state.swapInputs.destinationAsset)}`,
  );

  // ── 7. Finalize state ─────────────────────────────────────────────
  await store.update(depositAddress, {
    phase: "SETTLED",
    settlementResponse: response,
    oneClickStatus: pollResult.status,
    settledAt: Date.now(),
  });

  return response;
}

// ═══════════════════════════════════════════════════════════════════════
// Startup recovery — resume in-flight settlements after restart
// ═══════════════════════════════════════════════════════════════════════

/**
 * Recover a single swap that was in-flight when the process last stopped.
 *
 * Recovery strategy per phase:
 * - **BROADCASTING without `originTxHash`** — mark FAILED (cannot safely re-broadcast)
 * - **BROADCASTING with `originTxHash`** — treat as BROADCAST (fall through)
 * - **BROADCAST** — re-notify 1CS (best-effort), then poll
 * - **POLLING** — resume polling directly
 *
 * This function never throws — all errors are caught and the swap is marked FAILED.
 */
export async function recoverSettlement(
  state: SwapState,
  store: StateStore,
  depositNotifyFn: DepositNotifyFn,
  statusPollFn: StatusPollFn,
  cfg: GatewayConfig,
): Promise<void> {
  const addr = state.depositAddress;
  const phase = state.phase;

  try {
    // ── BROADCASTING — can only recover if txHash was persisted ────────
    if (phase === "BROADCASTING") {
      if (!state.originTxHash) {
        console.warn(
          `[x402] Recovery: ${addr} stuck in BROADCASTING with no txHash — marking FAILED`,
        );
        await failSwap(store, addr, "Recovery: no txHash after BROADCASTING — cannot safely re-broadcast");
        return;
      }
      // txHash exists → process died between broadcast confirmation and
      // the state update to BROADCAST. Treat as BROADCAST and fall through.
      console.log(
        `[x402] Recovery: ${addr} in BROADCASTING with txHash=${state.originTxHash} — treating as BROADCAST`,
      );
      await store.update(addr, { phase: "BROADCAST" });
    }

    // ── BROADCAST — re-notify 1CS, then start polling ─────────────────
    if (phase === "BROADCAST" || (phase === "BROADCASTING" && state.originTxHash)) {
      configureOneClickSdk(cfg);
      try {
        const notifyResult = await depositNotifyFn(state.originTxHash!, addr);
        console.log(
          `[x402] Recovery: ${addr} re-notified 1CS (status=${notifyResult.status})`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[x402] Recovery: ${addr} deposit-notify failed (${errMsg}) — continuing to poll`,
        );
      }
      await store.update(addr, { phase: "POLLING" });
    }

    // ── POLLING — resume polling for terminal status ──────────────────
    configureOneClickSdk(cfg);
    console.log(
      `[x402] Recovery: ${addr} resuming 1CS polling (budget: ${Math.round(cfg.maxPollTimeMs / 1000)}s)...`,
    );

    const pollResult = await pollUntilTerminal(addr, statusPollFn, store, cfg);

    // Build a recovery-mode settlement response (no BroadcastResult available).
    // Uses the same receipt builder as the happy path so the receipt shape
    // doesn't drift between fresh settlements and recovered ones.
    const response: SettlementResponseRecord = {
      success: true,
      payer: state.signerAddress,
      transaction: state.originTxHash ?? "unknown",
      network: cfg.originNetwork,
      amount: state.paymentRequirements.amount,
      extra: buildCrossChainSettlementExtra(state, pollResult.swapDetails, pollResult.status),
    };

    await store.update(addr, {
      phase: "SETTLED",
      settlementResponse: response,
      oneClickStatus: pollResult.status,
      settledAt: Date.now(),
    });

    console.log(
      `[x402] Recovery: ✅ ${addr} settled → 1CS status=${pollResult.status}`,
    );
  } catch (err) {
    // Any error (timeout, 1CS failure, unexpected) → mark FAILED
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[x402] Recovery: ❌ ${addr} failed — ${errMsg}`);
    await failSwap(store, addr, `Recovery failed: ${errMsg}`);
  }
}

/**
 * Result of a recovery sweep. `tasks` is the list of background promises —
 * one per settlement that acquired a limiter slot. Production (server
 * startup) ignores it so recovery runs truly fire-and-forget; tests
 * `Promise.all(tasks)` to await deterministic completion instead of
 * relying on real-timer sleeps.
 */
export interface RecoveryResult {
  total: number;
  started: number;
  skipped: number;
  tasks: Promise<void>[];
}

/**
 * Scan the store for in-flight settlements and resume them in the background.
 *
 * Called once during server startup, after dependencies are wired but before
 * the HTTP server begins accepting requests. Individual recovery tasks run
 * concurrently in the background and hold {@link SettlementLimiter} slots
 * for their duration.
 *
 * Swaps that cannot acquire a limiter slot are left in place (not marked FAILED)
 * and will be recovered on the next restart.
 *
 * @returns {@link RecoveryResult} with counts and an array of background
 *   task promises. Tests can `await Promise.all(result.tasks)` to wait for
 *   recovery completion deterministically; production callers can ignore
 *   `tasks` to preserve fire-and-forget semantics.
 */
export async function recoverInFlightSettlements(
  store: StateStore,
  depositNotifyFn: DepositNotifyFn,
  statusPollFn: StatusPollFn,
  settlementLimiter: SettlementLimiter | undefined,
  cfg: GatewayConfig,
): Promise<RecoveryResult> {
  const [broadcasting, broadcast, polling] = await Promise.all([
    store.listByPhase("BROADCASTING"),
    store.listByPhase("BROADCAST"),
    store.listByPhase("POLLING"),
  ]);

  const stuckSwaps = [...broadcasting, ...broadcast, ...polling];
  const total = stuckSwaps.length;

  if (total === 0) {
    return { total: 0, started: 0, skipped: 0, tasks: [] };
  }

  console.log(
    `[x402] Recovery: found ${total} in-flight settlement(s) ` +
      `(BROADCASTING=${broadcasting.length}, BROADCAST=${broadcast.length}, POLLING=${polling.length})`,
  );

  let started = 0;
  let skipped = 0;
  const tasks: Promise<void>[] = [];

  for (const state of stuckSwaps) {
    // Respect the settlement limiter — don't starve new requests
    if (settlementLimiter && !settlementLimiter.acquire()) {
      console.warn(
        `[x402] Recovery: skipping ${state.depositAddress} — at settlement capacity`,
      );
      skipped++;
      continue;
    }

    started++;

    // Keep the promise around so tests can await completion, but don't
    // let a rejection bubble — `recoverSettlement` is documented to
    // swallow all errors and mark the swap FAILED instead.
    const task = recoverSettlement(state, store, depositNotifyFn, statusPollFn, cfg)
      .finally(() => {
        settlementLimiter?.release();
      });
    tasks.push(task);
  }

  return { total, started, skipped, tasks };
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-step A: Broadcast
// ═══════════════════════════════════════════════════════════════════════

/**
 * Route the broadcast to the correct method based on payload type.
 */
async function broadcastTransaction(
  paymentPayload: PaymentPayloadRecord,
  tokenAddress: string,
  broadcastFn: BroadcastFn,
  options: SettlerOptions,
): Promise<BroadcastResult> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload: ExactEvmPayloadV2 = paymentPayload.payload as unknown as ExactEvmPayloadV2;
  const gasOptions: GasOptions = {
    gasBufferMultiplier: options.gasBufferMultiplier ?? 1.2,
  };

  if (isEIP3009Payload(payload)) {
    return broadcastEIP3009(payload, tokenAddress, broadcastFn, gasOptions);
  } else if (isPermit2Payload(payload)) {
    return broadcastPermit2(payload, broadcastFn, gasOptions);
  } else {
    throw new GatewayError(
      "Cannot broadcast: unrecognized payload format",
      "UNKNOWN_PAYLOAD",
      500,
    );
  }
}

/**
 * Broadcast an EIP-3009 transferWithAuthorization.
 *
 * D-S3: Pre-checks `authorizationState` to detect already-used nonces
 * before wasting gas on a transaction that would revert.
 */
async function broadcastEIP3009(
  payload: ExactEIP3009Payload,
  tokenAddress: string,
  broadcastFn: BroadcastFn,
  gasOptions: GasOptions,
): Promise<BroadcastResult> {
  const auth = payload.authorization;
  const signature = payload.signature ?? extractSignatureFromAuth(auth);

  if (!signature) {
    throw new GatewayError(
      "No signature found in EIP-3009 payload for broadcast",
      "MISSING_SIGNATURE",
      500,
    );
  }

  // D-S3: Pre-check nonce to avoid broadcasting a doomed tx
  try {
    const nonceUsed = await broadcastFn.checkAuthorizationState(
      tokenAddress,
      auth.from,
      auth.nonce,
    );
    if (nonceUsed) {
      throw new GatewayError(
        `EIP-3009 authorization nonce already used: ${auth.nonce}`,
        "NONCE_ALREADY_USED",
        409,
      );
    }
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    // Non-fatal: if we can't check nonce state, proceed optimistically
  }

  return broadcastFn.broadcastEIP3009(
    tokenAddress,
    auth,
    signature,
    gasOptions,
  );
}

/**
 * Broadcast a Permit2 settle call via the x402ExactPermit2Proxy.
 */
async function broadcastPermit2(
  payload: ExactPermit2Payload,
  broadcastFn: BroadcastFn,
  gasOptions: GasOptions,
): Promise<BroadcastResult> {
  return broadcastFn.broadcastPermit2(
    payload.permit2Authorization,
    payload.signature,
    gasOptions,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-step C: Poll
// ═══════════════════════════════════════════════════════════════════════

/**
 * Poll the 1CS status endpoint with exponential backoff until a terminal
 * status is reached or the maximum polling time is exceeded.
 *
 * Uses `cfg.pollIntervalBaseMs`, `cfg.pollIntervalMaxMs`, and
 * `cfg.maxPollTimeMs` for timing.
 *
 * @throws {SwapTimeoutError} if polling exceeds maxPollTimeMs.
 * @throws {SwapFailedError}  if 1CS reports FAILED or REFUNDED.
 */
export async function pollUntilTerminal(
  depositAddress: string,
  statusPollFn: StatusPollFn,
  store: StateStore,
  cfg: GatewayConfig,
): Promise<StatusPollResult> {
  const startTime = Date.now();
  let interval = cfg.pollIntervalBaseMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= cfg.maxPollTimeMs) {
      throw new SwapTimeoutError(
        `1CS status polling timed out after ${Math.round(elapsed / 1000)}s ` +
          `(limit: ${Math.round(cfg.maxPollTimeMs / 1000)}s)`,
      );
    }

    // Wait before polling (except on first iteration)
    await sleep(interval);

    // Poll (with per-call timeout to prevent a single hung request from blocking the loop)
    let result: StatusPollResult;
    try {
      result = await withTimeout(
        statusPollFn(depositAddress),
        POLL_CALL_TIMEOUT_MS,
        "Status poll",
      );
    } catch (err) {
      // Non-fatal poll error — retry on next interval
      interval = Math.min(interval * 2, cfg.pollIntervalMaxMs);
      continue;
    }

    // Update stored status for observability
    await store.update(depositAddress, {
      oneClickStatus: result.status,
    });

    // Check for terminal status
    if (TERMINAL_STATUSES.has(result.status)) {
      if (result.status === "SUCCESS") {
        return result;
      }

      // FAILED or REFUNDED
      const refundInfo: RefundInfo | undefined = result.swapDetails?.refundedAmount
        ? {
            buyerAddress: "", // Will be filled from state by caller
            amount: result.swapDetails.refundedAmount,
            reason: `1CS swap ${result.status}`,
          }
        : undefined;

      throw new SwapFailedError(
        `1CS swap reached terminal status: ${result.status}`,
        result.status,
        refundInfo,
      );
    }

    // Exponential backoff (capped)
    interval = Math.min(interval * 2, cfg.pollIntervalMaxMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-step D: Build response
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the x402 `SettlementResponseRecord` from the broadcast and poll results.
 *
 * Returned in the `PAYMENT-RESPONSE` header as a JSON-encoded string. The
 * `extra` field carries the swap receipt (a {@link CrossChainSettlementExtra});
 * the response body itself is `{}`. See D14 in `implementation_plan.md`.
 */
export function buildSettlementResponse(
  state: SwapState,
  broadcastResult: BroadcastResult,
  pollResult: StatusPollResult,
  cfg: GatewayConfig,
): SettlementResponseRecord {
  return {
    success: true,
    payer: state.signerAddress,
    transaction: broadcastResult.txHash,
    network: cfg.originNetwork,
    amount: state.paymentRequirements.amount,
    extra: buildCrossChainSettlementExtra(state, pollResult.swapDetails, pollResult.status),
  };
}

/**
 * Assemble the `extensions.crossChain` payload (the swap receipt) for the
 * `PAYMENT-RESPONSE` header. The buyer's destination, the operator margin
 * snapshot, and any `swapDetails` fields 1CS surfaced (slippage, USD/formatted
 * amounts, destination tx hashes) all flow into one object here.
 *
 * Optional fields are omitted when their source is missing rather than
 * emitted as `undefined`, so the on-the-wire JSON stays tight and downstream
 * consumers can rely on key-presence semantics.
 *
 * Used by both {@link buildSettlementResponse} (the happy path) and
 * {@link recoverSettlement} (the post-restart recovery path) so the receipt
 * shape doesn't drift between them.
 */
export function buildCrossChainSettlementExtra(
  state: SwapState,
  swapDetails: StatusPollResult["swapDetails"],
  status: OneClickStatus,
): CrossChainSettlementExtra {
  const { marginAmount } = applyOperatorMargin(
    state.quoteResponse.quote.amountIn,
    state.operatorMarginBps,
  );

  const extra: CrossChainSettlementExtra = {
    settlementType: "crosschain-1cs",
    destinationChain: extractDestinationChain(state.swapInputs.destinationAsset),
    destinationRecipient: state.swapInputs.destinationAddress,
    destinationAsset: state.swapInputs.destinationAsset,
    operatorFee: {
      bps: state.operatorMarginBps,
      amount: marginAmount,
      currency: "USDC",
    },
    swapStatus: status,
    correlationId: state.quoteResponse.correlationId,
  };

  if (swapDetails?.destinationChainTxHashes !== undefined) {
    extra.destinationTxHashes = swapDetails.destinationChainTxHashes;
  }
  if (swapDetails?.amountOut !== undefined) {
    extra.destinationAmount = swapDetails.amountOut;
  }
  if (swapDetails?.amountOutFormatted !== undefined) {
    extra.destinationAmountFormatted = swapDetails.amountOutFormatted;
  }
  if (swapDetails?.amountOutUsd !== undefined) {
    extra.destinationAmountUsd = swapDetails.amountOutUsd;
  }
  if (swapDetails?.slippage !== undefined) {
    extra.slippage = swapDetails.slippage;
  }

  return extra;
}

// ═══════════════════════════════════════════════════════════════════════
// Production dependency factories
// ═══════════════════════════════════════════════════════════════════════

/**
 * Manually poll for a transaction receipt.
 *
 * ethers v6's `tx.wait()` relies on internal block-polling that can stall
 * with certain RPC providers (especially on L2s like Base). This function
 * polls `getTransactionReceipt` directly with a fixed interval, which is
 * more resilient to provider quirks.
 */
async function waitForReceipt(
  provider: ethers.Provider,
  txHash: string,
  intervalMs: number = 2_000,
  maxAttempts: number = 30,
): Promise<ethers.TransactionReceipt> {
  for (let i = 0; i < maxAttempts; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      if (receipt.status === 0) {
        throw new GatewayError(
          `Transaction reverted on-chain: ${txHash}`,
          "TX_REVERTED",
          502,
        );
      }
      return receipt;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new GatewayError(
    `Transaction not mined after ${maxAttempts} poll attempts: ${txHash}`,
    "TX_NOT_MINED",
    504,
  );
}

/**
 * Create a production {@link BroadcastFn} from an ethers.js `Wallet`.
 *
 * The wallet must be connected to a provider for the origin chain.
 * D-S1: Uses dynamic `estimateGas()` + configurable buffer multiplier.
 * D-S2: Polls for receipt confirmation (resilient to provider polling quirks).
 */
export function createBroadcastFn(
  wallet: ethers.Wallet,
): BroadcastFn {
  return {
    async broadcastEIP3009(
      tokenAddress: string,
      auth: ExactEIP3009Payload["authorization"],
      signature: string,
      gasOptions?: GasOptions,
    ): Promise<BroadcastResult> {
      const contract = new ethers.Contract(
        tokenAddress,
        eip3009ABI,
        wallet,
      );

      // Split ECDSA signature into v, r, s components
      const sig = ethers.Signature.from(signature);

      // D-S1: Dynamic gas estimation + buffer
      const gasLimit = gasOptions?.gasLimit ?? await estimateGasWithBuffer(
        contract,
        "transferWithAuthorization",
        [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s],
        gasOptions?.gasBufferMultiplier ?? 1.2,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await contract.getFunction("transferWithAuthorization")(
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        sig.v,
        sig.r,
        sig.s,
        { gasLimit },
      );

      // D-S2: Poll for receipt (more resilient than tx.wait() which can stall)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const txHash = tx.hash as string;
      const receipt = await waitForReceipt(wallet.provider!, txHash);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    },

    async broadcastPermit2(
      permit2Auth: ExactPermit2Payload["permit2Authorization"],
      signature: string,
      gasOptions?: GasOptions,
    ): Promise<BroadcastResult> {
      const proxy = new ethers.Contract(
        x402ExactPermit2ProxyAddress,
        x402ExactPermit2ProxyABI,
        wallet,
      );

      // Build the permit struct for the proxy.settle() call
      const permit = {
        permitted: {
          token: permit2Auth.permitted.token,
          amount: permit2Auth.permitted.amount,
        },
        nonce: permit2Auth.nonce,
        deadline: permit2Auth.deadline,
      };

      const owner = permit2Auth.from;
      const witness = {
        to: permit2Auth.witness.to,
        validAfter: permit2Auth.witness.validAfter,
      };

      // D-S1: Dynamic gas estimation + buffer
      const gasLimit = gasOptions?.gasLimit ?? await estimateGasWithBuffer(
        proxy,
        "settle",
        [permit, owner, witness, signature],
        gasOptions?.gasBufferMultiplier ?? 1.2,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await proxy.getFunction("settle")(
        permit,
        owner,
        witness,
        signature,
        { gasLimit },
      );

      // D-S2: Poll for receipt (more resilient than tx.wait() which can stall)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const txHash = tx.hash as string;
      const receipt = await waitForReceipt(wallet.provider!, txHash);

      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    },

    async checkAuthorizationState(
      tokenAddress: string,
      authorizer: string,
      nonce: string,
    ): Promise<boolean> {
      const contract = new ethers.Contract(
        tokenAddress,
        eip3009ABI,
        wallet.provider,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await contract.getFunction("authorizationState")(authorizer, nonce);
      return Boolean(result);
    },

    async getFacilitatorBalance(): Promise<bigint> {
      if (!wallet.provider) {
        throw new Error("Wallet has no provider");
      }
      return wallet.provider.getBalance(wallet.address);
    },
  };
}

/**
 * Create a production {@link DepositNotifyFn}.
 *
 * Wraps `OneClickService.submitDepositTx`.
 */
export function createDepositNotifyFn(): DepositNotifyFn {
  return async (txHash: string, depositAddress: string): Promise<DepositNotifyResult> => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response = await OneClickService.submitDepositTx({
      txHash,
      depositAddress,
    });
    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      correlationId: response.correlationId,
    };
  };
}

/**
 * Create a production {@link StatusPollFn}.
 *
 * Wraps `OneClickService.getExecutionStatus`.
 */
export function createStatusPollFn(): StatusPollFn {
  return async (depositAddress: string): Promise<StatusPollResult> => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response = await OneClickService.getExecutionStatus(depositAddress);
    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      status: response.status as OneClickStatus,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      swapDetails: response.swapDetails
        ? {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            originChainTxHashes: response.swapDetails.originChainTxHashes,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            destinationChainTxHashes: response.swapDetails.destinationChainTxHashes,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            refundedAmount: response.swapDetails.refundedAmount,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            amountIn: response.swapDetails.amountIn,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            amountOut: response.swapDetails.amountOut,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            amountOutFormatted: response.swapDetails.amountOutFormatted,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            amountOutUsd: response.swapDetails.amountOutUsd,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            slippage: response.swapDetails.slippage,
          }
        : undefined,
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Estimate gas for a contract call and apply a buffer multiplier.
 *
 * D-S1: Dynamic `estimateGas()` + 20% buffer (default).
 */
async function estimateGasWithBuffer(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  bufferMultiplier: number,
): Promise<bigint> {
  try {
    const estimated = await contract.getFunction(method).estimateGas(...args);
    // Apply buffer: multiply by bufferMultiplier (e.g. 1.2 → +20%)
    return (estimated * BigInt(Math.round(bufferMultiplier * 100))) / 100n;
  } catch {
    // Fallback: use a generous default for ERC-20 interactions
    return 200_000n;
  }
}

/**
 * Transition a swap to FAILED state with an error message.
 */
async function failSwap(
  store: StateStore,
  depositAddress: string,
  error: string,
): Promise<void> {
  try {
    await store.update(depositAddress, {
      phase: "FAILED",
      error,
      settledAt: Date.now(),
    });
  } catch {
    // If we can't update the store, we still want to throw the original error
  }
}

// The OMFT chain-prefix → canonical chain identifier map is the single
// source of truth in `src/payment/chain-prefixes.ts` (`NEP141_CHAIN_MAP`). The
// `EVM_CHAIN_PREFIXES` / `NON_EVM_CHAIN_PREFIXES` lists used by config
// validation and quote-engine diagnosis are derived from the same map,
// so adding a new chain is one edit in one place.

/**
 * Extract the destination chain from a 1CS asset ID.
 *
 * Handles short-form, CAIP-2, and NEP-141 canonical formats:
 *
 * **Short-form:**
 *   - `"near:nUSDC"`              → `"near"`
 *   - `"ethereum:USDT"`           → `"ethereum"`
 *   - `"base:USDC"`               → `"base"`
 *
 * **CAIP-2:**
 *   - `"eip155:8453"`             → `"eip155:8453"`
 *
 * **NEP-141 bridged (OMFT) — EVM:**
 *   - `"nep141:base-0x833...omft.near"`  → `"eip155:8453"`
 *   - `"nep141:arb-0xaf88...omft.near"`  → `"eip155:42161"`
 *   - `"nep141:eth-0xa0b8...omft.near"`  → `"eip155:1"`
 *
 * **NEP-141 bridged (OMFT) — non-EVM:**
 *   - `"nep141:solana-SPL...omft.near"`    → `"solana:mainnet"`
 *   - `"nep141:stellar-GAXYZ...omft.near"` → `"stellar:pubnet"`
 *   - `"nep141:bitcoin-bc1q...omft.near"`  → `"bitcoin:mainnet"`
 *
 * **NEP-141 bridged — unknown prefix (graceful degradation):**
 *   - `"nep141:futurechain-0xabc...omft.near"` → `"futurechain"`
 *
 * **NEP-141 native NEAR:**
 *   - `"nep141:usdc.near"`                           → `"near"`
 *   - `"nep141:17208628f84f5d6ad33f0da3bbbeb27f..."` → `"near"`
 */
export function extractDestinationChain(assetId: string): string {
  const colonIndex = assetId.indexOf(":");
  if (colonIndex <= 0) return assetId;

  const prefix = assetId.substring(0, colonIndex);
  const rest = assetId.substring(colonIndex + 1);

  if (prefix === "nep141") {
    // Check for OMFT-bridged assets: "nep141:<chain>-<address>.omft.near"
    // The chain prefix appears before the first hyphen.
    const hyphenIndex = rest.indexOf("-");
    if (hyphenIndex > 0) {
      const chainPrefix = rest.substring(0, hyphenIndex);
      const mapped = NEP141_CHAIN_MAP[chainPrefix];
      if (mapped) return mapped;
      // Unknown but clearly prefixed — return raw prefix so new 1CS chains
      // work without code changes (just with less-pretty chain identifiers).
      return chainPrefix;
    }

    // Native NEAR tokens: "nep141:usdc.near", "nep141:wrap.near", or hex IDs
    if (rest.endsWith(".near")) return "near";
    if (rest.endsWith(".testnet")) return "near-testnet";
    return "near";
  }

  return prefix;
}

// `extractSignatureFromAuth` is a shared helper — see `verifier.ts` for
// the single source of truth. The import appears at the top of this file
// alongside other verifier imports.

/**
 * Promise-based sleep for polling intervals.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
