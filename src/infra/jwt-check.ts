/**
 * 1Click Swap JWT expiry inspection — pure, dependency-free.
 *
 * The gateway uses `ONE_CLICK_JWT` as a bearer token for the 1CS API. If
 * the token has expired, every quote request returns 401 (surfaced to
 * the buyer as a 503 `AUTHENTICATION_ERROR`). Before this check, the
 * problem only surfaced at first traffic — operators had no warning.
 *
 * This module decodes the JWT payload at startup and:
 *  - refuses boot if already expired (caller calls `process.exit(1)`)
 *  - warns if expiry is closer than `WARN_THRESHOLD_DAYS`
 *  - silent on a healthy token with comfortable runway
 *
 * Implementation notes:
 *  - No external JWT library: we only inspect the `exp` claim, never the
 *    signature. Base64url-decode the middle segment, JSON.parse it.
 *  - `exp` is a unix timestamp in **seconds** per RFC 7519 § 4.1.4.
 *  - Tokens without `exp` are treated as non-expiring (real 1CS JWTs do
 *    carry it; we don't fail boot just because a future format change
 *    omits it).
 *  - Malformed tokens (not 3 segments, payload not valid JSON, etc.)
 *    return a `parseFailed` outcome — caller decides whether that's
 *    fatal. We don't fail boot on parse failure because the live request
 *    path would surface a real 401 instantly anyway and that's the
 *    authoritative answer.
 *
 * @module jwt-check
 */

/** Default threshold (in days) below which we warn at startup. */
export const WARN_THRESHOLD_DAYS = 7;

/** Outcome of inspecting a JWT's `exp` claim. */
export type JwtExpiryInspection =
  /** Token has a valid `exp` claim. May be expired, expiring soon, or healthy. */
  | {
      kind: "checked";
      expiresAt: Date;
      /** Seconds until expiry. Negative when already expired. */
      secondsUntilExpiry: number;
      /** True iff `secondsUntilExpiry <= 0`. */
      expired: boolean;
      /** True iff `0 < secondsUntilExpiry < threshold`. */
      expiringSoon: boolean;
    }
  /** JWT parses but has no `exp` claim — treat as non-expiring. */
  | { kind: "no-exp" }
  /** JWT could not be parsed — header / payload / signature segments
   *  not in the expected shape. Caller may choose to ignore. */
  | { kind: "parseFailed"; reason: string };

/**
 * Inspect the `exp` claim on a JWT without verifying its signature.
 *
 * @param jwt          The full JWT string (`header.payload.signature`).
 * @param now          Override the current time for tests. Defaults to `Date.now()`.
 * @param warnThresholdDays  How many days of runway counts as "expiring soon".
 *                           Defaults to `WARN_THRESHOLD_DAYS` (7 days).
 */
export function inspectJwtExpiry(
  jwt: string,
  now: number = Date.now(),
  warnThresholdDays: number = WARN_THRESHOLD_DAYS,
): JwtExpiryInspection {
  if (typeof jwt !== "string" || jwt.length === 0) {
    return { kind: "parseFailed", reason: "JWT is empty" };
  }
  const segments = jwt.split(".");
  if (segments.length !== 3) {
    return {
      kind: "parseFailed",
      reason: `expected 3 dot-separated segments, got ${segments.length}`,
    };
  }
  const payloadSegment = segments[1]!;
  let payload: unknown;
  try {
    // JWTs use base64url (RFC 4648 § 5): `+` → `-`, `/` → `_`, padding stripped.
    // Node's Buffer doesn't natively understand base64url; map back to plain base64.
    const padded = payloadSegment
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(payloadSegment.length + ((4 - (payloadSegment.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    payload = JSON.parse(json);
  } catch (err) {
    return {
      kind: "parseFailed",
      reason: `payload not base64url JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof payload !== "object" || payload === null) {
    return { kind: "parseFailed", reason: "payload is not a JSON object" };
  }
  const exp = (payload as { exp?: unknown }).exp;
  if (exp === undefined) {
    return { kind: "no-exp" };
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return {
      kind: "parseFailed",
      reason: `payload.exp is not a number (got ${typeof exp})`,
    };
  }

  const expiresAtMs = exp * 1000;
  const expiresAt = new Date(expiresAtMs);
  const secondsUntilExpiry = Math.floor((expiresAtMs - now) / 1000);
  const expired = secondsUntilExpiry <= 0;
  const expiringSoon =
    !expired && secondsUntilExpiry < warnThresholdDays * 24 * 60 * 60;

  return {
    kind: "checked",
    expiresAt,
    secondsUntilExpiry,
    expired,
    expiringSoon,
  };
}

/**
 * Format a `JwtExpiryInspection` as a human-readable line for the boot log.
 * Returns an empty string for the silent-healthy case so callers can
 * unconditionally `console.log` the result without producing noise on the
 * happy path.
 */
export function formatJwtInspection(
  result: JwtExpiryInspection,
  prefix = "[x402-1CS]",
): string {
  switch (result.kind) {
    case "checked": {
      if (result.expired) {
        const ago = -result.secondsUntilExpiry;
        return `${prefix} ❌ ONE_CLICK_JWT has expired (exp=${result.expiresAt.toISOString()}, ${formatDuration(ago)} ago). Renew before continuing.`;
      }
      if (result.expiringSoon) {
        return `${prefix} ⚠️  ONE_CLICK_JWT expires in ${formatDuration(result.secondsUntilExpiry)} (at ${result.expiresAt.toISOString()}). Schedule renewal.`;
      }
      return ""; // healthy → silent
    }
    case "no-exp":
      return `${prefix} ONE_CLICK_JWT has no \`exp\` claim — treating as non-expiring.`;
    case "parseFailed":
      return `${prefix} ⚠️  ONE_CLICK_JWT inspection skipped — ${result.reason}. Live quote requests will surface the real auth status.`;
  }
}

/** Render a non-negative duration in seconds as a short human string. */
function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${abs}s`;
  if (abs < 3600) return `${Math.floor(abs / 60)}m`;
  if (abs < 86400) return `${Math.floor(abs / 3600)}h`;
  return `${Math.floor(abs / 86400)}d`;
}
