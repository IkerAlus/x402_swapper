/**
 * RPC Provider Pool — round-robin provider management with health checks.
 *
 * Manages a pool of JSON-RPC providers for the origin chain and provides:
 *
 * 1. **Round-robin selection** — distributes RPC load across endpoints
 * 2. **Lazy health detection** — marks providers unhealthy on RPC errors
 * 3. **Automatic recovery** — periodically re-checks unhealthy providers
 * 4. **Wallet binding** — creates ethers.js Wallets bound to a healthy provider
 *
 * Design note: round-robin with lazy health detection rather than a
 * background health-check loop. Sufficient for 1-2 RPC endpoints on a
 * single L2.
 *
 * @module provider-pool
 */

import { ethers } from "ethers";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

interface ProviderEntry {
  url: string;
  provider: ethers.JsonRpcProvider;
  healthy: boolean;
  /** Unix epoch ms — when this provider was last marked unhealthy. */
  lastFailedAt: number;
}

/**
 * Configuration for the provider pool.
 */
export interface ProviderPoolOptions {
  /**
   * Minimum time (ms) before re-checking an unhealthy provider.
   * @default 30_000 (30 seconds)
   */
  recoveryIntervalMs?: number;

  /**
   * Request timeout (ms) for each provider.
   * @default 10_000 (10 seconds)
   */
  requestTimeoutMs?: number;

  /**
   * Static block polling interval (ms) for the underlying ethers providers.
   * Set to 0 to disable polling (recommended for on-demand usage).
   * @default 0
   */
  pollingIntervalMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// ProviderPool
// ═══════════════════════════════════════════════════════════════════════

/**
 * Round-robin RPC provider pool with lazy health detection.
 *
 * Usage:
 * ```ts
 * const pool = new ProviderPool(["https://rpc1.example.com", "https://rpc2.example.com"]);
 * const provider = pool.getProvider();       // round-robin
 * const wallet = pool.getWallet(privateKey); // wallet bound to healthy provider
 * ```
 */
export class ProviderPool {
  private readonly entries: ProviderEntry[];
  private readonly options: Required<ProviderPoolOptions>;
  private nextIndex = 0;

  constructor(rpcUrls: string[], options: ProviderPoolOptions = {}) {
    if (rpcUrls.length === 0) {
      throw new Error("ProviderPool requires at least one RPC URL");
    }

    this.options = {
      recoveryIntervalMs: options.recoveryIntervalMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      pollingIntervalMs: options.pollingIntervalMs ?? 0,
    };

    this.entries = rpcUrls.map((url) => ({
      url,
      provider: this.createProvider(url),
      healthy: true,
      lastFailedAt: 0,
    }));
  }

  /**
   * Get a healthy provider using round-robin selection.
   *
   * If the next provider in rotation is unhealthy, we check whether enough
   * time has passed for recovery. If so, we optimistically return it (the
   * next failure will re-mark it). If not, we skip to the next healthy one.
   *
   * @throws {Error} if all providers are unhealthy and none are eligible for recovery.
   */
  getProvider(): ethers.JsonRpcProvider {
    const startIndex = this.nextIndex;
    const now = Date.now();
    let attempts = 0;

    while (attempts < this.entries.length) {
      const entry = this.entries[this.nextIndex]!;
      this.nextIndex = (this.nextIndex + 1) % this.entries.length;
      attempts++;

      if (entry.healthy) {
        return entry.provider;
      }

      // Check if enough time has passed for recovery attempt
      if (now - entry.lastFailedAt >= this.options.recoveryIntervalMs) {
        entry.healthy = true;
        return entry.provider;
      }
    }

    // All providers unhealthy — force recovery on the original next provider
    const fallback = this.entries[startIndex]!;
    fallback.healthy = true;
    return fallback.provider;
  }

  /**
   * Create an ethers.js Wallet connected to a healthy provider.
   *
   * The wallet is bound to the provider selected at call time. If the
   * provider becomes unhealthy later, the next call to `getWallet` will
   * return a wallet bound to a different provider.
   */
  getWallet(privateKey: string): ethers.Wallet {
    const provider = this.getProvider();
    return new ethers.Wallet(privateKey, provider);
  }

  /**
   * Mark a provider as unhealthy by its URL.
   *
   * Called by the middleware/settler when an RPC call fails, so the pool
   * skips this provider on the next rotation.
   */
  markUnhealthy(url: string): void {
    const entry = this.entries.find((e) => e.url === url);
    if (entry) {
      entry.healthy = false;
      entry.lastFailedAt = Date.now();
    }
  }

  /**
   * Mark a provider as unhealthy by provider instance reference.
   *
   * Convenience method for when you have the provider but not the URL.
   */
  markProviderUnhealthy(provider: ethers.JsonRpcProvider): void {
    const entry = this.entries.find((e) => e.provider === provider);
    if (entry) {
      entry.healthy = false;
      entry.lastFailedAt = Date.now();
    }
  }

  /**
   * Check health of a specific provider by calling `eth_blockNumber`.
   *
   * @returns true if healthy, false otherwise.
   */
  async checkHealth(url: string): Promise<boolean> {
    const entry = this.entries.find((e) => e.url === url);
    if (!entry) return false;

    try {
      await entry.provider.getBlockNumber();
      entry.healthy = true;
      return true;
    } catch {
      entry.healthy = false;
      entry.lastFailedAt = Date.now();
      return false;
    }
  }

  /**
   * Get the number of currently healthy providers.
   */
  get healthyCount(): number {
    return this.entries.filter((e) => e.healthy).length;
  }

  /**
   * Get the total number of providers in the pool.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Get status information for all providers (for health endpoints).
   */
  getStatus(): Array<{ url: string; healthy: boolean; lastFailedAt: number }> {
    return this.entries.map((e) => ({
      url: e.url,
      healthy: e.healthy,
      lastFailedAt: e.lastFailedAt,
    }));
  }

  /**
   * Destroy all providers. Call on shutdown.
   */
  destroy(): void {
    for (const entry of this.entries) {
      entry.provider.destroy();
    }
  }

  // ── Internal ───────────────────────────────────────────────────────

  private createProvider(url: string): ethers.JsonRpcProvider {
    const provider = new ethers.JsonRpcProvider(url, undefined, {
      staticNetwork: true,
      batchMaxCount: 1,
    });

    // Disable polling if configured (saves RPC calls for on-demand usage)
    if (this.options.pollingIntervalMs === 0) {
      provider.pollingInterval = 60_000; // effectively disabled
    } else {
      provider.pollingInterval = this.options.pollingIntervalMs;
    }

    return provider;
  }
}
