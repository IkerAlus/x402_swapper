# x402-1CS Swap Service — Production Readiness TODO

**Last touched:** 2026-06-09 (TODO #5, #6, #8, #9 landed — PR A operability quick wins)
**Test suite status:** 485 passing | 13 skipped (live-only, JWT-gated) — typecheck clean
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
| RPC reachability check at startup (TODO #5) | Working — refuses boot when 0/N reachable |
| 1CS JWT expiry check at startup (TODO #6) | Working — refuses boot when expired, warns when <7d |
| `MAX_AMOUNT_IN` cap (TODO #8) | Optional, opt-in via env-var |
| Configurable slippage tolerance (TODO #9) | Working — defaults to 50 bps, env-tunable |
| Stale-DB fail-fast at SqliteStateStore.init() (D12) | Working |
| In-flight settlement recovery on restart | Working |
| Error response sanitization (no internals leaked; structured 400 INVALID_INPUT) | Working |
| Buyer-input validation (Zod + chain-format pre-check) | Working |
| Discovery surfaces (`/openapi.json` + `/.well-known/x402` + ownership proofs) | Working |
| TypeScript compilation | Clean |
| ESLint | 0 errors, ~55 warnings (intentional `no-console` + unused-vars in tests) |

---

## Recently Completed

### 2026-06-09 — Operability quick wins (TODO #5, #6, #8, #9)

PR A from the production-readiness roadmap. Four small, independent additions, all behind defaults that preserve existing behaviour. Test suite: 434 → 485 passing (+51).

- **TODO #5 — RPC reachability check at startup**. `ProviderPool.checkReachability()` probes every URL with `eth_blockNumber` in parallel; `server.ts` refuses boot when 0/N are reachable and warns when partial. Previously a bad RPC URL only surfaced at first broadcast — by which point the buyer had signed.
- **TODO #6 — 1CS JWT expiry check at startup**. New `src/infra/jwt-check.ts` base64url-decodes the `exp` claim (no signature verification, no JWT library); `server.ts` refuses boot on expired tokens and warns when `< 7 days` to expiry. Silent for healthy tokens.
- **TODO #8 — `MAX_AMOUNT_IN` cap**. Optional env-var bounding the buyer-supplied `amountIn`; enforced BigInt-wise *before* contacting 1CS. Rejects with `400 INVALID_INPUT` carrying a `buyer-format` detail. Preserves JWT quota, prevents inattentive-buyer 10× sign-ups. Defaults unset for dev-friendliness.
- **TODO #9 — `SLIPPAGE_TOLERANCE_BPS` env var**. Replaces the hardcoded 50-bps slippage tolerance; range 0–1000 bps (safety cap below 1CS's own 10000-bps API limit). Surfaced on every 402 as `extra.crossChain.slippageToleranceBps` so buyers see the worst case they're accepting.

### 2026-05-13 — Persistence + graceful shutdown (TODO #2, #3)

Closed two of the four go-live blockers — both code-local and ~3 hrs combined.

- **File-based state persistence** — new `STORE_FILE_PATH` and `STORE_SAVE_INTERVAL_MS` env vars wired through `src/infra/config.ts` → `createStateStore` in `src/server.ts`. Default stays in-memory (dev-friendly); production deployments set `STORE_FILE_PATH` to survive crashes/deploys. D12 stale-DB fail-fast already covered the upgrade-from-merchant-mode case.
- **Graceful shutdown** — new `SHUTDOWN_GRACE_MS` (default 30 s) drives a wait loop on `SettlementLimiter.current` before tearing down the store/providers. New `src/infra/shutdown.ts` houses the testable `waitForSettlementsToFinish(counter, graceMs)` helper (9 unit tests covering drain, timeout, validation, structural typing). Exit code now reflects outcome — 0 on clean drain, 1 on forced shutdown.
- **Test suite**: 416 → 434 passing.
- **Docs**: `.env.example`, README optional-fields table, OPERATOR_GUIDE operational checklist all updated.

### 2026-05-11 — Buyer-input error UX (TODO non-blocker)

Buyer-facing error envelope rewritten — see commits `044e405` (structured `ErrorDetail[]` discriminated union: `buyer-zod` / `buyer-format` / `upstream` / `gateway-hint`) and `6307e31` (Zod regex relaxed to accept all 1CS asset-ID prefixes including `1cs_v1:`). 1CS 400s now route by message classification: buyer-fault → 400, operator-fault → 503, unknown → 400 with a gateway-hint listing likely candidates.

### 2026-05-07 — Swap-as-resource pivot

The codebase pivoted from a single-merchant payment gateway to a swap-as-resource service. Every settlement now routes funds to a buyer-supplied destination address rather than a pre-configured merchant. See [implementation_plan.md](../implementation_plan.md) for the full execution log; high-level deltas:

- **Route registry collapsed to a single `GET /api/swap`** — `pricing.mode` discriminator removed (single product = single pricing shape).
- **Per-request buyer inputs** (`destinationAsset`, `destinationAddress`, `amountIn`, optional `refundAddress`) replace the deleted `MERCHANT_*` env vars. (Originally included a separate `destinationChain` field; removed 2026-05-11 as redundant — derived from the asset's prefix.)
- **EXACT_INPUT semantics** — buyer signs for an exact `amountIn`; slippage upside lands on the buyer (vs the merchant predecessor's EXACT_OUTPUT).
- **Operator margin in basis points** — new `OPERATOR_MARGIN_BPS` env var, surfaced transparently in `extra.crossChain.operatorFee` on every 402.
- **Receipt in PAYMENT-RESPONSE header** (D14) — body is `{}`; the swap receipt (destination tx hashes, slippage, operator fee, formatted amounts) is carried via the standardized x402 `extensions` extensibility hook.
- **Buyer-input validation** — Zod schema gates every field at the request boundary, returns 400 `INVALID_INPUT` with structured details. `validateBuyerDestination` adds chain-format mismatch detection (e.g. EVM destination + NEAR-format address).
- **Test suite rewritten** — 561 → 375 tests after a focused dedup pass (removed library re-tests, per-input variation explosions, cross-file duplicates). Coverage of *our* contracts is unchanged.

---

## BLOCKERS — Must fix before any real user touches it

> **Note on numbering**: IDs (#1, #4, #7, #10, …) are stable for cross-reference from code comments and `OPERATOR_GUIDE.md`. Gaps indicate items moved to "Recently Completed":
> - #2 (file persistence) + #3 (graceful shutdown) closed 2026-05-13
> - #5 (RPC reachability) + #6 (JWT expiry) + #8 (MAX_AMOUNT_IN) + #9 (slippage) closed 2026-06-09

### 1. Add HTTPS / TLS termination

**Risk:** Payment signatures (`PAYMENT-SIGNATURE` header) travel in plaintext over HTTP. Any network observer can intercept and replay them.

**Fix:** Terminate TLS via a reverse proxy (nginx, Caddy, Cloudflare Tunnel — recommended) or `https` self-host with a cert.

**Files:** Infrastructure-level, or `src/server.ts` if self-hosted TLS.

---

### 4. Regulatory / KYC posture (deployment-time)

A public swap-as-resource endpoint where buyers route arbitrary amounts to arbitrary destinations is, in many jurisdictions, money services / money transmission activity. **Before any public deployment**, the operator must:

- Get a legal opinion from a crypto-competent lawyer in their primary jurisdiction (US: state-by-state MSB, EU: MiCA, UK: FCA, SG: MAS).
- Decide whether the service is geofenced, KYC'd at signup, or fully open.
- Decide whether ToS / disclaimers belong at the 402 challenge level (`extra.crossChain.terms` extension).

This is **not a code item** — it's an operator concern. See [docs/OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) § "Regulatory considerations" for the full discussion.

---

## STRONGLY RECOMMENDED — Important for a stable prototype

### 7. Add structured logging

**Current:** Bare `console.log`/`console.warn` — no timestamps on the happy-path lines, no correlation IDs on success logs (errors do carry them). The `no-console` ESLint warnings flag the intentional uses.

**Fix:** Adopt `pino` for JSON output with per-request correlation IDs. The error path already generates correlation IDs ([src/http/middleware.ts](../src/http/middleware.ts) `generateCorrelationId`); thread them through the success path too.

**Files:** [src/payment/settler.ts](../src/payment/settler.ts), [src/http/middleware.ts](../src/http/middleware.ts), [src/payment/quote-engine.ts](../src/payment/quote-engine.ts), [src/server.ts](../src/server.ts).

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
Phase 1 — Go-live minimum
  ├── #1  TLS termination               (~30 min, infra)         [OPEN]
  ├── #2  File-based persistence        (~30 min)                [DONE 2026-05-13]
  ├── #3  Graceful shutdown (wait)      (~1-2 hrs)               [DONE 2026-05-13]
  └── #4  Regulatory / KYC posture      (legal review, days–weeks) [OPEN]

Phase 2 — Stable prototype (items 5-10)
  ├── #5  RPC startup validation        (~20 min)                [DONE 2026-06-09]
  ├── #6  JWT expiry check              (~20 min)                [DONE 2026-06-09]
  ├── #8  MAX_AMOUNT_IN cap             (~30 min)                [DONE 2026-06-09]
  ├── #9  Configurable slippage         (~30 min)                [DONE 2026-06-09]
  ├── #10 Gateway authentication        (~1 hr)                  [OPEN — PR B]
  └── #7  Structured logging            (~2 hrs)                 [OPEN — PR C]

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
| [implementation_plan.md](../implementation_plan.md) | Swap-mode pivot execution log (Phases 1–14) |
| [SWAP_AS_RESOURCE.md](../SWAP_AS_RESOURCE.md) | Original product brief (preserved as historical context) |
