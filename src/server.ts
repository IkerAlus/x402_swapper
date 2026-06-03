/**
 * x402-1CS Gateway — HTTP server entry point.
 *
 * Wires together all gateway components and starts an Express server.
 * This is the file you run for a live deployment:
 *
 *   npx tsx src/server.ts
 *
 * Configuration is read from environment variables (see .env.example).
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import { loadConfigFromEnv } from "./infra/config.js";
import { buildCorsOptions } from "./http/cors-options.js";
import { createStateStore } from "./storage/store.js";
import { ProviderPool } from "./infra/provider-pool.js";
import { createChainReader } from "./payment/verifier.js";
import {
  createBroadcastFn,
  createDepositNotifyFn,
  createStatusPollFn,
  recoverInFlightSettlements,
} from "./payment/settler.js";
import { createX402Middleware } from "./http/middleware.js";
import type { MiddlewareDeps } from "./http/middleware.js";
import { createRateLimiting, destroyRateLimiting } from "./infra/rate-limiter.js";
import { waitForSettlementsToFinish } from "./infra/shutdown.js";
import { buildProtectedRoutes } from "./http/protected-routes.js";
import { buildWellKnownDocument } from "./http/discovery.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

async function main(): Promise<void> {
  // ── 0. Global error handlers ───────────────────────────────────────
  process.on("unhandledRejection", (reason) => {
    console.error("[x402-1CS] Unhandled rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[x402-1CS] Uncaught exception:", err);
    // Don't exit immediately — let in-flight settlements finish.
    // The process is in an undefined state, so stop accepting new work
    // and exit after a grace period.
    setTimeout(() => process.exit(1), 5000).unref();
  });

  // ── 1. Load and validate config ────────────────────────────────────
  console.log("[x402-1CS] Loading configuration...");
  const cfg = loadConfigFromEnv();
  console.log(
    `[x402-1CS] Config OK — network=${cfg.originNetwork}, ` +
      `originAsset=${cfg.originAssetIn}, operatorMarginBps=${cfg.operatorMarginBps}`,
  );

  // ── 2. Initialize state store ──────────────────────────────────────
  //
  // Default is in-memory (suitable for development); set STORE_FILE_PATH
  // for crash-safe persistence in any real deployment. The D12 stale-DB
  // fail-fast triggers when the existing file lacks `swapInputs` — see
  // docs/OPERATOR_GUIDE.md § "First boot".
  const store = await createStateStore({
    backend: "sqlite",
    filePath: cfg.storeFilePath,
    saveIntervalMs: cfg.storeSaveIntervalMs,
  });
  if (cfg.storeFilePath) {
    console.log(
      `[x402-1CS] State store initialized (SQLite, file=${cfg.storeFilePath}, ` +
        `flush every ${cfg.storeSaveIntervalMs}ms)`,
    );
  } else {
    console.log(
      "[x402-1CS] State store initialized (SQLite in-memory — set STORE_FILE_PATH for crash-safe persistence)",
    );
  }

  // ── 3. Set up provider pool ────────────────────────────────────────
  const providerPool = new ProviderPool(cfg.originRpcUrls);
  console.log(
    `[x402-1CS] Provider pool ready — ${providerPool.size} RPC endpoint(s)`,
  );

  // ── 4. Create the facilitator wallet ───────────────────────────────
  const wallet = providerPool.getWallet(cfg.facilitatorPrivateKey);
  console.log(`[x402-1CS] Facilitator wallet: ${wallet.address}`);

  // Sanity check: can we reach the RPC?
  try {
    const balance = await wallet.provider!.getBalance(wallet.address);
    const balanceEth = Number(balance) / 1e18;
    console.log(
      `[x402-1CS] Facilitator gas balance: ${balanceEth.toFixed(6)} ETH`,
    );
    if (balance === 0n) {
      console.warn(
        "[x402-1CS] ⚠️  WARNING: Facilitator wallet has ZERO gas balance. " +
          "Transactions will fail. Fund this address before testing.",
      );
    }
  } catch (err) {
    console.error(
      "[x402-1CS] ⚠️  WARNING: Could not reach RPC to check balance:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── 5. Wire up injectable dependencies ─────────────────────────────
  const chainReader = createChainReader(providerPool.getProvider());
  const broadcastFn = createBroadcastFn(wallet);
  const depositNotifyFn = createDepositNotifyFn();
  const statusPollFn = createStatusPollFn();

  // ── 5b. Rate limiting & abuse prevention ────────────────────────────
  const rateLimiting = createRateLimiting(cfg, store);
  console.log(
    `[x402-1CS] Rate limiting — ${cfg.rateLimitQuotesPerWindow} quotes/${cfg.rateLimitWindowMs}ms per IP, ` +
      `${cfg.maxConcurrentSettlements} max concurrent settlements`,
  );
  if (cfg.quoteGcIntervalMs > 0) {
    console.log(
      `[x402-1CS] Quote GC — sweep every ${cfg.quoteGcIntervalMs}ms, grace period ${cfg.quoteGcGracePeriodMs}ms`,
    );
  }

  // Base deps shared across every route — each mounted route adds its
  // own `route` field so the middleware can validate the buyer's query
  // against that route's input schema (Phase 5 / Phase 10).
  const baseDeps: Omit<MiddlewareDeps, "route"> = {
    cfg,
    store,
    chainReader,
    broadcastFn,
    depositNotifyFn,
    statusPollFn,
    resourceDescription: "x402-1CS swap service",
    quoteLimiter: rateLimiting.quoteLimiter,
    settlementLimiter: rateLimiting.settlementLimiter,
  };

  // ── 5c. Recover in-flight settlements from previous run ────────────
  const recovery = await recoverInFlightSettlements(
    store,
    depositNotifyFn,
    statusPollFn,
    rateLimiting.settlementLimiter,
    cfg,
  );
  if (recovery.total > 0) {
    console.log(
      `[x402-1CS] Recovery: ${recovery.started}/${recovery.total} in-flight settlement(s) resumed` +
        (recovery.skipped > 0 ? ` (${recovery.skipped} skipped — at capacity)` : ""),
    );
  }

  // ── 6. Create Express app ──────────────────────────────────────────
  const app = express();
  app.set("trust proxy", 1); // Trust first proxy hop (nginx, Cloudflare, etc.)

  // Security headers (X-Frame-Options, X-Content-Type-Options, CSP defaults, etc.).
  app.use(helmet());

  // CORS: expose x402 custom headers so browser clients can read them, and allow
  // `PAYMENT-SIGNATURE` on incoming requests.
  app.use(cors(buildCorsOptions(cfg)));
  console.log(
    `[x402-1CS] CORS: ${
      cfg.allowedOrigins ? `allowlist=${cfg.allowedOrigins.join(",")}` : "open (reflect any origin)"
    }; helmet: enabled`,
  );

  app.use(express.json({ limit: "1mb" }));

  // ── Protected-routes registry (single source of truth) ────────────
  //
  // Built once here so the discovery surfaces below AND the paid-route
  // loop further down see the same registry. The factory validates the
  // list and binds per-request handlers with access to `cfg`.
  const protectedRoutes = buildProtectedRoutes(cfg);

  // ── Discovery surfaces (x402scan, DNS `_x402`, generic OpenAPI) ────
  //
  // Both endpoints are served BEFORE any paid routes so they are never
  // accidentally gated by the x402 middleware. They are unauthenticated
  // and rate-limit-exempt by design — discovery crawlers (x402scan,
  // `discoverx402` nodes) hit them repeatedly to index the gateway.
  //
  // Documents are computed once at startup: both the routes registry
  // and the config are immutable for the lifetime of the process, so
  // caching is safe and avoids per-request JSON construction.
  const wellKnownDoc = buildWellKnownDocument(cfg, protectedRoutes);
  // Read package metadata once — keeps the OpenAPI builder a pure function.
  // `createRequire(import.meta.url)` is the supported way to load JSON
  // from an ESM module (TypeScript won't let us use `assert { type: "json" }`
  // without rewriting tsconfig module resolution).
  const pkgRequire = createRequire(import.meta.url);
  const pkg = pkgRequire("../package.json") as { name: string; version: string; description?: string };
  const openApiDoc = buildOpenApiDocument(
    {
      title: pkg.name,
      version: pkg.version,
      description: pkg.description,
    },
    cfg,
    protectedRoutes,
  );

  app.get("/.well-known/x402", (_req, res) => {
    res.type("application/json").json(wellKnownDoc);
  });
  app.get("/openapi.json", (_req, res) => {
    res.type("application/json").json(openApiDoc);
  });

  // ── /favicon.ico (and /favicon.png) ───────────────────────────────
  //
  // Browsers auto-fetch /favicon.ico on page load, and discovery validators
  // (e.g. `@agentcash/discovery`) warn `FAVICON_MISSING` when it's absent.
  // The asset itself is the NEAR ecosystem icon shipped at the repo root.
  // Read once at startup → serve from memory, with a long Cache-Control so
  // browsers don't keep re-fetching. Mounted ABOVE the protected-routes
  // loop so it's unauthenticated, same as the discovery surfaces.
  //
  // Resolved relative to this file's location so it works under both
  // `tsx src/server.ts` (dev) and any future compiled-to-dist build.
  const faviconPath = join(dirname(fileURLToPath(import.meta.url)), "../near_icon.png");
  const faviconBytes = readFileSync(faviconPath);
  app.get(["/favicon.ico", "/favicon.png"], (_req, res) => {
    res.type("image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(faviconBytes);
  });

  console.log(
    `[x402-1CS] Discovery — /.well-known/x402 (${wellKnownDoc.resources.length} resource(s), ` +
      `${wellKnownDoc.ownershipProofs.length} proof(s)), /openapi.json (OpenAPI 3.1), ` +
      `/favicon.ico (${faviconBytes.length} bytes)`,
  );

  // Health check (no payment required)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      network: cfg.originNetwork,
      facilitator: wallet.address,
      rpcEndpoints: providerPool.size,
      healthyProviders: providerPool.healthyCount,
      settlements: {
        inFlight: rateLimiting.settlementLimiter.current,
        capacity: rateLimiting.settlementLimiter.capacity,
      },
      rateLimiter: {
        trackedIPs: rateLimiting.quoteLimiter.size,
        quotesPerWindow: cfg.rateLimitQuotesPerWindow,
        windowMs: cfg.rateLimitWindowMs,
      },
    });
  });

  // ── Protected routes — mounted from the registry ──────────────────
  //
  // Every entry in the registry is gated by the x402 middleware and
  // followed by its handler. The same registry drives `/openapi.json`
  // and `/.well-known/x402` above, so adding a new paid endpoint is
  // one registry entry — no edits here.
  //
  // The middleware is built *per route* so it can carry the route's
  // Zod input validator and JSON Schema (used to parse the buyer's
  // query string into a `SwapRequestInput` before quoting).
  for (const route of protectedRoutes) {
    const x402Middleware = createX402Middleware({ ...baseDeps, route });
    const method = route.method.toLowerCase() as "get" | "post";
    app[method](route.path, x402Middleware, route.handler);
  }
  console.log(
    `[x402-1CS] Mounted ${protectedRoutes.length} protected route(s): ${protectedRoutes
      .map((r) => `${r.method} ${r.path}`)
      .join(", ")}`,
  );

  // ── 7. Start server ────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? "3402", 10);
  const server = app.listen(port, () => {
    // Worst-case request duration: broadcast (60s) + polling (maxPollTimeMs=300s) = 360s
    // All three Node.js timeouts must exceed that, with headersTimeout > setTimeout
    // and requestTimeout > headersTimeout per Node.js docs.
    const maxRequestMs = cfg.maxPollTimeMs + 120_000; // poll budget + 2 min headroom
    server.setTimeout(maxRequestMs);
    server.headersTimeout = maxRequestMs + 5_000;
    server.requestTimeout = maxRequestMs + 10_000;
    console.log("");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  x402-1CS Gateway running on http://localhost:${port}`);
    console.log("");
    console.log("  Endpoints:");
    console.log(`    GET /health                — health check (no payment)`);
    console.log(`    GET /openapi.json          — OpenAPI 3.1 spec (discovery)`);
    console.log(`    GET /.well-known/x402      — x402 resource manifest (discovery)`);
    for (const route of protectedRoutes) {
      const label = `${route.method} ${route.path}`.padEnd(26);
      console.log(`    ${label} — ${route.summary} (x402)`);
    }
    console.log("");
    console.log("  To test the 402 flow:");
    console.log(`    curl -i http://localhost:${port}${protectedRoutes[0]!.path}`);
    console.log("═══════════════════════════════════════════════════════");
    console.log("");
  });

  // ── Graceful shutdown ──────────────────────────────────────────────
  //
  // On SIGTERM/SIGINT:
  //   1. Stop accepting new HTTP connections (server.close).
  //   2. Wait up to `cfg.shutdownGraceMs` for in-flight settlements to
  //      finish — a settlement in POLLING can take minutes. Without this
  //      wait the buyer's on-chain transfer would land but the gateway
  //      would forget about it (TODO #3).
  //   3. Tear down rate-limiter timers, flush + close the state store,
  //      destroy RPC providers.
  //   4. Exit cleanly (exit 0 if drained, exit 1 if we forced through).
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double-shutdown on repeated Ctrl+C
    shuttingDown = true;

    console.log("\n[x402-1CS] Shutting down — stopping new connections...");
    server.close();

    // Wait for in-flight settlements to drain.
    const inFlight = rateLimiting.settlementLimiter.current;
    if (inFlight > 0) {
      console.log(
        `[x402-1CS] Waiting up to ${cfg.shutdownGraceMs}ms for ${inFlight} ` +
          `in-flight settlement(s) to finish...`,
      );
    }
    // Throttle progress logs to once every ~5 s so SIGTERM logs don't spam.
    let lastLog = 0;
    const result = await waitForSettlementsToFinish(
      rateLimiting.settlementLimiter,
      cfg.shutdownGraceMs,
      250,
      (current, elapsedMs) => {
        if (elapsedMs - lastLog >= 5_000) {
          console.log(
            `[x402-1CS]   ${current} settlement(s) still in flight (${Math.round(elapsedMs / 1000)}s elapsed)...`,
          );
          lastLog = elapsedMs;
        }
      },
    );
    if (result.status === "drained") {
      console.log(
        `[x402-1CS] All settlements drained in ${result.waitedMs}ms.`,
      );
    } else {
      console.warn(
        `[x402-1CS] ⚠️  Shutdown grace period expired with ${result.finalCount} ` +
          `settlement(s) still in flight after ${result.waitedMs}ms. ` +
          `Their state will be recovered on next start.`,
      );
    }

    // Clean up background timers (rate limiter sweeps, quote GC).
    destroyRateLimiting(rateLimiting);

    // Close state store (clears saveTimer, flushes pending writes, closes DB).
    await store.close();

    // Destroy RPC providers (close WebSocket/HTTP connections).
    providerPool.destroy();

    console.log("[x402-1CS] Cleanup complete.");

    // Exit 0 on clean drain, 1 on forced shutdown (operators / orchestrators
    // can wire alerts off non-zero exits). Without an explicit process.exit
    // the runtime would exit naturally with code 143 (SIGTERM) and our
    // intended code would be lost. The exit must run on a fresh tick so any
    // already-scheduled console.log writes flush first.
    const exitCode = result.status === "drained" ? 0 : 1;
    setImmediate(() => process.exit(exitCode));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[x402-1CS] Fatal error:", err);
  process.exit(1);
});
