/**
 * Rate Limiting & Abuse Prevention.
 *
 * This module provides three mechanisms to protect the gateway:
 *
 * 1. **Per-IP quote rate limiter** — limits how many 402 responses (each of
 *    which creates a real 1CS deposit address) a single IP can trigger per
 *    time window. Uses a sliding-window counter stored in memory.
 *
 * 2. **Concurrent settlement limiter** — caps how many settlements can be
 *    in-flight simultaneously (phases BROADCASTING through POLLING). Prevents
 *    the facilitator wallet from being drained by parallel gas expenditures.
 *
 * 3. **Quote garbage collector** — periodically prunes stale swap states
 *    (QUOTED whose deadlines have passed, plus terminal SETTLED/FAILED/EXPIRED)
 *    freeing memory in the state store. In-flight settlements are never
 *    deleted — see `GC_ELIGIBLE_PHASES` in `types.ts`.
 *
 * All three components are designed for dependency injection and testability:
 * the rate limiter accepts a `now()` function, and the GC accepts a store
 * and config, making them deterministic in tests.
 *
 * @module rate-limiter
 */

import type { StateStore } from "../types.js";
import { GC_ELIGIBLE_PHASES } from "../types.js";
import type { GatewayConfig } from "./config.js";

// ═══════════════════════════════════════════════════════════════════════
// 1. Per-IP Quote Rate Limiter
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configuration for the sliding-window rate limiter.
 */
export interface RateLimiterConfig {
  /** Maximum requests allowed per window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/**
 * Result of a rate-limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Unix timestamp (ms) when the window resets. */
  resetAt: number;
  /** Total limit for the window. */
  limit: number;
}

/**
 * In-memory sliding-window rate limiter keyed by IP address.
 *
 * Each IP gets an array of request timestamps. On each check, timestamps
 * older than `windowMs` are pruned, and the remaining count is compared
 * against `maxRequests`.
 *
 * Memory is bounded: each entry is cleaned up when all its timestamps
 * expire, and a periodic sweep removes stale entries.
 */
export class QuoteRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly config: RateLimiterConfig;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: RateLimiterConfig,
    options?: { now?: () => number },
  ) {
    this.config = config;
    this.now = options?.now ?? Date.now;

    // Sweep stale entries every 5 windows (or 5 minutes, whichever is less)
    const sweepInterval = Math.min(config.windowMs * 5, 5 * 60_000);
    this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
    // Don't prevent Node from exiting
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * Check whether a request from the given IP is allowed, and record it
   * if so.
   *
   * @param ip  The client's IP address (or any string key).
   * @returns   Rate-limit result with remaining quota and reset time.
   */
  check(ip: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.config.windowMs;

    // Get or create the bucket
    let timestamps = this.buckets.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(ip, timestamps);
    }

    // Prune expired timestamps
    const pruned = timestamps.filter((t) => t > windowStart);

    if (pruned.length >= this.config.maxRequests) {
      // Rate limited — don't record this attempt
      this.buckets.set(ip, pruned);
      const oldestInWindow = pruned[0]!;
      return {
        allowed: false,
        remaining: 0,
        resetAt: oldestInWindow + this.config.windowMs,
        limit: this.config.maxRequests,
      };
    }

    // Allowed — record the timestamp
    pruned.push(now);
    this.buckets.set(ip, pruned);

    return {
      allowed: true,
      remaining: this.config.maxRequests - pruned.length,
      resetAt: now + this.config.windowMs,
      limit: this.config.maxRequests,
    };
  }

  /**
   * Reset all tracked state. Useful for testing.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Get the number of IPs currently being tracked.
   */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Stop the background sweep timer.
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Remove entries whose newest timestamp is older than the window.
   */
  private sweep(): void {
    const cutoff = this.now() - this.config.windowMs;
    for (const [ip, timestamps] of this.buckets) {
      // If the newest timestamp is expired, remove the whole entry
      if (timestamps.length === 0 || timestamps[timestamps.length - 1]! <= cutoff) {
        this.buckets.delete(ip);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Concurrent Settlement Limiter
// ═══════════════════════════════════════════════════════════════════════

/**
 * Tracks and limits the number of concurrent in-flight settlements.
 *
 * A settlement is considered "in-flight" from the moment verification
 * passes (phase transitions past QUOTED) until it reaches a terminal
 * state (SETTLED or FAILED).
 */
export class SettlementLimiter {
  private inFlight = 0;
  private readonly max: number;

  constructor(maxConcurrent: number) {
    this.max = maxConcurrent;
  }

  /**
   * Attempt to acquire a settlement slot.
   *
   * @returns `true` if a slot was acquired, `false` if at capacity.
   */
  acquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight++;
    return true;
  }

  /**
   * Release a settlement slot. Call this when a settlement reaches a
   * terminal state (SETTLED, FAILED, or error).
   */
  release(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  /**
   * Current number of in-flight settlements.
   */
  get current(): number {
    return this.inFlight;
  }

  /**
   * Maximum allowed concurrent settlements.
   */
  get capacity(): number {
    return this.max;
  }

  /**
   * Whether there is at least one available slot.
   */
  get available(): boolean {
    return this.inFlight < this.max;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Quote Garbage Collector
// ═══════════════════════════════════════════════════════════════════════

/**
 * Periodically prunes stale swap states from the store.
 *
 * A state is eligible for GC when BOTH:
 *   - `now > createdAt + gracePeriodMs`
 *   - `phase ∈ GC_ELIGIBLE_PHASES` (QUOTED, EXPIRED, SETTLED, FAILED)
 *
 * In-flight phases (VERIFIED, BROADCASTING, BROADCAST, POLLING) are never
 * deleted — doing so would orphan the buyer's HTTP request mid-settlement.
 *
 * This prevents the state store from accumulating unbounded entries from
 * quotes that were never paid, and reclaims space from completed settlements.
 */
export class QuoteGarbageCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: StateStore,
    private readonly gracePeriodMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start the periodic GC. The first run happens after one interval.
   *
   * @param intervalMs  How often to run the GC sweep.
   */
  start(intervalMs: number): void {
    if (this.timer) return; // Already running
    this.timer = setInterval(() => { void this.sweep(); }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stop the periodic GC.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single GC sweep. Finds expired states and deletes them.
   *
   * This is idempotent and safe to call concurrently — the store's
   * `delete` is a no-op for non-existent keys.
   *
   * @returns The number of entries deleted.
   */
  async sweep(): Promise<number> {
    if (this.running) return 0; // Prevent overlapping sweeps
    this.running = true;
    try {
      const cutoffMs = this.now() - this.gracePeriodMs;
      const expired = await this.store.listExpired(cutoffMs, GC_ELIGIBLE_PHASES);
      let deleted = 0;
      for (const depositAddress of expired) {
        await this.store.delete(depositAddress);
        deleted++;
      }
      return deleted;
    } finally {
      this.running = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════

/**
 * All rate-limiting / abuse-prevention components bundled together.
 */
export interface RateLimitingDeps {
  quoteLimiter: QuoteRateLimiter;
  settlementLimiter: SettlementLimiter;
  quoteGc: QuoteGarbageCollector;
}

/**
 * Create all rate-limiting components from the gateway config and store.
 *
 * Starts the quote GC automatically if `quoteGcIntervalMs > 0`.
 */
export function createRateLimiting(
  cfg: GatewayConfig,
  store: StateStore,
): RateLimitingDeps {
  const quoteLimiter = new QuoteRateLimiter({
    maxRequests: cfg.rateLimitQuotesPerWindow,
    windowMs: cfg.rateLimitWindowMs,
  });

  const settlementLimiter = new SettlementLimiter(cfg.maxConcurrentSettlements);

  const quoteGc = new QuoteGarbageCollector(store, cfg.quoteGcGracePeriodMs);
  if (cfg.quoteGcIntervalMs > 0) {
    quoteGc.start(cfg.quoteGcIntervalMs);
  }

  return { quoteLimiter, settlementLimiter, quoteGc };
}

/**
 * Stop all background timers. Call on shutdown.
 */
export function destroyRateLimiting(deps: RateLimitingDeps): void {
  deps.quoteLimiter.destroy();
  deps.quoteGc.stop();
}
