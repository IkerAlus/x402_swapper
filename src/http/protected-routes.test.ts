/**
 * Tests for the protected-routes registry.
 *
 * Covers what the validator must enforce (per-route shape, list-level
 * uniqueness, currency=USD, required swap-mode fields), plus the
 * `buildSwapHandler`'s body-is-`{}` D14 contract.
 *
 * The "registry contains a swap route" + "validation passes" assertions
 * implicitly cover the per-route field-presence checks, so we don't
 * re-test each field individually at the registry level.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  PROTECTED_ROUTES,
  buildProtectedRoutes,
  validateProtectedRoute,
  validateProtectedRoutes,
  buildSwapHandler,
  type ProtectedRoute,
  type RequestWithSwapState,
} from "./protected-routes.js";
import { SwapRequestInputSchema, SwapRequestInputJsonSchema } from "./swap-input.js";
import { mockGatewayConfig, mockSwapState } from "../mocks/index.js";

// ═══════════════════════════════════════════════════════════════════════
// Static registry — the live registry must contain a swap route and pass
// list-level validation. Per-field checks live in `validateProtectedRoute`.
// ═══════════════════════════════════════════════════════════════════════

describe("PROTECTED_ROUTES registry", () => {
  it("contains a GET /api/swap and passes list-level validation", () => {
    const swap = PROTECTED_ROUTES.find((r) => r.path === "/api/swap");
    expect(swap?.method).toBe("GET");
    expect(() => validateProtectedRoutes(PROTECTED_ROUTES)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateProtectedRoute — error paths
// ═══════════════════════════════════════════════════════════════════════

describe("validateProtectedRoute", () => {
  function sampleRoute(overrides: Partial<ProtectedRoute> = {}): ProtectedRoute {
    return {
      path: "/api/ok",
      method: "GET",
      summary: "OK",
      description: "A test route.",
      pricing: { currency: "USD", min: "0.01", max: "100" },
      inputValidator: SwapRequestInputSchema,
      inputSchema: SwapRequestInputJsonSchema,
      outputSchema: { type: "object", additionalProperties: false },
      handler: (_req, _res, next) => next(),
      ...overrides,
    };
  }

  it("accepts a minimally valid swap-mode route", () => {
    expect(() => validateProtectedRoute(sampleRoute())).not.toThrow();
  });

  it.each<[string, Partial<ProtectedRoute>, RegExp]>([
    ["path missing leading slash", { path: "api/no-slash" }, /must be a string starting with "\/"/],
    ["unsupported HTTP method", { method: "DELETE" as "GET" }, /"GET" or "POST"/],
    ["empty summary", { summary: "" }, /summary must be a non-empty string/],
    ["empty description", { description: "" }, /description must be a non-empty string/],
    ["non-function handler", { handler: "x" as unknown as ProtectedRoute["handler"] }, /handler must be a function/],
    ["empty pricing.min", { pricing: { currency: "USD", min: "", max: "100" } }, /pricing\.min/],
    ["empty pricing.max", { pricing: { currency: "USD", min: "0.01", max: "" } }, /pricing\.max/],
    [
      "non-USD currency",
      {
        pricing: {
          currency: "EUR",
          min: "0.01",
          max: "100",
        } as unknown as ProtectedRoute["pricing"],
      },
      /pricing\.currency must be "USD"/,
    ],
  ])("rejects %s", (_label, override, errPattern) => {
    expect(() => validateProtectedRoute(sampleRoute(override))).toThrow(errPattern);
  });

  it.each<["inputValidator" | "inputSchema" | "outputSchema", RegExp]>([
    ["inputValidator", /inputValidator must be a Zod schema/],
    ["inputSchema", /inputSchema must be a JSON Schema object/],
    ["outputSchema", /outputSchema must be a JSON Schema object/],
  ])("rejects routes missing %s", (field, errPattern) => {
    const bad = { ...sampleRoute() } as Partial<ProtectedRoute>;
    delete bad[field];
    expect(() => validateProtectedRoute(bad as ProtectedRoute)).toThrow(errPattern);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateProtectedRoutes — list-level invariants
// ═══════════════════════════════════════════════════════════════════════

describe("validateProtectedRoutes", () => {
  const ok = (): ProtectedRoute => ({
    path: "/api/ok",
    method: "GET",
    summary: "OK",
    description: "ok",
    pricing: { currency: "USD", min: "0.01", max: "100" },
    inputValidator: SwapRequestInputSchema,
    inputSchema: SwapRequestInputJsonSchema,
    outputSchema: { type: "object", additionalProperties: false },
    handler: (_req, _res, next) => next(),
  });

  it("rejects an empty registry", () => {
    expect(() => validateProtectedRoutes([])).toThrow(/empty/);
  });

  it("rejects duplicate (method, path) tuples but allows same path with different methods", () => {
    expect(() => validateProtectedRoutes([ok(), { ...ok(), summary: "OK2" }])).toThrow(/Duplicate route/);
    expect(() =>
      validateProtectedRoutes([
        { ...ok(), method: "GET" },
        { ...ok(), method: "POST" },
      ]),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildProtectedRoutes — factory binds real handlers
// ═══════════════════════════════════════════════════════════════════════

describe("buildProtectedRoutes", () => {
  it("returns the same number of routes as the registry, with bound handlers", () => {
    const routes = buildProtectedRoutes(mockGatewayConfig());
    expect(routes.length).toBe(PROTECTED_ROUTES.length);
    const swap = routes.find((r) => r.path === "/api/swap")!;
    expect(typeof swap.handler).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildSwapHandler — body is `{}` (D14); throws on missing swapState (bug guard)
// ═══════════════════════════════════════════════════════════════════════

describe("buildSwapHandler", () => {
  it("returns `{}` as the 200 response body when middleware attaches swapState", async () => {
    const handler = buildSwapHandler(mockGatewayConfig());
    const app = express();
    app.get(
      "/api/swap",
      (req, _res, next) => {
        (req as RequestWithSwapState).swapState = mockSwapState({ phase: "SETTLED", settledAt: Date.now() });
        next();
      },
      handler,
    );

    const res = await request(app).get("/api/swap");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("throws when middleware fails to attach swapState (bug guard)", async () => {
    const handler = buildSwapHandler(mockGatewayConfig());
    const app = express();
    app.get("/api/swap", handler);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app).get("/api/swap");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Swap state not attached");
  });
});
