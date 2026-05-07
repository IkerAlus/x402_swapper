# x402-1CS Swap Service — Production Readiness TODO

**Date:** 2026-05-07 (post swap-as-resource pivot)
**Test suite status:** 375 passing | 10 skipped (live-only, JWT-gated) — typecheck clean
**Target:** prototype deployment for a small set of users / agents

---

## Current Status

| Area | Status |
|------|--------|
| Core protocol (GET → 402 → sign → settle) | Working (covered by 14 e2e tests + 6 multi-chain integration tests) |
| Buyer-supplied destination (chain / asset / address / amount / refund) | Working |
| EXACT_INPUT 1CS quotes with operator margin (bps) | Working |
| EIP-3009 / Permit2 signing & verification | Working (security-critical paths covered by 34 verifier tests) |
| 1CS integration (quote, deposit, poll) | Working |
| Multi-chain destinations (32+ chains via NEP-141 prefixes) | Working |
| Receipt-as-header (D14 — `PAYMENT-RESPONSE.extensions.crossChain`) | Working |
| Rate limiting (per-IP + settlement cap + GC) | Working |
| RPC provider pool with failover | Working |
| Stale-DB fail-fast at SqliteStateStore.init() (D12) | Working |
| In-flight settlement recovery on restart | Working |
| Error response sanitization (no internals leaked; structured 400 INVALID_INPUT) | Working |
| Buyer-input validation (Zod + chain-format pre-check) | Working |
| Discovery surfaces (`/openapi.json` + `/.well-known/x402` + ownership proofs) | Working |
| TypeScript compilation | Clean |
| ESLint | 0 errors, ~55 warnings (intentional `no-console` + unused-vars in tests) |

---

## Recently Completed — swap-as-resource pivot (2026-05-07)

The codebase pivoted from a single-merchant payment gateway to a swap-as-resource service. Every settlement now routes funds to a buyer-supplied destination address rather than a pre-configured merchant. See [implementation_plan.md](../implementation_plan.md) for the full execution log; high-level deltas:

- **Route registry collapsed to a single `GET /api/swap`** — `pricing.mode` discriminator removed (single product = single pricing shape).
- **Per-request buyer inputs** (`destinationChain`, `destinationAsset`, `destinationAddress`, `amountIn`, optional `refundAddress`) replace the deleted `MERCHANT_*` env vars.
- **EXACT_INPUT semantics** — buyer signs for an exact `amountIn`; slippage upside lands on the buyer (vs the merchant predecessor's EXACT_OUTPUT).
- **Operator margin in basis points** — new `OPERATOR_MARGIN_BPS` env var, surfaced transparently in `extra.crossChain.operatorFee` on every 402.
- **Receipt in PAYMENT-RESPONSE header** (D14) — body is `{}`; the swap receipt (destination tx hashes, slippage, operator fee, formatted amounts) is carried via the standardized x402 `extensions` extensibility hook.
- **Buyer-input validation** — Zod schema gates every field at the request boundary, returns 400 `INVALID_INPUT` with structured details. `validateBuyerDestination` adds chain-format mismatch detection (e.g. EVM destination + NEAR-format address).
- **Test suite rewritten** — 561 → 375 tests after a focused dedup pass (removed library re-tests, per-input variation explosions, cross-file duplicates). Coverage of *our* contracts is unchanged.

---

## BLOCKERS — Must fix before any real user touches it

### 1. Add HTTPS / TLS termination

**Risk:** Payment signatures (`PAYMENT-SIGNATURE` header) travel in plaintext over HTTP. Any network observer can intercept and replay them.

**Fix:** Terminate TLS via a reverse proxy (nginx, Caddy, Cloudflare Tunnel — recommended) or `https` self-host with a cert.

**Files:** Infrastructure-level, or `src/server.ts` if self-hosted TLS.

---

### 2. Enable file-based state persistence

**Risk:** The default `SqliteStateStore` runs in-memory ([src/server.ts:56](../src/server.ts)). A crash or deploy wipes all swap states. Any settlement in `BROADCASTING` or `POLLING` phase is irrecoverable — the buyer's on-chain transfer happened but the gateway forgot about it.

**Fix:**
- Add `STORE_FILE_PATH` and `STORE_SAVE_INTERVAL_MS` env vars to [src/infra/config.ts](../src/infra/config.ts)
- Pass them to `SqliteStateStore` constructor in [src/server.ts](../src/server.ts)
- Document in `.env.example` and the operator guide
- D12 fail-fast already triggers if a file from the merchant predecessor is loaded — no risk there

---

### 3. Graceful shutdown — wait for in-flight settlements

**Risk:** Current shutdown ([src/server.ts:284](../src/server.ts)) calls `server.close()` then `process.exit(0)` after a 1-second grace period. If a settlement is in `POLLING` (can take up to 5 min), the Node.js process exits mid-way, corrupting state. Buyer paid but funds may not reach destination.

**Fix:** Track in-flight settlement count via `SettlementLimiter`. On SIGTERM:
1. Stop accepting new requests (`server.close()` — already done)
2. Poll the in-flight count; wait up to 30s for it to reach zero
3. Run cleanup + exit

**Files:** [src/server.ts](../src/server.ts), possibly [src/infra/rate-limiter.ts](../src/infra/rate-limiter.ts) (expose active count).

---

### 4. Regulatory / KYC posture (deployment-time)

A public swap-as-resource endpoint where buyers route arbitrary amounts to arbitrary destinations is, in many jurisdictions, money services / money transmission activity. **Before any public deployment**, the operator must:

- Get a legal opinion from a crypto-competent lawyer in their primary jurisdiction (US: state-by-state MSB, EU: MiCA, UK: FCA, SG: MAS).
- Decide whether the service is geofenced, KYC'd at signup, or fully open.
- Decide whether ToS / disclaimers belong at the 402 challenge level (`extra.crossChain.terms` extension).

This is **not a code item** — it's an operator concern. See [docs/OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) § "Regulatory considerations" for the full discussion.

---

## STRONGLY RECOMMENDED — Important for a stable prototype

### 5. Validate RPC reachability at startup

**Current:** If all RPC URLs are unreachable, the server starts fine but every settlement fails at broadcast time. There's a facilitator balance check at startup, but it's non-blocking.

**Fix:** On startup, call `eth_blockNumber` on the primary RPC. If all configured RPCs fail, refuse to start.

**File:** [src/server.ts](../src/server.ts).

---

### 6. Check 1CS JWT expiry at startup

**Current:** If the JWT expires, every quote request fails with 401 (which surfaces as 503 `AUTHENTICATION_ERROR` to the buyer) and there's no warning.

**Fix:** Decode the JWT payload, log expiry at startup, warn if < 7 days remaining, fail fast if already expired.

**File:** [src/server.ts](../src/server.ts).

---

### 7. Add structured logging

**Current:** Bare `console.log`/`console.warn` — no timestamps on the happy-path lines, no correlation IDs on success logs (errors do carry them). The `no-console` ESLint warnings flag the intentional uses.

**Fix:** Adopt `pino` for JSON output with per-request correlation IDs. The error path already generates correlation IDs ([src/http/middleware.ts](../src/http/middleware.ts) `generateCorrelationId`); thread them through the success path too.

**Files:** [src/payment/settler.ts](../src/payment/settler.ts), [src/http/middleware.ts](../src/http/middleware.ts), [src/payment/quote-engine.ts](../src/payment/quote-engine.ts), [src/server.ts](../src/server.ts).

---

### 8. Buyer abuse mitigation — `MAX_AMOUNT_IN` cap

**Risk:** A public GET endpoint that quotes 1CS for any destination/asset/amount is a quote-DoS surface. Mitigations in place: per-IP `quoteLimiter` (rate-limits 402 generation), `settlementLimiter` (caps concurrent settlements). What's missing: an upper bound on per-request amount.

**Fix:** Add `MAX_AMOUNT_IN` env var; reject `amountIn` above the cap with 400 `INVALID_INPUT` before contacting 1CS. Bound the operator's quote-economics exposure per request.

**Files:** [src/infra/config.ts](../src/infra/config.ts), [src/http/swap-input.ts](../src/http/swap-input.ts) (cross-field check after Zod parse).

---

### 9. Make slippage tolerance configurable

**Current:** `slippageTolerance: 50` (0.5%) is hardcoded in [src/payment/quote-engine.ts](../src/payment/quote-engine.ts) `buildSwapQuoteRequest`. For swap-as-resource, the buyer is more sensitive to slippage than a merchant; some operators may want tighter (10 bps) or looser (200 bps) defaults.

**Fix:** Add `SLIPPAGE_TOLERANCE_BPS` env var with a sensible default (50). Surface the active value in `extra.crossChain` so the buyer can see it.

**Files:** [src/infra/config.ts](../src/infra/config.ts), [src/payment/quote-engine.ts](../src/payment/quote-engine.ts).

---

### 10. Gateway authentication

**Current:** Anyone who discovers the gateway URL can trigger 402 flows, consuming 1CS quotes (rate-limited by your JWT).

**Fix:** Add an `X-API-Key` middleware (simplest), mTLS, or an IP allowlist. The 402-discovery story still works against authenticated buyers — just adds a second factor for the gateway's economic exposure.

**File:** [src/server.ts](../src/server.ts) (new middleware before paid routes).

---

## NICE-TO-HAVE — Production hardening

### 11. Automatic buyer refunds on 1CS failure

**Current:** When 1CS reports `FAILED` after the on-chain `transferWithAuthorization` succeeded, the buyer's USDC is at the 1CS deposit address. The 1CS API can refund automatically when `refundTo` is set (which the gateway does — buyer's `refundAddress` when supplied, else `gatewayRefundAddress`). For deeper failure modes (e.g. funds end up at the gateway address), the operator forwards manually.

**Fix:** Build a watchdog that monitors `gatewayRefundAddress` for unexpected balances and auto-routes to the recoverable buyer (using their `refundAddress` from `state.swapInputs` when set; falling back to a manual queue otherwise).

---

### 12. Multi-origin support

**Current:** Single `ORIGIN_*` env-var set per deploy. Buyer pays in the configured token only.

**Fix:** Allow buyer to specify the origin chain/asset per-request, rotate provider pools by chain. Adds 3–5 days. Separate plan.

---

### 13. KYC / sanctions / geofencing hooks

**Current:** Documented as deployment-time concerns in [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md). No in-tree code.

**Fix (when needed):** Add a request-time hook (e.g. `cfg.requestPolicyFn(req): Promise<{allow: boolean; reason?: string}>`) that the middleware calls before quoting. Operators inject their policy (Chainalysis, OFAC list, IP geolocation) without forking the gateway.

---

### 14. Prometheus `/metrics` endpoint

Settlement-latency histograms, error-rate counters, 1CS quote success rates, active-settlement gauges, operator-fee revenue. Ungated by default — add IP allowlist if exposed.

---

### 15. Circuit breaker for RPC failures

Currently retries the RPC rotation blindly. A circuit breaker (e.g., `cockatiel`, `opossum`) would back off after N consecutive failures instead of hammering a dead RPC.

---

### 16. Replace `sql.js` with `better-sqlite3`

`sql.js` is pure-JS SQLite (slower, larger memory footprint). `better-sqlite3` is a native binding — synchronous, faster, battle-tested for Node.js server workloads.

---

### 17. Key rotation without restart

Currently, changing the facilitator private key requires a full service restart. Add a SIGHUP handler or admin endpoint that reloads the key from the secrets manager.

---

### 18. Health endpoint authentication

`/health` exposes in-flight settlement count, rate-limiter state, and provider health to anyone. Consider requiring an API key or restricting access by IP.

---

### 19. Lint cleanup

~55 ESLint warnings, all pre-existing (intentional `no-console` in `server.ts` + unused-vars in tests). Fix the unused-vars warnings in a single pass; leave `no-console` until structured logging (#7) lands.

---

## Priority Roadmap

```
Phase 1 — Go-live minimum (blockers 1-4)
  ├── #1  TLS termination               (~30 min, infra)
  ├── #2  File-based persistence        (~30 min)
  ├── #3  Graceful shutdown (wait)      (~1-2 hrs)
  └── #4  Regulatory / KYC posture      (legal review, days–weeks)

Phase 2 — Stable prototype (items 5-10)
  ├── #5  RPC startup validation        (~20 min)
  ├── #6  JWT expiry check              (~20 min)
  ├── #8  MAX_AMOUNT_IN cap             (~30 min)
  ├── #9  Configurable slippage         (~30 min)
  ├── #10 Gateway authentication        (~1 hr)
  └── #7  Structured logging            (~2 hrs)

Phase 3 — Production hardening (items 11-19)
  └── As needed based on scale, jurisdiction, and operational experience
```

---

## Reference

| Document | Purpose |
|----------|---------|
| [README.md](../README.md) | Project overview, setup, quickstart |
| [docs/USER_GUIDE.md](USER_GUIDE.md) | Buyer-facing usage guide |
| [docs/OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) | Operator-facing regulatory + ops guide |
| [docs/Facilitator_keys_guidance.md](Facilitator_keys_guidance.md) | Facilitator wallet key management |
| [docs/X402SCAN_PLAN.md](X402SCAN_PLAN.md) | x402scan integration design notes (historical, predates swap-mode pivot) |
| [implementation_plan.md](../implementation_plan.md) | Swap-mode pivot execution log (Phases 1–13) |
| [SWAP_AS_RESOURCE.md](../SWAP_AS_RESOURCE.md) | Original product brief (preserved as historical context) |
