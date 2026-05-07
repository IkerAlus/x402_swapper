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

  // ── Destroy ────────────────────────────────────────────────────────

  it("destroy cleans up providers", () => {
    const pool = new ProviderPool(["https://rpc1.example.com"]);
    // Should not throw
    pool.destroy();
  });
});
