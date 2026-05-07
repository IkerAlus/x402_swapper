/**
 * `/.well-known/x402` fan-out document builder.
 *
 * x402scan (and the IETF `_x402` TXT-record draft) uses this document as
 * a fallback discovery surface when `/openapi.json` is missing or
 * unparseable. Third-party discovery tools and `discoverx402` nodes also
 * consume it, so we keep it in sync with the OpenAPI doc even when the
 * latter is the primary surface.
 *
 * Shape (per x402scan DISCOVERY.md § B — "Fan-Out (Compatibility)"):
 *
 * ```json
 * {
 *   "version": 1,
 *   "resources": ["https://gateway.example.com/api/swap"],
 *   "ownershipProofs": ["0x..."],
 *   "instructions": "Prefer /openapi.json for per-route schemas; probe each URL in `resources` for its runtime 402 PAYMENT-REQUIRED envelope."
 * }
 * ```
 *
 * This module is a **pure builder** — no Express handler, no request
 * context, no I/O. `server.ts` calls `buildWellKnownDocument` once at
 * startup (or per request, cost is negligible) and serves the result as
 * JSON from `GET /.well-known/x402`.
 *
 * @module discovery
 */

import type { GatewayConfig } from "../infra/config.js";
import type { ProtectedRoute } from "./protected-routes.js";
import { validateOwnershipProofs } from "./ownership-proof.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * The JSON envelope served at `GET /.well-known/x402`.
 *
 * `version: 1` is the only value defined by the current x402scan spec;
 * any future bump will require a coordinated change here and in the
 * consumer ecosystem.
 */
export interface WellKnownDocument {
  version: 1;
  /**
   * Absolute URLs (including scheme + host) for every paid resource the
   * gateway serves. Empty when `publicBaseUrl` is unset — the endpoint
   * still responds 200 so external probes see the gateway speaks x402
   * even during local development.
   */
  resources: string[];
  /**
   * EIP-191 signatures over `x402 ownership of <publicBaseUrl>`. Only
   * signatures that pass {@link validateOwnershipProofs} are emitted —
   * malformed entries are logged as warnings at startup and dropped here.
   */
  ownershipProofs: string[];
  /**
   * Free-form "legacy guidance" field (per the spec). We always emit it
   * to point crawlers that land on `/.well-known/x402` alone — without
   * also fetching `/openapi.json` — at the richer surface, and to
   * remind them that authoritative signing details live on each listed
   * resource's runtime 402 response rather than in this document.
   */
  instructions: string;
}

/**
 * Static "legacy guidance" string emitted on every well-known response.
 * Kept as a module-level constant so tests can pin behaviour and future
 * edits happen in one place.
 *
 * Deliberately short — the spec describes the field as optional legacy
 * guidance, not a free-form description surface.
 */
export const WELL_KNOWN_INSTRUCTIONS =
  "Prefer /openapi.json for per-route schemas (x-payment-info, " +
  "x-crosschain, response shapes). Each URL in `resources` returns a " +
  "runtime 402 PAYMENT-REQUIRED envelope — probe those for the live " +
  "payment options and signing details.";

// ═══════════════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the `/.well-known/x402` document from the runtime config and the
 * list of protected routes.
 *
 * The function is pure: given identical inputs it returns a value-equal
 * document, so it can be cached at startup (or generated per request
 * without performance concern — the payload is tiny).
 *
 * `resources[]` contains one entry per `ProtectedRoute`, joined with
 * `publicBaseUrl`. Duplicates are impossible because the routes registry
 * enforces `(method, path)` uniqueness; if a future change removes that
 * guarantee, the array will still be valid JSON, so we don't deduplicate.
 *
 * `ownershipProofs[]` is filtered through `validateOwnershipProofs`.
 * Malformed entries in `cfg.ownershipProofs` are silently dropped here —
 * they were already surfaced as warnings at startup.
 */
export function buildWellKnownDocument(
  cfg: GatewayConfig,
  routes: readonly ProtectedRoute[],
): WellKnownDocument {
  const baseUrl = cfg.publicBaseUrl;

  const resources = baseUrl
    ? routes.map((route) => joinUrl(baseUrl, route.path))
    : [];

  const { valid: validProofs } = validateOwnershipProofs(
    cfg.ownershipProofs,
    baseUrl,
  );

  return {
    version: 1,
    resources,
    ownershipProofs: validProofs,
    instructions: WELL_KNOWN_INSTRUCTIONS,
  };
}

/**
 * Join a base URL and a path into a single absolute URL, avoiding the
 * two common ways concatenation goes wrong: missing slash and double
 * slash. The base URL comes from Zod's `.url()` validator so we know
 * it's a parseable absolute URL.
 *
 * We deliberately avoid `new URL(path, base).toString()` because a
 * `path` starting with `/` would drop any path component already on the
 * base URL (operators sometimes deploy the gateway under a subpath).
 * Simple string surgery preserves both parts predictably.
 */
function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const prefixedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${prefixedPath}`;
}
