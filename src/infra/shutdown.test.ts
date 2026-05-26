/**
 * Unit tests for the graceful-shutdown wait helper.
 *
 * The whole purpose of the helper is to wait until in-flight settlements
 * drain (current → 0) or until the grace period expires. These tests
 * exercise both outcomes plus the fast-path and the input-validation
 * guards. Real `SettlementLimiter` integration is implicit — the helper
 * just consumes a `.current` getter, so a tiny stub stands in.
 */

import { describe, it, expect, vi } from "vitest";
import {
  waitForSettlementsToFinish,
  type InFlightCounter,
} from "./shutdown.js";

/** Build a counter whose value is read live from a closure. */
function counterFromGetter(get: () => number): InFlightCounter {
  return {
    get current() {
      return get();
    },
  };
}

describe("waitForSettlementsToFinish — fast paths", () => {
  it("returns immediately with status=drained when current is already 0", async () => {
    const start = Date.now();
    const result = await waitForSettlementsToFinish(
      counterFromGetter(() => 0),
      30_000,
    );
    const elapsed = Date.now() - start;

    expect(result.status).toBe("drained");
    if (result.status === "drained") {
      expect(result.finalCount).toBe(0);
      expect(result.waitedMs).toBe(0);
    }
    // Fast-path must NOT spin up a timer.
    expect(elapsed).toBeLessThan(50);
  });
});

describe("waitForSettlementsToFinish — happy path (drains in time)", () => {
  it("returns drained as soon as the counter hits zero", async () => {
    let count = 3;
    // Simulate settlements completing one at a time over ~150 ms.
    setTimeout(() => { count = 2; }, 50);
    setTimeout(() => { count = 1; }, 100);
    setTimeout(() => { count = 0; }, 150);

    const start = Date.now();
    const result = await waitForSettlementsToFinish(
      counterFromGetter(() => count),
      5_000,
      25, // tight poll for fast test
    );
    const elapsed = Date.now() - start;

    expect(result.status).toBe("drained");
    if (result.status === "drained") {
      expect(result.finalCount).toBe(0);
      // Should have waited approximately until the last setTimeout fired
      // (150 ms), with one poll tick of slack on either side.
      expect(result.waitedMs).toBeGreaterThanOrEqual(150);
      expect(result.waitedMs).toBeLessThan(300);
    }
    // Sanity: well below the 5 s grace period.
    expect(elapsed).toBeLessThan(500);
  });

  it("invokes onTick on each poll while waiting", async () => {
    let count = 2;
    setTimeout(() => { count = 0; }, 80);

    const ticks: Array<{ current: number; elapsedMs: number }> = [];
    await waitForSettlementsToFinish(
      counterFromGetter(() => count),
      5_000,
      20,
      (current, elapsedMs) => ticks.push({ current, elapsedMs }),
    );

    expect(ticks.length).toBeGreaterThan(0);
    // First tick fires while count was still 2 (before the timer set it to 0).
    expect(ticks[0]!.current).toBeGreaterThan(0);
    // elapsedMs should be monotonically non-decreasing.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.elapsedMs).toBeGreaterThanOrEqual(ticks[i - 1]!.elapsedMs);
    }
  });
});

describe("waitForSettlementsToFinish — timeout path", () => {
  it("returns timeout with the surviving count when the grace period expires", async () => {
    // Stub: count never drops below 2.
    const counter = counterFromGetter(() => 2);

    const start = Date.now();
    const result = await waitForSettlementsToFinish(counter, 200, 50);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("timeout");
    if (result.status === "timeout") {
      expect(result.finalCount).toBe(2);
      expect(result.waitedMs).toBeGreaterThanOrEqual(200);
    }
    // Should have stopped polling at the deadline — not gone significantly past.
    expect(elapsed).toBeLessThan(400);
  });

  it("caps the poll interval at the grace period (never sleeps past the deadline)", async () => {
    // Asks for a 1 s poll inside a 100 ms grace budget — the helper should
    // clamp the sleep to ~100 ms and still return at the deadline.
    const counter = counterFromGetter(() => 1);
    const start = Date.now();
    const result = await waitForSettlementsToFinish(counter, 100, 1_000);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("timeout");
    // Forgive ~50 ms of timer slack on either side; the key invariant is
    // we did NOT wait the requested 1 s.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(400);
  });
});

describe("waitForSettlementsToFinish — input validation", () => {
  it("throws when graceMs <= 0", async () => {
    await expect(
      waitForSettlementsToFinish(counterFromGetter(() => 0), 0),
    ).rejects.toThrow(/graceMs must be positive/);
    await expect(
      waitForSettlementsToFinish(counterFromGetter(() => 0), -100),
    ).rejects.toThrow(/graceMs must be positive/);
  });

  it("throws when pollIntervalMs <= 0", async () => {
    await expect(
      waitForSettlementsToFinish(counterFromGetter(() => 0), 1_000, 0),
    ).rejects.toThrow(/pollIntervalMs must be positive/);
  });
});

describe("waitForSettlementsToFinish — integration with a real-shaped limiter", () => {
  // Sanity check that the helper accepts anything with a `.current` getter,
  // including the SettlementLimiter from rate-limiter.ts. We don't import
  // the real class to avoid coupling — just exercise the structural fit.
  it("accepts an object exposing only `current` (structural typing)", async () => {
    const minimal: InFlightCounter = { current: 0 };
    const result = await waitForSettlementsToFinish(minimal, 1_000);
    expect(result.status).toBe("drained");
  });

  it("re-reads current on every poll (lazy getter, not snapshot)", async () => {
    let calls = 0;
    const counter: InFlightCounter = {
      get current() {
        calls++;
        // Drain on the 3rd read.
        return calls >= 3 ? 0 : 1;
      },
    };
    const result = await waitForSettlementsToFinish(counter, 5_000, 20);
    expect(result.status).toBe("drained");
    // At least 3 reads: entry-time fast-path check, then ≥ 2 poll iterations.
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
