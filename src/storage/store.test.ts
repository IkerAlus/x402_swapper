/**
 * Tests for the State Store module.
 *
 * Tests are written against the {@link StateStore} interface so they can
 * run against any implementation. The `describeStore` helper runs the full
 * suite for both `SqliteStateStore` and `InMemoryStateStore`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SqliteStateStore,
  InMemoryStateStore,
  createStateStore,
  validatePhaseTransition,
  StateNotFoundError,
  InvalidPhaseTransitionError,
} from "./store.js";
import type { StateStore, SwapState, SwapPhase } from "../types.js";
import { VALID_PHASE_TRANSITIONS, GC_ELIGIBLE_PHASES } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

/** Build a minimal valid SwapState for testing (with the new required swap-as-resource fields). */
function makeSwapState(overrides: Partial<SwapState> = {}): SwapState {
  const now = Date.now();
  return {
    depositAddress: "0xDEPOSIT_001",
    swapInputs: {
      destinationChain: "near",
      destinationAsset: "nep141:usdc.near",
      destinationAddress: "alice.near",
      amountIn: "10000000",
    },
    operatorMarginBps: 30,
    quoteResponse: {
      correlationId: "corr-001",
      timestamp: new Date().toISOString(),
      signature: "sig-001",
      quoteRequest: { swapType: "EXACT_INPUT" },
      quote: {
        depositAddress: "0xDEPOSIT_001",
        amountIn: "10000000",
        amountInFormatted: "10.00",
        amountInUsd: "10.00",
        minAmountIn: "10000000",
        amountOut: "9985000",
        amountOutFormatted: "9.985",
        amountOutUsd: "9.99",
        minAmountOut: "9950000",
        deadline: new Date(now + 300_000).toISOString(),
        timeEstimate: 60,
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "10030000",
      payTo: "0xDEPOSIT_001",
      maxTimeoutSeconds: 270,
      extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
    },
    phase: "QUOTED" as SwapPhase,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Shared test suite — runs against both implementations
// ═══════════════════════════════════════════════════════════════════════

function describeStore(
  name: string,
  factory: () => Promise<{ store: StateStore; cleanup: () => Promise<void> }>,
) {
  describe(name, () => {
    let store: StateStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const result = await factory();
      store = result.store;
      cleanup = result.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // ── create / get ─────────────────────────────────────────────────

    it("creates and retrieves a swap state, preserving every field through serialization", async () => {
      const state = makeSwapState({
        paymentPayload: {
          x402Version: 2,
          accepted: makeSwapState().paymentRequirements,
          payload: { authorization: "0xSIG" },
        },
        signerAddress: "0xBUYER",
        originTxHash: "0xTXHASH",
        oneClickStatus: "SUCCESS",
        settledAt: Date.now(),
        settlementResponse: {
          success: true,
          transaction: "0xTXHASH",
          network: "eip155:8453",
          extra: { settlementType: "crosschain-1cs", swapStatus: "SUCCESS", correlationId: "corr-001" },
        },
      });
      await store.create(state.depositAddress, state);

      const retrieved = await store.get(state.depositAddress);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.depositAddress).toBe(state.depositAddress);
      expect(retrieved!.swapInputs).toEqual(state.swapInputs);
      expect(retrieved!.operatorMarginBps).toBe(state.operatorMarginBps);
      expect(retrieved!.quoteResponse.correlationId).toBe("corr-001");
      expect(retrieved!.signerAddress).toBe("0xBUYER");
      expect(retrieved!.settlementResponse?.extra?.settlementType).toBe("crosschain-1cs");
    });

    it("returns null for a non-existent deposit address", async () => {
      expect(await store.get("0xNON_EXISTENT")).toBeNull();
    });

    it("create is idempotent — the second call overwrites the first", async () => {
      await store.create("0xABC", makeSwapState({ depositAddress: "0xABC" }));
      await store.create(
        "0xABC",
        makeSwapState({
          depositAddress: "0xABC",
          quoteResponse: { ...makeSwapState().quoteResponse, correlationId: "corr-002" },
        }),
      );
      expect((await store.get("0xABC"))!.quoteResponse.correlationId).toBe("corr-002");
    });

    // ── update ────────────────────────────────────────────────────────

    it("applies a partial patch (preserving original fields) and bumps updatedAt; throws on missing state", async () => {
      const state = makeSwapState({ createdAt: 1000, updatedAt: 1000 });
      await store.create(state.depositAddress, state);

      const beforeUpdate = Date.now();
      await store.update(state.depositAddress, { phase: "VERIFIED", signerAddress: "0xBUYER" });

      const retrieved = await store.get(state.depositAddress);
      expect(retrieved!.phase).toBe("VERIFIED");
      expect(retrieved!.signerAddress).toBe("0xBUYER");
      expect(retrieved!.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
      expect(retrieved!.createdAt).toBe(1000);
      expect(retrieved!.quoteResponse.correlationId).toBe("corr-001");

      await expect(store.update("0xNON_EXISTENT", { phase: "VERIFIED" })).rejects.toThrow(StateNotFoundError);
    });

    // ── phase transitions ────────────────────────────────────────────

    it("enforces phase-transition rules (allows valid; rejects invalid; rejects exits from terminal)", async () => {
      // Valid transitions from QUOTED.
      for (const next of ["VERIFIED", "EXPIRED", "FAILED"] as SwapPhase[]) {
        const addr = `0x_TO_${next}`;
        await store.create(addr, makeSwapState({ depositAddress: addr, phase: "QUOTED" }));
        await expect(store.update(addr, { phase: next })).resolves.not.toThrow();
      }

      // Invalid skip-ahead.
      await store.create("0xSKIP", makeSwapState({ depositAddress: "0xSKIP", phase: "QUOTED" }));
      await expect(store.update("0xSKIP", { phase: "SETTLED" })).rejects.toThrow(
        InvalidPhaseTransitionError,
      );

      // Terminal phases have no exits.
      for (const terminal of ["SETTLED", "FAILED", "EXPIRED"] as SwapPhase[]) {
        const addr = `0x_${terminal}`;
        await store.create(addr, makeSwapState({ depositAddress: addr, phase: terminal }));
        await expect(store.update(addr, { phase: "QUOTED" })).rejects.toThrow(
          InvalidPhaseTransitionError,
        );
      }
    });

    it("update without phase change bypasses transition validation (status-only patches)", async () => {
      await store.create("0xPOLL", makeSwapState({ depositAddress: "0xPOLL", phase: "POLLING" }));
      await expect(
        store.update("0xPOLL", { oneClickStatus: "PROCESSING" }),
      ).resolves.not.toThrow();
    });

    it("walks through the full happy-path lifecycle QUOTED → VERIFIED → BROADCASTING → BROADCAST → POLLING → SETTLED", async () => {
      const state = makeSwapState({ phase: "QUOTED" });
      await store.create(state.depositAddress, state);

      for (const next of ["VERIFIED", "BROADCASTING", "BROADCAST", "POLLING", "SETTLED"] as SwapPhase[]) {
        await store.update(state.depositAddress, { phase: next });
        expect((await store.get(state.depositAddress))!.phase).toBe(next);
      }
    });

    // ── listExpired ──────────────────────────────────────────────────

    it("listExpired returns addresses older than the threshold (and respects in-flight phase exclusion when filtering)", async () => {
      // Prepare three states:
      //   0xQUOTE — old QUOTED (eligible)
      //   0xPOLL  — old POLLING (in-flight; NOT GC-eligible)
      //   0xDONE  — old SETTLED (terminal; eligible)
      //   0xRECENT — recent (should never expire)
      await store.create("0xQUOTE", makeSwapState({ depositAddress: "0xQUOTE", createdAt: 1_000, phase: "QUOTED" }));
      await store.create("0xRECENT", makeSwapState({ depositAddress: "0xRECENT", createdAt: Date.now() }));

      // Walk to POLLING via valid path.
      await store.create("0xPOLL", makeSwapState({ depositAddress: "0xPOLL", createdAt: 1_000, phase: "QUOTED" }));
      for (const next of ["VERIFIED", "BROADCASTING", "BROADCAST", "POLLING"] as SwapPhase[]) {
        await store.update("0xPOLL", next === "BROADCAST" ? { phase: next, originTxHash: "0xT" } : { phase: next });
      }
      // Walk to SETTLED.
      await store.create("0xDONE", makeSwapState({ depositAddress: "0xDONE", createdAt: 1_000, phase: "QUOTED" }));
      for (const next of ["VERIFIED", "BROADCASTING", "BROADCAST", "POLLING", "SETTLED"] as SwapPhase[]) {
        await store.update("0xDONE", next === "BROADCAST" ? { phase: next, originTxHash: "0xT2" } : { phase: next });
      }

      // Without the phase filter: all old states are expired regardless of phase.
      const allExpired = await store.listExpired(5_000);
      expect(allExpired).toEqual(expect.arrayContaining(["0xQUOTE", "0xPOLL", "0xDONE"]));
      expect(allExpired).not.toContain("0xRECENT");

      // With GC_ELIGIBLE_PHASES: in-flight POLLING is excluded.
      const gcEligible = await store.listExpired(5_000, GC_ELIGIBLE_PHASES);
      expect(gcEligible).toEqual(expect.arrayContaining(["0xQUOTE", "0xDONE"]));
      expect(gcEligible).not.toContain("0xPOLL");
    });

    it("listExpired returns [] when no states are old enough", async () => {
      await store.create("0xR", makeSwapState({ depositAddress: "0xR", createdAt: Date.now() }));
      expect(await store.listExpired(1_000)).toEqual([]);
    });

    // ── listByPhase ─────────────────────────────────────────────────

    it("listByPhase returns matching states (and deep copies — mutating the result doesn't affect the store)", async () => {
      await store.create("0xA", makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }));

      const [first] = await store.listByPhase("QUOTED");
      first!.depositAddress = "MUTATED";
      const [second] = await store.listByPhase("QUOTED");
      expect(second!.depositAddress).toBe("0xA");

      expect(await store.listByPhase("POLLING")).toEqual([]);
    });

    // ── delete + multi-state ────────────────────────────────────────

    it("delete removes a state (no-op on non-existent); operations on unrelated states are independent", async () => {
      await store.create("0xA", makeSwapState({ depositAddress: "0xA" }));
      await store.create("0xB", makeSwapState({ depositAddress: "0xB" }));
      await store.create("0xC", makeSwapState({ depositAddress: "0xC" }));

      await store.update("0xB", { phase: "VERIFIED" });
      expect((await store.get("0xA"))!.phase).toBe("QUOTED");
      expect((await store.get("0xB"))!.phase).toBe("VERIFIED");
      expect((await store.get("0xC"))!.phase).toBe("QUOTED");

      await store.delete("0xA");
      expect(await store.get("0xA")).toBeNull();

      await expect(store.delete("0xNON_EXISTENT")).resolves.not.toThrow();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Run shared suite against both implementations
// ═══════════════════════════════════════════════════════════════════════

describeStore("SqliteStateStore", async () => {
  const store = new SqliteStateStore();
  await store.init();
  return { store, cleanup: () => store.close() };
});

describeStore("InMemoryStateStore", async () => {
  const store = new InMemoryStateStore();
  return { store, cleanup: async () => store.clear() };
});

// ═══════════════════════════════════════════════════════════════════════
// SQLite-specific
// ═══════════════════════════════════════════════════════════════════════

describe("SqliteStateStore (specific)", () => {
  it("throws if used before init()", async () => {
    const store = new SqliteStateStore();
    await expect(store.get("0xABC")).rejects.toThrow("not initialized");
  });

  it("supports countByPhase and count() (used by health/metrics endpoints)", async () => {
    const store = new SqliteStateStore();
    await store.init();
    expect(await store.count()).toBe(0);

    await store.create("0xA", makeSwapState({ depositAddress: "0xA", phase: "QUOTED" }));
    await store.create("0xB", makeSwapState({ depositAddress: "0xB", phase: "QUOTED" }));
    await store.create("0xC", makeSwapState({ depositAddress: "0xC", phase: "POLLING" }));

    expect(await store.count()).toBe(3);
    const counts = await store.countByPhase();
    expect(counts.QUOTED).toBe(2);
    expect(counts.POLLING).toBe(1);

    await store.delete("0xA");
    expect(await store.count()).toBe(2);
    await store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validatePhaseTransition (unit tests over the full transition map)
// ═══════════════════════════════════════════════════════════════════════

describe("validatePhaseTransition", () => {
  it("accepts every transition in VALID_PHASE_TRANSITIONS; rejects every other transition with InvalidPhaseTransitionError carrying both phase names", () => {
    const allPhases: SwapPhase[] = [
      "QUOTED", "VERIFIED", "BROADCASTING", "BROADCAST", "POLLING", "SETTLED", "FAILED", "EXPIRED",
    ];
    for (const [from, allowed] of VALID_PHASE_TRANSITIONS) {
      for (const to of allowed) {
        expect(() => validatePhaseTransition(from, to)).not.toThrow();
      }
      for (const to of allPhases) {
        if (from === to || allowed.has(to)) continue;
        expect(() => validatePhaseTransition(from, to)).toThrow(InvalidPhaseTransitionError);
      }
    }

    try {
      validatePhaseTransition("SETTLED", "QUOTED");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPhaseTransitionError);
      expect((err as InvalidPhaseTransitionError).fromPhase).toBe("SETTLED");
      expect((err as InvalidPhaseTransitionError).toPhase).toBe("QUOTED");
      expect((err as Error).message).toContain("SETTLED");
      expect((err as Error).message).toContain("QUOTED");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// createStateStore factory
// ═══════════════════════════════════════════════════════════════════════

describe("createStateStore", () => {
  it("selects backend by option (default sqlite, explicit sqlite, memory) and rejects unknown backends", async () => {
    const sqliteDefault = await createStateStore();
    await sqliteDefault.create("0x1", makeSwapState({ depositAddress: "0x1" }));
    expect(await sqliteDefault.get("0x1")).not.toBeNull();
    if ("close" in sqliteDefault) await (sqliteDefault as SqliteStateStore).close();

    const sqliteExplicit = await createStateStore({ backend: "sqlite" });
    await sqliteExplicit.create("0x2", makeSwapState({ depositAddress: "0x2" }));
    if ("close" in sqliteExplicit) await (sqliteExplicit as SqliteStateStore).close();

    const memory = await createStateStore({ backend: "memory" });
    expect(memory).toBeInstanceOf(InMemoryStateStore);

    await expect(createStateStore({ backend: "redis" as "sqlite" })).rejects.toThrow("Unknown state store backend");
  });
});
