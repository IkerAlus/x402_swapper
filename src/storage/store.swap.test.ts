/**
 * Tests for swap-mode-specific storage behavior.
 *
 * Covers:
 *  - The `state_json` blob round-trips `swapInputs` and `operatorMarginBps`
 *    cleanly through both the SQLite and in-memory store implementations.
 *  - The `SqliteStateStore.init()` stale-DB fail-fast check (D12) refuses
 *    to boot when an existing row's JSON lacks `swapInputs`.
 */

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SqliteStateStore,
  InMemoryStateStore,
} from "./store.js";
import { mockSwapState } from "../mocks/index.js";

// ═══════════════════════════════════════════════════════════════════════
// state_json round-trip — both store implementations carry the new fields
// ═══════════════════════════════════════════════════════════════════════

describe("SwapState round-trip — InMemoryStateStore", () => {
  it("preserves swapInputs and operatorMarginBps verbatim", async () => {
    const store = new InMemoryStateStore();
    const original = mockSwapState();
    await store.create(original.depositAddress, original);

    const loaded = await store.get(original.depositAddress);
    expect(loaded).toBeDefined();
    expect(loaded!.swapInputs).toEqual(original.swapInputs);
    expect(loaded!.operatorMarginBps).toBe(original.operatorMarginBps);
  });
});

describe("SwapState round-trip — SqliteStateStore", () => {
  it("preserves swapInputs and operatorMarginBps verbatim through the JSON blob", async () => {
    const store = new SqliteStateStore();
    await store.init();

    const original = mockSwapState();
    await store.create(original.depositAddress, original);

    const loaded = await store.get(original.depositAddress);
    expect(loaded).toBeDefined();
    expect(loaded!.swapInputs).toEqual(original.swapInputs);
    expect(loaded!.operatorMarginBps).toBe(original.operatorMarginBps);

    await store.close();
  });

  it("preserves the buyer's optional refundAddress when supplied", async () => {
    const store = new SqliteStateStore();
    await store.init();

    const original = mockSwapState({
      swapInputs: {
        destinationChain: "near",
        destinationAsset: "nep141:usdc.near",
        destinationAddress: "alice.near",
        amountIn: "10000000",
        refundAddress: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
      },
    });
    await store.create(original.depositAddress, original);
    const loaded = await store.get(original.depositAddress);

    expect(loaded!.swapInputs.refundAddress).toBe("0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");

    await store.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Stale-DB fail-fast (D12 — implementation_plan.md)
// ═══════════════════════════════════════════════════════════════════════

describe("SqliteStateStore.init() — stale-DB fail-fast (D12)", () => {
  let tmpFiles: string[] = [];

  afterEach(async () => {
    for (const file of tmpFiles) {
      await fs.rm(file, { force: true });
    }
    tmpFiles = [];
  });

  /** Create a temp DB file and pre-populate it with a row whose JSON we control. */
  async function makeTempDbWithRow(rowJson: string): Promise<string> {
    const filePath = path.join(os.tmpdir(), `x402-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpFiles.push(filePath);

    // Bootstrap the file via the store's normal init() so the schema exists,
    // then write a malformed row directly.
    const seedStore = new SqliteStateStore({ filePath });
    await seedStore.init();
    // Use the `create` API to seed a real row, then mutate the blob.
    const fakeAddress = "0xstaledead00000000000000000000000000000000";
    await seedStore.create(fakeAddress, mockSwapState({ depositAddress: fakeAddress }));
    await seedStore.close();

    // Now mutate the file via a fresh sql.js instance to corrupt the blob.
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs();
    const buffer = await fs.readFile(filePath);
    const db = new SQL.Database(buffer);
    db.run("DELETE FROM swap_states");
    db.run(
      "INSERT INTO swap_states (deposit_address, phase, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [fakeAddress, "QUOTED", rowJson, Date.now(), Date.now()],
    );
    const data = db.export();
    await fs.writeFile(filePath, Buffer.from(data));
    db.close();

    return filePath;
  }

  it("boots cleanly on an empty DB", async () => {
    const filePath = path.join(os.tmpdir(), `x402-empty-${Date.now()}.db`);
    tmpFiles.push(filePath);

    const store = new SqliteStateStore({ filePath });
    await expect(store.init()).resolves.not.toThrow();
    await store.close();
  });

  it("boots cleanly on a DB whose rows already carry swapInputs", async () => {
    const filePath = path.join(os.tmpdir(), `x402-fresh-${Date.now()}.db`);
    tmpFiles.push(filePath);

    const seedStore = new SqliteStateStore({ filePath });
    await seedStore.init();
    await seedStore.create("0xfreshfreshfreshfreshfreshfreshfreshfresh", mockSwapState());
    await seedStore.close();

    // Re-open: should not throw.
    const reopened = new SqliteStateStore({ filePath });
    await expect(reopened.init()).resolves.not.toThrow();
    await reopened.close();
  });

  it("throws on a stale predecessor DB (rows lack swapInputs)", async () => {
    // Simulate the merchant-mode predecessor: a row whose state_json has
    // the legacy shape (no swapInputs, no operatorMarginBps).
    const legacyJson = JSON.stringify({
      depositAddress: "0xstaledead00000000000000000000000000000000",
      quoteResponse: { correlationId: "legacy-corr-id", quote: { amountIn: "1000000" } },
      paymentRequirements: { scheme: "exact" },
      phase: "QUOTED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const filePath = await makeTempDbWithRow(legacyJson);

    const store = new SqliteStateStore({ filePath });
    await expect(store.init()).rejects.toThrow(/stale state database/i);
  });

  it("includes a pointer to the operator guide in the stale-DB error", async () => {
    const legacyJson = JSON.stringify({ phase: "QUOTED" });
    const filePath = await makeTempDbWithRow(legacyJson);

    const store = new SqliteStateStore({ filePath });
    await expect(store.init()).rejects.toThrow(/OPERATOR_GUIDE/);
  });

  it("does not throw on rows whose state_json is corrupt (different problem)", async () => {
    // Corrupt JSON falls through — the check doesn't mask other errors as "stale".
    const filePath = await makeTempDbWithRow("not valid json {{");
    const store = new SqliteStateStore({ filePath });
    await expect(store.init()).resolves.not.toThrow();
    await store.close();
  });
});
