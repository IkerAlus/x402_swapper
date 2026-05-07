import { describe, it, expect } from "vitest";
import {
  TERMINAL_STATUSES,
  VALID_PHASE_TRANSITIONS,
  GatewayError,
  QuoteUnavailableError,
  AuthenticationError,
  ServiceUnavailableError,
  DeadlineTooShortError,
  InsufficientGasError,
  InvalidInputError,
  SwapFailedError,
  SwapTimeoutError,
} from "./types.js";
import type { SwapPhase, OneClickStatus } from "./types.js";

// ─── Terminal statuses ───────────────────────────────────────────────

describe("TERMINAL_STATUSES", () => {
  it("contains exactly SUCCESS, FAILED, REFUNDED — and excludes the in-flight statuses", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["FAILED", "REFUNDED", "SUCCESS"]);
    const nonTerminal: OneClickStatus[] = [
      "KNOWN_DEPOSIT_TX",
      "PENDING_DEPOSIT",
      "INCOMPLETE_DEPOSIT",
      "PROCESSING",
    ];
    for (const s of nonTerminal) expect(TERMINAL_STATUSES.has(s)).toBe(false);
  });
});

// ─── Phase transitions ──────────────────────────────────────────────

describe("VALID_PHASE_TRANSITIONS", () => {
  it("defines transitions for every SwapPhase", () => {
    const allPhases: SwapPhase[] = [
      "QUOTED",
      "VERIFIED",
      "BROADCASTING",
      "BROADCAST",
      "POLLING",
      "SETTLED",
      "FAILED",
      "EXPIRED",
    ];
    for (const phase of allPhases) {
      expect(VALID_PHASE_TRANSITIONS.has(phase)).toBe(true);
    }
  });

  it("allows QUOTED → VERIFIED/EXPIRED/FAILED but not skip-ahead to SETTLED; terminal phases have no exits", () => {
    const fromQuoted = VALID_PHASE_TRANSITIONS.get("QUOTED")!;
    expect(fromQuoted.has("VERIFIED")).toBe(true);
    expect(fromQuoted.has("EXPIRED")).toBe(true);
    expect(fromQuoted.has("FAILED")).toBe(true);
    expect(fromQuoted.has("SETTLED")).toBe(false);

    for (const terminal of ["SETTLED", "FAILED", "EXPIRED"] as const) {
      expect(VALID_PHASE_TRANSITIONS.get(terminal)!.size).toBe(0);
    }
  });
});

// ─── Error classes ──────────────────────────────────────────────────

describe("Error classes", () => {
  it("GatewayError carries message/code/httpStatus (default 500); subclass is an Error", () => {
    const explicit = new GatewayError("broke", "TEST_CODE", 418);
    expect(explicit).toMatchObject({ message: "broke", code: "TEST_CODE", httpStatus: 418, name: "GatewayError" });
    expect(explicit instanceof Error).toBe(true);

    expect(new GatewayError("default", "X").httpStatus).toBe(500);
  });

  it.each([
    { Cls: InvalidInputError, code: "INVALID_INPUT", name: "InvalidInputError", http: 400 },
    { Cls: QuoteUnavailableError, code: "QUOTE_UNAVAILABLE", name: "QuoteUnavailableError", http: 503 },
    { Cls: AuthenticationError, code: "AUTHENTICATION_ERROR", name: "AuthenticationError", http: 503 },
    { Cls: ServiceUnavailableError, code: "SERVICE_UNAVAILABLE", name: "ServiceUnavailableError", http: 503 },
    { Cls: DeadlineTooShortError, code: "DEADLINE_TOO_SHORT", name: "DeadlineTooShortError", http: 503 },
    { Cls: InsufficientGasError, code: "INSUFFICIENT_GAS", name: "InsufficientGasError", http: 503 },
    { Cls: SwapTimeoutError, code: "SWAP_TIMEOUT", name: "SwapTimeoutError", http: 504 },
  ])("$name → code=$code, httpStatus=$http, extends GatewayError", ({ Cls, code, name, http }) => {
    const err = new Cls("test");
    expect(err).toMatchObject({ code, name, httpStatus: http });
    expect(err instanceof GatewayError).toBe(true);
  });

  it("SwapFailedError carries swapStatus + optional refundInfo (502)", () => {
    const err = new SwapFailedError("swap failed", "REFUNDED", {
      buyerAddress: "0xbuyer",
      amount: "1000000",
      reason: "slippage exceeded",
    });
    expect(err).toMatchObject({ httpStatus: 502, code: "SWAP_FAILED", swapStatus: "REFUNDED" });
    expect(err.refundInfo?.buyerAddress).toBe("0xbuyer");
  });
});
