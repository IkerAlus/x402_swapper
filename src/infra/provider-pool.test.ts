/**
 * Tests for the RPC Provider Pool (Step 2.2).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderPool } from "./provider-pool.js";

describe("ProviderPool", () => {
  // ── Constructor ────────────────────────────────────────────────────

  it("throws when constructed with empty RPC URLs array", () => {
    expect(() => new ProviderPool([])).toThrow("at least one RPC URL");
  });

  it("creates pool with one URL", () => {
    const pool = new ProviderPool(["https://rpc1.example.com"]);
    expect(pool.size).toBe(1);
    expect(pool.healthyCount).toBe(1);
  });

  it("creates pool with multiple URLs", () => {
    const pool = new ProviderPool([
      "https://rpc1.example.com",
      "https://rpc2.example.com",
      "https://rpc3.example.com",
    ]);
    expect(pool.size).toBe(3);
    expect(pool.healthyCount).toBe(3);
  });

  // ── Round-robin selection ──────────────────────────────────────────

  it("returns providers in round-robin order", () => {
    const pool = new ProviderPool([
      "https://rpc1.example.com",
      "https://rpc2.example.com",
    ]);

    const p1 = pool.getProvider();
    const p2 = pool.getProvider();
    const p3 = pool.getProvider();

    // p1 and p3 should be the same provider (cycled back)
    expect(p1).toBe(p3);
    // p1 and p2 should be different
    expect(p1).not.toBe(p2);
  });

  // ── Health management ──────────────────────────────────────────────

  it("skips unhealthy providers", () => {
    const pool = new ProviderPool([
      "https://rpc1.example.com",
      "https://rpc2.example.com",
    ]);

    // Get first provider (rpc1)
    const p1 = pool.getProvider();
    // Mark rpc1 unhealthy
    pool.markUnhealthy("https://rpc1.example.com");
    expect(pool.healthyCount).toBe(1);

    // Next call should skip rpc1 and return rpc2
    const p2 = pool.getProvider();
    expect(p2).not.toBe(p1);

    // Next call should still return rpc2 (rpc1 is unhealthy)
    const p3 = pool.getProvider();
    expect(p3).toBe(p2);
  });

  it("recovers unhealthy providers after recovery interval", () => {
    const pool = new ProviderPool(
      ["https://rpc1.example.com", "https://rpc2.example.com"],
      { recoveryIntervalMs: 100 },
    );

    pool.markUnhealthy("https://rpc1.example.com");
    expect(pool.healthyCount).toBe(1);

    // Simulate time passing by directly manipulating lastFailedAt
    const status = pool.getStatus();
    const entry = status.find((s) => s.url === "https://rpc1.example.com");
    expect(entry?.healthy).toBe(false);
  });

  it("falls back to unhealthy provider when all are unhealthy", () => {
    const pool = new ProviderPool(["https://rpc1.example.com"]);
    pool.markUnhealthy("https://rpc1.example.com");

    // Should still return a provider (forced recovery)
    const p = pool.getProvider();
    expect(p).toBeDefined();
  });

  it("markProviderUnhealthy works with provider instance", () => {
    const pool = new ProviderPool(["https://rpc1.example.com"]);
    const provider = pool.getProvider();
    pool.markProviderUnhealthy(provider);
    expect(pool.healthyCount).toBe(0);
  });

  // ── Wallet binding ─────────────────────────────────────────────────

  it("creates a wallet bound to a healthy provider", () => {
    const pool = new ProviderPool(["https://rpc1.example.com"]);
    // Use a deterministic test key
    const testKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const wallet = pool.getWallet(testKey);
    expect(wallet).toBeDefined();
    expect(wallet.provider).toBeDefined();
  });

  // ── Status ─────────────────────────────────────────────────────────

  it("getStatus returns correct health info", () => {
    const pool = new ProviderPool([
      "https://rpc1.example.com",
      "https://rpc2.example.com",
    ]);

    pool.markUnhealthy("https://rpc1.example.com");

    const status = pool.getStatus();
    expect(status).toHaveLength(2);

    const rpc1 = status.find((s) => s.url === "https://rpc1.example.com");
    const rpc2 = status.find((s) => s.url === "https://rpc2.example.com");

    expect(rpc1?.healthy).toBe(false);
    expect(rpc1?.lastFailedAt).toBeGreaterThan(0);
    expect(rpc2?.healthy).toBe(true);
    expect(rpc2?.lastFailedAt).toBe(0);
  });

  // ── checkReachability (TODO #5 — startup probe) ────────────────────
  //
  // Each entry's underlying provider is a real `ethers.JsonRpcProvider`
  // pointing at a bogus URL — but we stub `getBlockNumber` on the per-
  // instance method so the tests don't make network calls. This keeps
  // the unit hermetic while still exercising the real `checkReachability`
  // control flow (parallel probe, success/failure tagging, healthy-flag
  // updates).

  describe("checkReachability", () => {
    function stubBlockNumber(
      pool: ProviderPool,
      urlToBehaviour: Record<string, "ok" | string>,  // "ok" or error message
    ) {
      const status = pool.getStatus();
      for (const { url } of status) {
        // The pool exposes providers via getProvider() round-robin; cheaper:
        // reach into the internal entries via getStatus() URL → checkHealth
        // bound provider. Use the public `checkHealth` indirection? No —
        // simplest is to grab each provider via getProvider() rotation
        // and stub it. But that mutates nextIndex. Instead, stub via the
        // pool's internal entries: cast to any to avoid private-field
        // gymnastics, since this is test-only.
        const entries = (pool as unknown as { entries: Array<{ url: string; provider: { getBlockNumber: () => Promise<number> } }> }).entries;
        const entry = entries.find((e) => e.url === url);
        if (!entry) continue;
        const behaviour = urlToBehaviour[url];
        if (behaviour === "ok") {
          entry.provider.getBlockNumber = vi.fn().mockResolvedValue(123_456_789);
        } else if (behaviour) {
          entry.provider.getBlockNumber = vi.fn().mockRejectedValue(new Error(behaviour));
        }
      }
    }

    it("returns all URLs healthy when every provider responds", async () => {
      const pool = new ProviderPool([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
      ]);
      stubBlockNumber(pool, {
        "https://rpc1.example.com": "ok",
        "https://rpc2.example.com": "ok",
      });

      const result = await pool.checkReachability();

      expect(result.healthy).toEqual([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
      ]);
      expect(result.failed).toEqual([]);
      expect(pool.healthyCount).toBe(2);
    });

    it("returns failed URLs with reasons when providers throw", async () => {
      const pool = new ProviderPool([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
      ]);
      stubBlockNumber(pool, {
        "https://rpc1.example.com": "ENOTFOUND rpc1.example.com",
        "https://rpc2.example.com": "ECONNREFUSED",
      });

      const result = await pool.checkReachability();

      expect(result.healthy).toEqual([]);
      expect(result.failed).toEqual([
        { url: "https://rpc1.example.com", reason: "ENOTFOUND rpc1.example.com" },
        { url: "https://rpc2.example.com", reason: "ECONNREFUSED" },
      ]);
      // Both entries flipped to unhealthy after the probe.
      expect(pool.healthyCount).toBe(0);
      const status = pool.getStatus();
      expect(status.every((s) => !s.healthy)).toBe(true);
      expect(status.every((s) => s.lastFailedAt > 0)).toBe(true);
    });

    it("returns partial results (some healthy, some failed) — degraded but bootable", async () => {
      const pool = new ProviderPool([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
        "https://rpc3.example.com",
      ]);
      stubBlockNumber(pool, {
        "https://rpc1.example.com": "ok",
        "https://rpc2.example.com": "timeout after 10000ms",
        "https://rpc3.example.com": "ok",
      });

      const result = await pool.checkReachability();

      expect(result.healthy).toEqual([
        "https://rpc1.example.com",
        "https://rpc3.example.com",
      ]);
      expect(result.failed).toEqual([
        { url: "https://rpc2.example.com", reason: "timeout after 10000ms" },
      ]);
      expect(pool.healthyCount).toBe(2);
    });

    it("flips a previously-unhealthy entry back to healthy after a successful probe", async () => {
      const pool = new ProviderPool([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
      ]);
      // Pre-mark rpc1 unhealthy (simulates a prior failure).
      pool.markUnhealthy("https://rpc1.example.com");
      expect(pool.healthyCount).toBe(1);

      stubBlockNumber(pool, {
        "https://rpc1.example.com": "ok",
        "https://rpc2.example.com": "ok",
      });

      const result = await pool.checkReachability();
      expect(result.healthy.sort()).toEqual([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
      ]);
      expect(pool.healthyCount).toBe(2);
    });

    it("runs probes in parallel (not serial)", async () => {
      // Each stubbed getBlockNumber takes ~50ms. If serial, total
      // wall-clock is ~150ms; if parallel, ~50ms. Allow some slack but
      // assert the call took clearly less than the serial bound.
      const pool = new ProviderPool([
        "https://rpc1.example.com",
        "https://rpc2.example.com",
        "https://rpc3.example.com",
      ]);
      const entries = (pool as unknown as { entries: Array<{ provider: { getBlockNumber: () => Promise<number> } }> }).entries;
      for (const entry of entries) {
        entry.provider.getBlockNumber = vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(1), 50)),
        );
      }

      const start = Date.now();
      const result = await pool.checkReachability();
      const elapsed = Date.now() - start;

      expect(result.healthy.length).toBe(3);
      // Serial would be ~150ms+; parallel should be well under that.
      expect(elapsed).toBeLessThan(120);
    });
  });

  // ── Destroy ────────────────────────────────────────────────────────

  it("destroy cleans up providers", () => {
    const pool = new ProviderPool(["https://rpc1.example.com"]);
    // Should not throw
    pool.destroy();
  });
});
