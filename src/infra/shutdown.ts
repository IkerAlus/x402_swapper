/**
 * Graceful-shutdown helpers — wait for in-flight settlements to drain
 * before exiting the process.
 *
 * Extracted to a standalone module so the wait-loop can be unit-tested
 * without spawning subprocesses or relying on real signal handlers.
 *
 * The whole reason this exists: an in-flight 1CS settlement can spend up
 * to `maxPollTimeMs` (5 min default) in `POLLING`. If we `process.exit()`
 * before it finishes the buyer's on-chain transfer landed but the
 * gateway forgot about it. See TODO #3 in `docs/TODO.md`.
 *
 * @module shutdown
 */

/**
 * Narrow interface for {@link SettlementLimiter} so the helper can be
 * exercised in tests without constructing the full limiter (which would
 * pull in unrelated state). The concrete `SettlementLimiter` class in
 * `rate-limiter.ts` satisfies this shape via its `current` getter.
 */
export interface InFlightCounter {
  /** Number of in-flight settlements right now (BROADCASTING → POLLING). */
  readonly current: number;
}

/**
 * Outcome of {@link waitForSettlementsToFinish}. The caller logs the
 * result and decides whether to exit cleanly or force-exit with a warning.
 */
export type ShutdownWaitResult =
  /** All settlements drained within the grace period. Exit cleanly. */
  | { status: "drained"; waitedMs: number; finalCount: number }
  /** Grace period expired with settlements still in flight. */
  | { status: "timeout"; waitedMs: number; finalCount: number };

/**
 * Wait for the in-flight settlement count to reach zero, up to
 * `graceMs` milliseconds. Polls `counter.current` every `pollIntervalMs`
 * and resolves as soon as the count hits zero (no need to wait for the
 * next tick).
 *
 * Fast-path: if `counter.current` is already 0 at entry, resolves
 * immediately without spinning the event loop. Useful for the common
 * "shut down on an idle server" case.
 *
 * @param counter        Anything exposing `.current` — typically a `SettlementLimiter`.
 * @param graceMs        Maximum wall-clock time to wait. Must be > 0.
 * @param pollIntervalMs How often to check the counter. Defaults to 250 ms;
 *                       lower values are noisier, higher values make the
 *                       "actually done" detection lazier. Capped by `graceMs`.
 * @param onTick         Optional callback fired on every poll. Receives the
 *                       current count and elapsed ms. Used by the server's
 *                       shutdown handler to log progress (e.g. every 5 s).
 */
export async function waitForSettlementsToFinish(
  counter: InFlightCounter,
  graceMs: number,
  pollIntervalMs = 250,
  onTick?: (current: number, elapsedMs: number) => void,
): Promise<ShutdownWaitResult> {
  if (graceMs <= 0) {
    throw new Error(`graceMs must be positive (got ${graceMs})`);
  }
  if (pollIntervalMs <= 0) {
    throw new Error(`pollIntervalMs must be positive (got ${pollIntervalMs})`);
  }
  // Don't bother polling on intervals longer than the total budget.
  const effectivePollMs = Math.min(pollIntervalMs, graceMs);

  // Fast-path: already idle.
  if (counter.current === 0) {
    return { status: "drained", waitedMs: 0, finalCount: 0 };
  }

  const start = Date.now();
  // Loop until drained or deadline reached. We use setTimeout (not setInterval)
  // so an unusually long callback can't cause overlapping ticks.
  // The `await new Promise(setTimeout)` pattern is the canonical async sleep.
  for (;;) {
    const elapsed = Date.now() - start;
    if (counter.current === 0) {
      return { status: "drained", waitedMs: elapsed, finalCount: 0 };
    }
    if (elapsed >= graceMs) {
      return {
        status: "timeout",
        waitedMs: elapsed,
        finalCount: counter.current,
      };
    }
    onTick?.(counter.current, elapsed);
    // Don't sleep past the deadline.
    const remaining = graceMs - elapsed;
    const sleepMs = Math.min(effectivePollMs, remaining);
    await sleep(sleepMs);
  }
}

/** Resolve after `ms` milliseconds. Cancellable via `unref` on the timer. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the event loop alive just for a shutdown poll timer.
    t.unref?.();
  });
}
