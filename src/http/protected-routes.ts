/**
 * Protected Routes Registry — the single source of truth for every paid
 * endpoint served by the gateway.
 *
 * This service is a swap-as-resource gateway with one paid route:
 * `GET /api/swap`. The buyer supplies the destination via query
 * parameters; the route returns a 402 with a 1CS deposit address; after
 * the buyer signs and the swap settles, the route returns a swap
 * receipt as the 200 response body.
 *
 * Every protected HTTP route lives here as a {@link ProtectedRoute} entry
 * with:
 *  - HTTP method + path
 *  - Human-readable summary + description (OpenAPI operation fields)
 *  - Pricing metadata (operator margin band, currency)
 *  - JSON Schema for request input (used by OpenAPI + x402scan; required
 *    for invocability classification)
 *  - JSON Schema for the success response body
 *  - Zod validator for runtime input parsing (used by middleware)
 *  - The Express handler invoked **after** a successful x402 settlement
 *
 * Three call-sites consume this registry:
 *
 *  1. `src/server.ts` — mounts each route through `createX402Middleware`
 *     and the entry's handler.
 *  2. `src/http/openapi.ts` — renders each entry as a path item in the
 *     OpenAPI 3.x document served at `/openapi.json`.
 *  3. `src/http/discovery.ts` — emits each `path` as an absolute URL in
 *     the `/.well-known/x402` fan-out document.
 *
 * @module protected-routes
 */

import type { Request, RequestHandler } from "express";
import type { z } from "zod";
import type { GatewayConfig } from "../infra/config.js";
import type { SwapState } from "../types.js";
import {
  SwapRequestInputSchema,
  SwapRequestInputJsonSchema,
} from "./swap-input.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** HTTP verbs the gateway supports for paid routes (expand as needed). */
export type ProtectedMethod = "GET" | "POST";

/**
 * Pricing metadata for a swap-as-resource route.
 *
 * Actual price is computed per-request from the buyer's `amountIn` plus
 * `cfg.operatorMarginBps`. The `min`/`max` band is informational —
 * surfaces in `/openapi.json` (`x-payment-info`) and on x402scan so
 * indexers can categorise the route's price range.
 */
export interface SwapPricing {
  currency: "USD";
  /** Inclusive lower bound, e.g. `"0.01"`. */
  min: string;
  /** Inclusive upper bound, e.g. `"100000"`. */
  max: string;
}

/** Pricing metadata surfaced in `x-payment-info` and `extensions.bazaar`. */
export type RoutePricing = SwapPricing;

/**
 * A paid HTTP route the gateway serves.
 *
 * All fields are required. `inputValidator`, `inputSchema`, and
 * `outputSchema` are load-bearing for swap routes: the validator gates
 * the buyer's request before quoting, the input schema advertises the
 * route's contract to OpenAPI / x402scan, and the output schema describes
 * the receipt body.
 */
export interface ProtectedRoute {
  /** URL path, must start with `/`. Used as Express route + OpenAPI key. */
  path: string;
  method: ProtectedMethod;
  /** Short operation title, surfaces in OpenAPI + Bazaar `info.name`. */
  summary: string;
  /** Longer human-readable description; used by OpenAPI + Bazaar. */
  description: string;
  /** Pricing metadata — currency + min/max band. */
  pricing: RoutePricing;
  /**
   * Zod validator applied to the buyer's `req.query` before quoting.
   * Failures return 400 `INVALID_INPUT` with field-level details.
   */
  inputValidator: z.ZodType<unknown>;
  /**
   * JSON Schema mirror of `inputValidator`. Copied into
   * `extensions.bazaar.info.inputSchema` on the 402 challenge and
   * rendered as `parameters: [{in: "query", ...}]` in the OpenAPI doc.
   * Required for x402scan to classify the route as machine-invocable.
   */
  inputSchema: Record<string, unknown>;
  /**
   * JSON Schema for the success (200) response body. Copied into
   * `extensions.bazaar.info.outputSchema` and the OpenAPI `responses.200`.
   */
  outputSchema: Record<string, unknown>;
  /**
   * Express handler invoked **after** a successful x402 settlement. The
   * middleware has already validated the payment, broadcast the tx,
   * confirmed 1CS settlement, and attached the `PAYMENT-RESPONSE` header
   * by the time this handler runs.
   */
  handler: RequestHandler;
}

// ═══════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate a {@link ProtectedRoute} entry. Throws a descriptive error if
 * any required field is malformed. Called once at startup, before any
 * route is mounted, so misconfiguration fails fast with a clear message.
 */
export function validateProtectedRoute(route: ProtectedRoute): void {
  if (typeof route.path !== "string" || !route.path.startsWith("/")) {
    throw new Error(
      `ProtectedRoute.path must be a string starting with "/", got ${JSON.stringify(route.path)}`,
    );
  }
  if (route.method !== "GET" && route.method !== "POST") {
    throw new Error(
      `ProtectedRoute(${route.path}).method must be "GET" or "POST", got ${JSON.stringify(route.method)}`,
    );
  }
  if (typeof route.summary !== "string" || route.summary.length === 0) {
    throw new Error(
      `ProtectedRoute(${route.path}).summary must be a non-empty string`,
    );
  }
  if (typeof route.description !== "string" || route.description.length === 0) {
    throw new Error(
      `ProtectedRoute(${route.path}).description must be a non-empty string`,
    );
  }
  if (typeof route.handler !== "function") {
    throw new Error(
      `ProtectedRoute(${route.path}).handler must be a function`,
    );
  }
  if (typeof route.pricing.min !== "string" || route.pricing.min.length === 0) {
    throw new Error(
      `ProtectedRoute(${route.path}).pricing.min must be a non-empty string`,
    );
  }
  if (typeof route.pricing.max !== "string" || route.pricing.max.length === 0) {
    throw new Error(
      `ProtectedRoute(${route.path}).pricing.max must be a non-empty string`,
    );
  }
  if (route.pricing.currency !== "USD") {
    throw new Error(
      `ProtectedRoute(${route.path}).pricing.currency must be "USD"`,
    );
  }
  if (route.inputValidator == null || typeof route.inputValidator.safeParse !== "function") {
    throw new Error(
      `ProtectedRoute(${route.path}).inputValidator must be a Zod schema`,
    );
  }
  if (route.inputSchema == null || typeof route.inputSchema !== "object") {
    throw new Error(
      `ProtectedRoute(${route.path}).inputSchema must be a JSON Schema object`,
    );
  }
  if (route.outputSchema == null || typeof route.outputSchema !== "object") {
    throw new Error(
      `ProtectedRoute(${route.path}).outputSchema must be a JSON Schema object`,
    );
  }
}

/**
 * Validate an entire registry. Enforces per-entry shape plus global
 * constraints: path uniqueness (path+method tuple), at least one route.
 */
export function validateProtectedRoutes(routes: readonly ProtectedRoute[]): void {
  if (routes.length === 0) {
    throw new Error("PROTECTED_ROUTES registry is empty — at least one route is required");
  }
  const seen = new Set<string>();
  for (const route of routes) {
    validateProtectedRoute(route);
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate route in registry: ${key}`);
    }
    seen.add(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Output schema for the swap route's 200 body
// ═══════════════════════════════════════════════════════════════════════

/**
 * JSON Schema for the 200 response body of `/api/swap`.
 *
 * The body is `{}` — empty, by design (D14 in implementation_plan.md). The
 * settlement receipt is carried in the `PAYMENT-RESPONSE` header's
 * `extensions.crossChain` field as a {@link CrossChainSettlementExtra},
 * which is the standardized x402 extensibility hook. Single source of
 * truth, consumable by any conforming x402 client without route-specific
 * knowledge.
 *
 * Phase 9 (`src/http/openapi.ts`) describes the `PAYMENT-RESPONSE` header
 * shape under the response's `headers` block.
 */
const SWAP_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Empty body. The settlement receipt is carried in the PAYMENT-RESPONSE " +
    "header's extensions.crossChain field (CrossChainSettlementExtra).",
};

// ═══════════════════════════════════════════════════════════════════════
// The registry
//
// Add a new paid endpoint by appending a {@link ProtectedRoute} entry
// here. The three discovery surfaces (server mount, OpenAPI document,
// well-known fan-out) pick it up automatically.
// ═══════════════════════════════════════════════════════════════════════

/**
 * The live registry. A single swap route is the entire product surface
 * for this service.
 */
export const PROTECTED_ROUTES: readonly ProtectedRoute[] = [
  {
    path: "/api/swap",
    method: "GET",
    summary: "Cross-chain swap",
    description:
      "Pay USDC on Base; receive any 1CS-supported asset on any 1CS-supported chain " +
      "at a buyer-supplied address. Single signed authorisation, no wallet-connect dance. " +
      "Buyer supplies destination params via query string (see inputSchema).",
    pricing: { currency: "USD", min: "0.01", max: "100000" },
    inputValidator: SwapRequestInputSchema,
    inputSchema: SwapRequestInputJsonSchema,
    outputSchema: SWAP_BODY_SCHEMA,
    // Handler is attached at startup (see `buildSwapHandler` below) where
    // it has access to `cfg`. The placeholder here throws loudly if anyone
    // mounts the raw registry entry by mistake.
    handler: (_req, _res, next) => next(new Error(
      "handler not bound — the registry entry must be cloned with a real handler at startup; " +
      "see `buildSwapHandler` in src/http/protected-routes.ts",
    )),
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Handler factories
//
// Some handlers need access to config values at request time. Factories
// expose the binding hook so `buildProtectedRoutes` can clone the
// registry with concrete handlers.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Express request augmented by the x402 middleware with the SETTLED
 * `SwapState` (after the buyer's payment has been verified, broadcast,
 * and 1CS reports SUCCESS). The swap handler reads this to build the
 * receipt body.
 */
export type RequestWithSwapState = Request & { swapState?: SwapState };

/**
 * Build the handler for `GET /api/swap`.
 *
 * The middleware has driven settlement to completion and attached the
 * SETTLED `SwapState` to `req.swapState` and the receipt-bearing
 * `PAYMENT-RESPONSE` header to the response by the time this runs. The
 * body is `{}` — the receipt lives in the header, not here.
 *
 * The `state` lookup is purely a sanity guard against middleware-routing
 * bugs; the handler does not consume it (the body is constant `{}`).
 */
export function buildSwapHandler(_cfg: GatewayConfig): RequestHandler {
  return (req, res) => {
    const state = (req as RequestWithSwapState).swapState;
    if (!state) {
      throw new Error("Swap state not attached to request — middleware bug");
    }
    res.json({});
  };
}

/**
 * Produce a ready-to-mount copy of the registry with per-request
 * handlers bound to the runtime config. Validates the final list before
 * returning; throws if anything is malformed.
 *
 * Keep this the **only** way server.ts obtains its list of routes, so
 * adding a new entry never requires touching server.ts.
 */
export function buildProtectedRoutes(cfg: GatewayConfig): ProtectedRoute[] {
  const bound: ProtectedRoute[] = PROTECTED_ROUTES.map((route) => {
    switch (route.path) {
      case "/api/swap":
        return { ...route, handler: buildSwapHandler(cfg) };
      default:
        return { ...route };
    }
  });
  validateProtectedRoutes(bound);
  return bound;
}
