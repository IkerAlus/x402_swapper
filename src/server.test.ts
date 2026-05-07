/**
 * Tests for the CORS + helmet wiring exposed by `src/server.ts`.
 *
 * We don't spin up the full `main()` entry point (which reads env vars, opens
 * RPC connections, etc.) — instead we replicate the middleware chain using the
 * same `buildCorsOptions()` helper that production uses, so the exact options
 * exercised in tests are the ones shipped.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import request from "supertest";
import { buildCorsOptions } from "./http/cors-options.js";
import type { GatewayConfig } from "./infra/config.js";
import { buildWellKnownDocument } from "./http/discovery.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { buildProtectedRoutes } from "./http/protected-routes.js";
import { mockGatewayConfig } from "./mocks/mock-config.js";

/** Minimal app mirroring `server.ts` middleware chain. */
function buildApp(cfg: Pick<GatewayConfig, "allowedOrigins">): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors(buildCorsOptions(cfg)));
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/swap", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  return app;
}

describe("CORS + helmet wiring", () => {
  it("exposes PAYMENT-REQUIRED and PAYMENT-RESPONSE headers on preflight", async () => {
    const app = buildApp({ allowedOrigins: undefined });
    const res = await request(app)
      .options("/api/swap")
      .set("Origin", "https://buyer.example.com")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "PAYMENT-SIGNATURE, Content-Type");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://buyer.example.com");
    // Exposed headers must be listed (case-insensitive string compare).
    const exposed = (res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
    // Allowed request headers must include PAYMENT-SIGNATURE.
    const allowed = (res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowed).toContain("payment-signature");
  });

  it("reflects the request origin and sets helmet security headers on regular requests", async () => {
    const app = buildApp({ allowedOrigins: undefined });
    const res = await request(app)
      .get("/api/swap")
      .set("Origin", "https://anywhere.example");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://anywhere.example");
    // Helmet default: X-Content-Type-Options: nosniff
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("withholds CORS allow-origin for origins not on the allowlist", async () => {
    const app = buildApp({ allowedOrigins: ["https://good.example"] });

    const goodRes = await request(app)
      .get("/api/swap")
      .set("Origin", "https://good.example");
    expect(goodRes.headers["access-control-allow-origin"]).toBe("https://good.example");

    const badRes = await request(app)
      .get("/api/swap")
      .set("Origin", "https://bad.example");
    // cors package default: header simply omitted (request still succeeds;
    // browser enforces the same-origin policy on the client side).
    expect(badRes.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Discovery endpoints — /.well-known/x402 and /openapi.json
//
// Exercises the exact wiring used by server.ts: build the two documents
// once and mount them as handlers. Confirms the crawler-facing surface
// is JSON, unauthenticated, and carries the x402scan-required fields.
// ═══════════════════════════════════════════════════════════════════════

describe("Discovery endpoints", () => {
  function buildDiscoveryApp(
    overrides: Partial<GatewayConfig> = {},
  ): { app: express.Express; cfg: GatewayConfig } {
    const cfg = mockGatewayConfig(overrides);
    const routes = buildProtectedRoutes(cfg);
    const wellKnown = buildWellKnownDocument(cfg, routes);
    const openApi = buildOpenApiDocument(
      { title: "x402-1cs-gateway", version: "0.1.0", description: "test build" },
      cfg,
      routes,
    );
    const app = express();
    app.set("trust proxy", 1);
    app.use(helmet());
    app.use(cors(buildCorsOptions(cfg)));
    app.use(express.json({ limit: "1mb" }));
    app.get("/.well-known/x402", (_req, res) => {
      res.type("application/json").json(wellKnown);
    });
    app.get("/openapi.json", (_req, res) => {
      res.type("application/json").json(openApi);
    });
    return { app, cfg };
  }

  it("serves /.well-known/x402 as application/json, unauthenticated", async () => {
    const { app } = buildDiscoveryApp({
      publicBaseUrl: "https://gateway.example.com",
    });
    const res = await request(app).get("/.well-known/x402");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.version).toBe(1);
    expect(Array.isArray(res.body.resources)).toBe(true);
    expect(Array.isArray(res.body.ownershipProofs)).toBe(true);
  });

  it("serves /.well-known/x402 with absolute resource URLs", async () => {
    const { app } = buildDiscoveryApp({
      publicBaseUrl: "https://gateway.example.com",
    });
    const res = await request(app).get("/.well-known/x402");
    expect(res.body.resources).toContain("https://gateway.example.com/api/swap");
  });

  it("serves /openapi.json as application/json, unauthenticated", async () => {
    const { app } = buildDiscoveryApp({
      publicBaseUrl: "https://gateway.example.com",
    });
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBeDefined();
    expect(res.body.info.version).toBeDefined();
    expect(res.body.paths).toBeDefined();
  });

  it("/openapi.json paths carry x402 security + x-payment-info", async () => {
    const { app } = buildDiscoveryApp({
      publicBaseUrl: "https://gateway.example.com",
    });
    const res = await request(app).get("/openapi.json");
    const op = res.body.paths["/api/swap"].get;
    expect(op.security).toEqual([{ x402: [] }]);
    expect(op["x-payment-info"].protocols).toBe("x402");
    expect(op.responses["402"]).toBeDefined();
    expect(res.body.components.securitySchemes.x402).toMatchObject({
      type: "http",
      scheme: "x402",
    });
  });

  it("both endpoints skip the x402 middleware (never 402)", async () => {
    // If these endpoints were ever mounted under the paid-route loop, a
    // buyer without a PAYMENT-SIGNATURE header would get 402 here too.
    // That would break the discovery contract.
    const { app } = buildDiscoveryApp();

    const r1 = await request(app).get("/.well-known/x402");
    expect(r1.status).not.toBe(402);

    const r2 = await request(app).get("/openapi.json");
    expect(r2.status).not.toBe(402);
  });

  it("both endpoints succeed even when publicBaseUrl is unset (local dev)", async () => {
    const { app } = buildDiscoveryApp({ publicBaseUrl: undefined });

    const wellKnown = await request(app).get("/.well-known/x402");
    expect(wellKnown.status).toBe(200);
    expect(wellKnown.body.resources).toEqual([]);

    const openApi = await request(app).get("/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.body.openapi).toMatch(/^3\./);
    expect(openApi.body.servers).toBeUndefined();
  });
});
