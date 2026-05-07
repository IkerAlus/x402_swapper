/**
 * State Store — persistent swap state management.
 *
 * This module provides the {@link StateStore} implementation for the gateway.
 * The initial implementation uses SQLite (via sql.js) for single-instance
 * deployments. The design is structured so that swapping to Redis (or any
 * other backend) requires only implementing the {@link StateStore} interface
 * from `../types.ts` — no changes to consuming code.
 *
 * Key behaviors:
 * - `create` is idempotent: re-quoting the same deposit address overwrites
 * - `update` enforces optimistic locking via phase transition validation
 * - `listExpired` supports background cleanup of stale states
 *
 * @module store
 */

import initSqlJs, { type Database } from "sql.js";
import type { StateStore, SwapState, SwapPhase } from "../types.js";
import { VALID_PHASE_TRANSITIONS } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════
// SQLite implementation
// ═══════════════════════════════════════════════════════════════════════

/**
 * SQLite-backed implementation of {@link StateStore}.
 *
 * Stores each {@link SwapState} as a row with the deposit address as the
 * primary key and the full state serialized as JSON. Indexed columns
 * (`phase`, `created_at`) support efficient queries for expiry and
 * phase-based lookups.
 *
 * Thread safety: sql.js is synchronous under the hood but we expose an
 * async interface to match the {@link StateStore} contract (which must
 * also work with async backends like Redis).
 *
 * Persistence: by default the database lives in memory. Pass a file path
 * via {@link SqliteStoreOptions.filePath} plus a `saveIntervalMs` to
 * enable periodic WAL-style flushing to disk.
 */
export class SqliteStateStore implements StateStore {
  private db: Database | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(private readonly options: SqliteStoreOptions = {}) {}

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize the SQLite database and create the schema.
   *
   * Must be called before any other method. This is a separate method
   * (rather than constructor logic) because sql.js initialization is async.
   *
   * Performs a stale-DB fail-fast check (see D12 in `implementation_plan.md`):
   * if a `state.db` from the predecessor merchant-mode codebase is loaded,
   * its rows lack the `swapInputs` field that the swap service requires.
   * Boot is refused with a pointer to `OPERATOR_GUIDE.md`'s "First boot"
   * section.
   */
  async init(): Promise<void> {
    const SQL = await initSqlJs();

    if (this.options.filePath) {
      // If a file path is provided, try to load existing data
      try {
        const fs = await import("fs");
        if (fs.existsSync(this.options.filePath)) {
          const fileBuffer = fs.readFileSync(this.options.filePath);
          this.db = new SQL.Database(fileBuffer);
        } else {
          this.db = new SQL.Database();
        }
      } catch {
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    this.createSchema();
    this.assertSchemaCompatibility();

    // Periodic flush to disk if configured
    if (this.options.filePath && this.options.saveIntervalMs) {
      this.saveTimer = setInterval(() => {
        if (this.dirty) {
          this.flushToDisk();
        }
      }, this.options.saveIntervalMs);
    }
  }

  /**
   * Stale-DB fail-fast (D12). Sample one existing row's `state_json`; if
   * the row exists and is parseable but lacks `swapInputs`, the database
   * was written by the predecessor merchant-mode codebase. Refuse to boot
   * and point the operator at the guide.
   *
   * Empty DBs and fresh-write DBs pass through cleanly. Unparseable rows
   * fall through (don't mask other corruption as "stale").
   */
  private assertSchemaCompatibility(): void {
    const db = this.getDb();
    const results = db.exec("SELECT state_json FROM swap_states LIMIT 1");
    const firstResult = results[0];
    if (!firstResult || firstResult.values.length === 0) {
      return; // empty DB — fresh deploy
    }
    const json = firstResult.values[0]?.[0];
    if (typeof json !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return; // corrupt JSON is a different problem — let it surface elsewhere
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("swapInputs" in parsed)
    ) {
      throw new Error(
        "Stale state database: existing rows lack `swapInputs`. " +
          "This file was written by the predecessor merchant-mode codebase. " +
          `Delete ${this.options.filePath ?? "the SQLite file"} before booting the swap service. ` +
          "See docs/OPERATOR_GUIDE.md § 'First boot'.",
      );
    }
  }

  /**
   * Gracefully close the database, flushing any pending writes.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this.options.filePath) {
      this.flushToDisk();
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── StateStore interface ───────────────────────────────────────────

  /**
   * Persist a new swap state. Idempotent — re-quoting the same deposit
   * address overwrites the previous state.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async create(depositAddress: string, state: SwapState): Promise<void> {
    const db = this.getDb();
    const serialized = JSON.stringify(state);

    db.run(
      `INSERT OR REPLACE INTO swap_states
         (deposit_address, phase, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [depositAddress, state.phase, serialized, state.createdAt, state.updatedAt],
    );

    this.dirty = true;
  }

  /**
   * Retrieve a swap state by deposit address, or null if not found.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(depositAddress: string): Promise<SwapState | null> {
    const db = this.getDb();

    const results = db.exec(
      "SELECT state_json FROM swap_states WHERE deposit_address = ?",
      [depositAddress],
    );

    const firstResult = results[0];
    if (!firstResult || firstResult.values.length === 0) {
      return null;
    }

    const json = firstResult.values[0]?.[0];
    if (typeof json !== "string") return null;
    return JSON.parse(json) as SwapState;
  }

  /**
   * Apply a partial update to an existing swap state.
   *
   * If the patch includes a `phase` field, validates that the transition
   * from the current phase is legal (optimistic locking). Throws if:
   * - The deposit address doesn't exist
   * - The phase transition is invalid
   */
  async update(depositAddress: string, patch: Partial<SwapState>): Promise<void> {
    const db = this.getDb();

    // Read the current state
    const current = await this.get(depositAddress);
    if (!current) {
      throw new StateNotFoundError(
        `No swap state found for deposit address: ${depositAddress}`,
      );
    }

    // Validate phase transition if a new phase is specified
    if (patch.phase && patch.phase !== current.phase) {
      validatePhaseTransition(current.phase, patch.phase);
    }

    // Merge patch into current state
    const updated: SwapState = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    const serialized = JSON.stringify(updated);

    db.run(
      `UPDATE swap_states
       SET phase = ?, state_json = ?, updated_at = ?
       WHERE deposit_address = ?`,
      [updated.phase, serialized, updated.updatedAt, depositAddress],
    );

    this.dirty = true;
  }

  /**
   * List deposit addresses whose `createdAt` is older than the given
   * threshold (unix epoch ms). Used for background cleanup of stale states.
   *
   * When `phases` is provided and non-empty, only states currently in one of
   * those phases are returned. The quote garbage collector uses this to avoid
   * deleting in-flight settlements.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listExpired(
    olderThanMs: number,
    phases?: ReadonlySet<SwapPhase>,
  ): Promise<string[]> {
    const db = this.getDb();

    let query = "SELECT deposit_address FROM swap_states WHERE created_at < ?";
    const params: (number | string)[] = [olderThanMs];

    if (phases && phases.size > 0) {
      const placeholders = Array.from(phases, () => "?").join(", ");
      query += ` AND phase IN (${placeholders})`;
      params.push(...phases);
    }

    const results = db.exec(query, params);

    const firstResult = results[0];
    if (!firstResult) {
      return [];
    }

    return firstResult.values.map((row: unknown[]) => row[0] as string);
  }

  /**
   * Delete a swap state by deposit address.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(depositAddress: string): Promise<void> {
    const db = this.getDb();

    db.run(
      "DELETE FROM swap_states WHERE deposit_address = ?",
      [depositAddress],
    );

    this.dirty = true;
  }

  // ── Query helpers (not part of StateStore interface) ────────────────

  /**
   * List all swap states currently in a given phase. Used by the
   * startup recovery path (`recoverInFlightSettlements`) to find swaps
   * stuck in `BROADCASTING` / `BROADCAST` / `POLLING` after a restart.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listByPhase(phase: SwapPhase): Promise<SwapState[]> {
    const db = this.getDb();

    const results = db.exec(
      "SELECT state_json FROM swap_states WHERE phase = ?",
      [phase],
    );

    const firstResult = results[0];
    if (!firstResult) {
      return [];
    }

    return firstResult.values.map(
      (row: unknown[]) => JSON.parse(row[0] as string) as SwapState,
    );
  }

  /**
   * Count of swap states grouped by phase.
   * Useful for health / metrics endpoints.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async countByPhase(): Promise<Record<string, number>> {
    const db = this.getDb();

    const results = db.exec(
      "SELECT phase, COUNT(*) as cnt FROM swap_states GROUP BY phase",
    );

    const firstResult = results[0];
    if (!firstResult) {
      return {};
    }

    const counts: Record<string, number> = {};
    for (const row of firstResult.values) {
      counts[row[0] as string] = row[1] as number;
    }
    return counts;
  }

  /**
   * Total number of swap states in the store.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async count(): Promise<number> {
    const db = this.getDb();
    const results = db.exec("SELECT COUNT(*) FROM swap_states");
    return (results[0]?.values[0]?.[0] as number) ?? 0;
  }

  // ── Internal ───────────────────────────────────────────────────────

  private createSchema(): void {
    const db = this.getDb();

    db.run(`
      CREATE TABLE IF NOT EXISTS swap_states (
        deposit_address TEXT PRIMARY KEY,
        phase           TEXT NOT NULL,
        state_json      TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_swap_states_created_at
      ON swap_states (created_at)
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_swap_states_phase
      ON swap_states (phase)
    `);
  }

  /**
   * Get the database instance, throwing if not initialized.
   * Using a return-value pattern instead of `asserts this` to avoid
   * TypeScript issues with private field narrowing.
   */
  private getDb(): Database {
    if (!this.db) {
      throw new Error(
        "SqliteStateStore is not initialized. Call init() before use.",
      );
    }
    return this.db;
  }

  private flushToDisk(): void {
    if (!this.db || !this.options.filePath) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs") as typeof import("fs");
      const data = this.db.export();
      fs.writeFileSync(this.options.filePath, Buffer.from(data));
      this.dirty = false;
    } catch {
      // Log error in production; for now silently continue
    }
  }
}

/**
 * Configuration for the SQLite state store.
 */
export interface SqliteStoreOptions {
  /**
   * Path to the SQLite database file. If omitted, the database is
   * in-memory only (suitable for development/testing).
   */
  filePath?: string;

  /**
   * How often (ms) to flush the in-memory database to disk.
   * Only used when `filePath` is set. Defaults to no periodic flush
   * (data is flushed on close).
   */
  saveIntervalMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// In-memory implementation (for testing / lightweight use)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simple in-memory implementation of {@link StateStore}.
 *
 * No persistence — data is lost when the process exits. Useful for:
 * - Unit tests that need a real StateStore without SQLite overhead
 * - Development environments
 * - As a reference implementation for the interface contract
 */
export class InMemoryStateStore implements StateStore {
  private readonly states = new Map<string, SwapState>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(depositAddress: string, state: SwapState): Promise<void> {
    // Idempotent: overwrite if exists (same as SQLite INSERT OR REPLACE)
    this.states.set(depositAddress, structuredClone(state));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(depositAddress: string): Promise<SwapState | null> {
    const state = this.states.get(depositAddress);
    return state ? structuredClone(state) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(depositAddress: string, patch: Partial<SwapState>): Promise<void> {
    const current = this.states.get(depositAddress);
    if (!current) {
      throw new StateNotFoundError(
        `No swap state found for deposit address: ${depositAddress}`,
      );
    }

    if (patch.phase && patch.phase !== current.phase) {
      validatePhaseTransition(current.phase, patch.phase);
    }

    const updated: SwapState = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    this.states.set(depositAddress, updated);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listExpired(
    olderThanMs: number,
    phases?: ReadonlySet<SwapPhase>,
  ): Promise<string[]> {
    const expired: string[] = [];
    for (const [addr, state] of this.states) {
      if (state.createdAt < olderThanMs) {
        if (!phases || phases.size === 0 || phases.has(state.phase)) {
          expired.push(addr);
        }
      }
    }
    return expired;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listByPhase(phase: SwapPhase): Promise<SwapState[]> {
    const result: SwapState[] = [];
    for (const state of this.states.values()) {
      if (state.phase === phase) {
        result.push(structuredClone(state));
      }
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(depositAddress: string): Promise<void> {
    this.states.delete(depositAddress);
  }

  /** Number of states currently held. */
  get size(): number {
    return this.states.size;
  }

  /** Clear all states. Useful in test teardown. */
  clear(): void {
    this.states.clear();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    this.states.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Factory function
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create and initialize a state store.
 *
 * This is the primary entry point. The `backend` parameter controls which
 * implementation is used, making it easy to swap backends via config:
 *
 * ```ts
 * const store = await createStateStore({ backend: "sqlite" });
 * // ... later, for production:
 * const store = await createStateStore({ backend: "redis", redisUrl: "..." });
 * ```
 *
 * Currently supported backends: `"sqlite"`, `"memory"`.
 * Redis support is tracked as a production-hardening item in `docs/TODO.md`.
 */
export async function createStateStore(
  options: CreateStoreOptions = {},
): Promise<StateStore> {
  const backend = options.backend ?? "sqlite";

  switch (backend) {
    case "sqlite": {
      const store = new SqliteStateStore({
        filePath: options.filePath,
        saveIntervalMs: options.saveIntervalMs,
      });
      await store.init();
      return store;
    }
    case "memory": {
      return new InMemoryStateStore();
    }
    // Future: case "redis": { ... }
    default:
      throw new Error(`Unknown state store backend: ${String(backend)}`);
  }
}

/**
 * Options for {@link createStateStore}.
 */
export interface CreateStoreOptions {
  /** Which backend to use. Defaults to `"sqlite"`. */
  backend?: "sqlite" | "memory"; // Redis backend tracked in docs/TODO.md
  /** SQLite file path (sqlite backend only). */
  filePath?: string;
  /** SQLite flush interval in ms (sqlite backend only). */
  saveIntervalMs?: number;
  // Future Redis options:
  // redisUrl?: string;
  // redisTtlMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase transition validation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate that a phase transition is legal per the swap lifecycle.
 *
 * @throws {InvalidPhaseTransitionError} if the transition is not allowed.
 */
export function validatePhaseTransition(
  currentPhase: SwapPhase,
  newPhase: SwapPhase,
): void {
  const allowed = VALID_PHASE_TRANSITIONS.get(currentPhase);
  if (!allowed?.has(newPhase)) {
    throw new InvalidPhaseTransitionError(
      `Invalid phase transition: ${currentPhase} → ${newPhase}`,
      currentPhase,
      newPhase,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Error classes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Thrown when attempting to update a swap state that doesn't exist.
 */
export class StateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateNotFoundError";
  }
}

/**
 * Thrown when a phase transition violates the swap lifecycle rules.
 */
export class InvalidPhaseTransitionError extends Error {
  constructor(
    message: string,
    public readonly fromPhase: SwapPhase,
    public readonly toPhase: SwapPhase,
  ) {
    super(message);
    this.name = "InvalidPhaseTransitionError";
  }
}
