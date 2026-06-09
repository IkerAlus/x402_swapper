/**
 * Tests for the JWT expiry inspector (TODO #6).
 *
 * The inspector is a pure function: it takes a JWT string + a `now`
 * timestamp and returns a structured result. Tests build minimal JWTs
 * directly (header.payload.signature, only payload matters since we
 * never verify the signature) and assert each outcome class.
 */

import { describe, it, expect } from "vitest";
import { inspectJwtExpiry, formatJwtInspection, WARN_THRESHOLD_DAYS } from "./jwt-check.js";

/**
 * Build a minimal JWT with the given `exp` claim (seconds since epoch).
 * The header + signature segments are constant — only the payload matters
 * for `inspectJwtExpiry`.
 */
function buildJwt(payload: Record<string, unknown>): string {
  const headerB64 = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${headerB64}.${payloadB64}.signature-placeholder`;
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z fixed test clock

describe("inspectJwtExpiry — healthy tokens", () => {
  it("returns 'checked' with a far-future exp as healthy and not-expiring-soon", () => {
    const expSec = Math.floor(NOW / 1000) + 30 * 24 * 60 * 60; // +30 days
    const jwt = buildJwt({ exp: expSec, sub: "test" });
    const result = inspectJwtExpiry(jwt, NOW);

    expect(result.kind).toBe("checked");
    if (result.kind !== "checked") return; // narrow
    expect(result.expired).toBe(false);
    expect(result.expiringSoon).toBe(false);
    expect(result.secondsUntilExpiry).toBe(30 * 24 * 60 * 60);
    expect(result.expiresAt.toISOString()).toBe(new Date(expSec * 1000).toISOString());
  });
});

describe("inspectJwtExpiry — expired tokens", () => {
  it("flags expired=true when exp is in the past", () => {
    const expSec = Math.floor(NOW / 1000) - 60 * 60; // 1h ago
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);

    expect(result.kind).toBe("checked");
    if (result.kind !== "checked") return;
    expect(result.expired).toBe(true);
    expect(result.expiringSoon).toBe(false);
    expect(result.secondsUntilExpiry).toBeLessThan(0);
  });

  it("flags expired=true at exact boundary (exp === now)", () => {
    const expSec = Math.floor(NOW / 1000);
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);

    if (result.kind !== "checked") throw new Error("expected checked");
    expect(result.expired).toBe(true);
    expect(result.secondsUntilExpiry).toBe(0);
  });
});

describe("inspectJwtExpiry — expiring soon", () => {
  it("flags expiringSoon when within the default 7-day threshold", () => {
    const expSec = Math.floor(NOW / 1000) + 3 * 24 * 60 * 60; // +3 days
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);

    if (result.kind !== "checked") throw new Error("expected checked");
    expect(result.expired).toBe(false);
    expect(result.expiringSoon).toBe(true);
  });

  it("honors a custom warn threshold", () => {
    const expSec = Math.floor(NOW / 1000) + 10 * 24 * 60 * 60; // +10 days
    const jwt = buildJwt({ exp: expSec });
    // Default threshold (7d) → not expiring soon
    const defaultResult = inspectJwtExpiry(jwt, NOW);
    if (defaultResult.kind !== "checked") throw new Error("expected checked");
    expect(defaultResult.expiringSoon).toBe(false);
    // Custom 14-day threshold → IS expiring soon
    const tightResult = inspectJwtExpiry(jwt, NOW, 14);
    if (tightResult.kind !== "checked") throw new Error("expected checked");
    expect(tightResult.expiringSoon).toBe(true);
  });

  it("constant WARN_THRESHOLD_DAYS matches the default behaviour", () => {
    // sanity: ensure the exported constant matches what the default
    // parameter actually applies — guards against drift.
    const expSec =
      Math.floor(NOW / 1000) + (WARN_THRESHOLD_DAYS - 0.5) * 24 * 60 * 60;
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);
    if (result.kind !== "checked") throw new Error("expected checked");
    expect(result.expiringSoon).toBe(true);
  });
});

describe("inspectJwtExpiry — missing or malformed", () => {
  it("returns 'no-exp' when the payload lacks an exp claim", () => {
    const jwt = buildJwt({ sub: "test" }); // no exp
    const result = inspectJwtExpiry(jwt, NOW);
    expect(result.kind).toBe("no-exp");
  });

  it("returns 'parseFailed' on empty string", () => {
    const result = inspectJwtExpiry("", NOW);
    expect(result.kind).toBe("parseFailed");
    if (result.kind === "parseFailed") {
      expect(result.reason).toMatch(/empty/i);
    }
  });

  it("returns 'parseFailed' on wrong segment count", () => {
    const result = inspectJwtExpiry("not.a.valid.jwt", NOW);
    expect(result.kind).toBe("parseFailed");
    if (result.kind === "parseFailed") {
      expect(result.reason).toMatch(/3 dot-separated/);
    }
  });

  it("returns 'parseFailed' on non-base64 payload", () => {
    const result = inspectJwtExpiry("h.@@@.s", NOW);
    expect(result.kind).toBe("parseFailed");
  });

  it("returns 'parseFailed' when exp is not a number", () => {
    const jwt = buildJwt({ exp: "next-tuesday" as unknown as number });
    const result = inspectJwtExpiry(jwt, NOW);
    expect(result.kind).toBe("parseFailed");
    if (result.kind === "parseFailed") {
      expect(result.reason).toMatch(/exp is not a number/);
    }
  });
});

describe("inspectJwtExpiry — base64url decoding", () => {
  it("accepts base64url-specific characters (- and _, no padding)", () => {
    // Manually craft a payload that uses `-` and `_` and is missing padding,
    // to exercise the base64url → base64 conversion. Force `>` and `?` in the
    // raw JSON by including ">" and "?" in a string field — base64-encoded
    // those map to `Pg==` / `Pw==` (don't contain - or _). Use a longer
    // string to make padding non-trivial.
    const expSec = Math.floor(NOW / 1000) + 86_400;
    const jwt = buildJwt({ exp: expSec, sub: "this is a longer subject ?>$" });
    const result = inspectJwtExpiry(jwt, NOW);
    expect(result.kind).toBe("checked");
  });
});

describe("formatJwtInspection — operator log messages", () => {
  it("returns empty string on a healthy (silent) token", () => {
    const expSec = Math.floor(NOW / 1000) + 30 * 24 * 60 * 60;
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);
    expect(formatJwtInspection(result)).toBe("");
  });

  it("formats an expired-token message with the ❌ marker and 'ago' duration", () => {
    const expSec = Math.floor(NOW / 1000) - 2 * 24 * 60 * 60;
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);
    const line = formatJwtInspection(result);
    expect(line).toContain("❌");
    expect(line).toContain("expired");
    expect(line).toMatch(/\b2d ago\b/);
  });

  it("formats an expiring-soon message with the ⚠️ marker", () => {
    const expSec = Math.floor(NOW / 1000) + 2 * 24 * 60 * 60;
    const jwt = buildJwt({ exp: expSec });
    const result = inspectJwtExpiry(jwt, NOW);
    const line = formatJwtInspection(result);
    expect(line).toContain("⚠️");
    expect(line).toMatch(/expires in 2d/);
  });

  it("formats a no-exp message clearly", () => {
    const result = inspectJwtExpiry(buildJwt({}), NOW);
    expect(formatJwtInspection(result)).toMatch(/no `exp` claim/);
  });

  it("formats a parseFailed message indicating live requests are authoritative", () => {
    const result = inspectJwtExpiry("garbage", NOW);
    expect(formatJwtInspection(result)).toMatch(/Live quote requests/);
  });
});
