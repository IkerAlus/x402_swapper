# x402-1CS Swap Service — Operator Guide

This guide is for the operator of an x402-gated swap service — the person responsible for running the gateway, holding the facilitator key, and setting policy. It covers regulatory considerations, KYC/sanctions/geofencing as deployment-time concerns, the operator margin knob, the refund flow, first boot, and operational hardening you should think about before any real user touches the service.

This is **not legal advice**. The regulatory section sketches the questions a regulator might ask; the answers depend on your jurisdiction and your specific deployment. Get a crypto-competent lawyer in your primary jurisdiction before launching publicly.

---

## What this service is, from a regulator's perspective

You're running a public HTTP endpoint where any anonymous buyer can:

- Send USDC on Base to your gateway,
- Pay you a margin (basis points) on top of the underlying swap rate, and
- Have those funds routed cross-chain to a destination address of *their* choosing on any of 32+ chains.

In most jurisdictions, this looks like **money services / money transmission activity**. The gateway is non-custodial in the strict sense — funds flow `Buyer → 1CS deposit address → Buyer's destination address`, never through the operator's wallet — but a regulator will likely focus on these facts:

- You accept USDC from a buyer.
- You charge a margin.
- You route funds to a different chain.
- You return funds at a destination of the buyer's choosing.

That's enough to trigger MSB / money-transmitter analysis under most regimes. Specific regimes worth checking:

- **United States**: state-by-state money transmitter licensing + federal MSB registration with FinCEN.
- **European Union**: MiCA (Markets in Crypto-Assets) — likely a CASP (Crypto-Asset Service Provider).
- **United Kingdom**: FCA cryptoasset registration regime.
- **Singapore**: MAS Payment Services Act.
- **Switzerland**: FINMA — likely covered under VASP framework.

The merchant-mode predecessor of this codebase sidestepped most of this analysis: the merchant was the operator's known counterparty, funds always went to one preconfigured destination. The swap-as-resource use case loses that simplicity. **Before any public deployment**, get a legal opinion specific to your jurisdiction and your operational posture (geofenced? KYC at signup? fully open?).

---

## Deployment-time policy decisions

The codebase is deliberately **policy-free**. It will route funds between any pair of chains 1CS supports for any anonymous buyer who hits the endpoint. The following decisions are yours to make at deployment time — none of them are baked in:

### 1. KYC at signup

**Default in the codebase**: none. Anyone with the URL can pay.

**Options for adding it**:
- Fronting reverse proxy (nginx, Cloudflare) that requires a signed-in account before forwarding to the gateway.
- Custom auth middleware in front of the x402 middleware (e.g. `X-API-Key` header bound to a known account, mTLS, OAuth, or a session cookie).
- A "register first" gate where the buyer's EVM address is pre-allowlisted after a KYC flow you run separately.

The protected-routes registry doesn't currently expose a per-request hook for "is this buyer allowed?" — adding one would be a small change ([src/http/middleware.ts](../src/http/middleware.ts) before the `parseAndValidateInputs` call), tracked as item #13 in [docs/TODO.md](TODO.md).

### 2. Sanctions / OFAC screening

**Default**: none. The buyer's signed EVM address is recovered during verification ([src/payment/verifier.ts](../src/payment/verifier.ts)), but it's not screened against any list.

**Options**:
- Chainalysis / Elliptic / TRM Labs integration: screen the signer's address before settlement; reject if flagged.
- OFAC SDN list: maintain a local copy, screen at request-handling time.
- Sanctioned-jurisdiction geo-IP block (see #3).

These hooks belong before the verification step in the middleware. Reject early; a settlement that's been broadcast can't easily be unwound.

### 3. Geofencing

**Default**: none.

**Options**:
- Cloudflare / fastly / your CDN's geo-IP rules: block known sanctioned jurisdictions outright.
- IP allowlist in your reverse proxy.
- Headers from your edge (`CF-IPCountry`, etc.) checked in middleware.

Note that buyers can sidestep IP-based geofencing with a VPN. For high-stakes use cases (large amounts, restricted jurisdictions), pair geofencing with KYC.

### 4. Per-buyer / per-route limits

**Default**: per-IP rate limits (`RATE_LIMIT_QUOTES_PER_WINDOW`, default 20/min) and a global concurrent settlement cap (`MAX_CONCURRENT_SETTLEMENTS`, default 10). No per-amount cap.

**Recommendations**:
- Add `MAX_AMOUNT_IN` env var (item #8 in TODO) to bound the operator's quote-economics exposure per request.
- Consider per-buyer (signer-address) daily / monthly volume caps if the regulatory regime requires them.

### 5. ToS / disclaimers at the 402 challenge

**Default**: the 402 envelope's `extra.crossChain` block is informational only — it doesn't carry a `terms` field. You can extend it (it's an extensibility hook):

```ts
// In src/payment/quote-engine.ts buildCrossChainExtra
out.terms = "https://your-domain.com/terms-of-service";
```

x402 clients that surface this to the buyer (the included `X402Client` doesn't yet, but agent SDKs may) can show the link. Useful for jurisdictions where pre-purchase disclaimer / consent is required.

---

## Operator margin

`OPERATOR_MARGIN_BPS` (basis points) is your knob — the operator fee taken on every swap. Range `0`–`500` (0% to 5%). 1CS rejects appFees above 500 bps with a 400 ("Total fee is N basis points, which exceeds 5% (500)"), so the gateway caps here at startup to fail fast rather than at first quote.

**How the fee is collected**: 1CS deducts the fee from the swap via its `appFees` mechanism. The gateway includes `appFees: [{ recipient: OPERATOR_FEE_RECIPIENT, fee: OPERATOR_MARGIN_BPS }]` on every quote request. The buyer signs an EIP-3009 authorization for **exactly `amountIn`** — no inflation. 1CS then routes the swap such that:

1. The buyer's destination receives `amountOut` (the post-fee swap output).
2. `OPERATOR_FEE_RECIPIENT`'s NEAR Intents account is credited with the fee in the **origin asset's NEP-141 representation** (e.g. `nep141:base-...USDC.omft.near` for USDC on Base).

This is fundamentally different from the merchant-mode predecessor: there, the operator received funds at a wallet address; here, the operator's fee accrues on **NEAR Intents** as a 1CS internal credit, withdrawn out-of-band via 1CS (see "Collecting your operator fee" below).

**Required env var**: `OPERATOR_FEE_RECIPIENT` is required when `OPERATOR_MARGIN_BPS > 0`. Format: NEAR named account (`treasury.near`, `foo.tg`) or 64-char implicit hex. **EVM addresses are not Intents accounts** and are rejected at startup. The Zod validator in `src/infra/config.ts` cross-checks via `isValidNearAccount`.

**Picking a value**: typical bridge fees are 5–30 bps for stablecoin-to-stablecoin transfers, higher (50–100 bps) for volatile pairs or smaller chains. Your default is `30` (0.3%). Considerations:

- **Free service (`OPERATOR_MARGIN_BPS=0`)** is allowed — useful for ecosystem onboarding endpoints where the swap is loss-leader. The gateway then omits `appFees` from the 1CS quote entirely (no zero-fee artifact on the quote side), and the receipt shows `operatorFee.amount: "0"`. `OPERATOR_FEE_RECIPIENT` may be unset in this case.
- **Transparent**: the fee is surfaced in `extra.crossChain.operatorFee` on every 402 envelope and in the settlement receipt. Buyers see exactly what they're paying.
- **Service-level, not per-route**: with one route in the registry, this is moot. If you ever add a "fast" lane vs "cheap" lane, [src/http/protected-routes.ts](../src/http/protected-routes.ts)'s `pricing` field would need a per-route margin override (small refactor).

**Margin economics** are independent of slippage. Slippage is what 1CS reports as `swapDetails.slippage` post-settlement (the difference between the quoted `amountOut` and what was actually delivered). With EXACT_INPUT, slippage upside *and* downside lands on the buyer — your operator fee is fixed regardless (it's deducted by 1CS before the swap output is computed). See [SWAP_AS_RESOURCE.md § 5](../SWAP_AS_RESOURCE.md) for the full discussion.

---

## Collecting your operator fee

Your fee accrues on a **NEAR Intents account** (`OPERATOR_FEE_RECIPIENT`) in the origin asset's NEP-141 representation. For a gateway running with USDC-on-Base as the origin, that's `nep141:base-0x833589f...omft.near`. To turn that into spendable funds:

1. **Set up the NEAR Intents account.** Any NEAR named account (e.g. `treasury.near`, `foo.tg`) works. You don't need to pre-fund it — 1CS accrues the fee balance lazily as swaps land.

2. **Monitor the balance.** Use the 1Click Swap dashboard or query 1CS directly. There's no on-chain "balance" to read — the credit lives inside 1CS's internal ledger.

3. **Withdraw out-of-band via 1CS.** From your NEAR Intents account, initiate a swap from the accrued NEP-141 (e.g. USDC-on-Base) to wherever you want the funds (e.g. native USDC on NEAR, USDC on Arbitrum, or back to USDC on Base via OMFT bridging). This is exactly the same swap mechanic the gateway exposes to buyers — you're just the buyer this time, withdrawing from the Intents account directly using the [1Click dashboard or SDK](https://docs.near-intents.org/).

4. **Currency note**: the fee is denominated in the **origin** asset, not USD. If your gateway runs on Base USDC, your fee accrues as USDC-on-Base NEP-141 — a stablecoin claim, not a market-rate position. No daily P&L from the swap mechanism itself.

**Caveat**: if you misconfigure `OPERATOR_FEE_RECIPIENT` (e.g. typo, account doesn't exist), 1CS may reject the quote at request time — this surfaces as a 503 `QUOTE_UNAVAILABLE` and no swap happens. Verify the account exists by running a single dry quote against your live config before opening to traffic.

**For zero-fee deployments** (`OPERATOR_MARGIN_BPS=0`): nothing accrues, nothing to collect, `OPERATOR_FEE_RECIPIENT` may be unset.

---

## Refund flow

When a 1CS swap fails (`FAILED` or `REFUNDED` status), the buyer's deposited USDC needs to go *somewhere*. Two paths:

### Buyer supplied `refundAddress`

The gateway threads `swapInputs.refundAddress` into the 1CS quote as `refundTo`. 1CS automatically routes the refund to that address when a swap fails. **No operator action needed.** This is the path you should encourage buyers to use.

The receipt's `extra.crossChain.refundTo` echoes whichever address was used (buyer's or yours).

### Buyer omitted `refundAddress`

`refundTo` falls back to `cfg.gatewayRefundAddress` (your wallet). 1CS sends refunds there. **You then have to forward to the buyer manually**, using the `correlationId` from the failed settlement to identify which buyer was affected.

This is operationally painful, especially at scale. Mitigations:

- **Encourage buyers to supply `refundAddress`** — your USER_GUIDE links suggest this.
- **Build a refund tool** — a script that reads `state` records from the SQLite store, finds settlements with `phase: "FAILED"` and a non-zero refunded amount visible in `swapDetails.refundedAmount`, and forwards from `gatewayRefundAddress` to `state.signerAddress` (the buyer's recovered EVM address) on Base. Tracked as item #11 in [TODO.md](TODO.md).
- **Manual SLA**: publish a refund SLA (e.g. "refunds processed within 24h on business days; contact <support email> with your correlationId") in your ToS. Be honest about what you can guarantee.

### Failure modes that DON'T trigger a 1CS refund

If the 1CS swap times out from the gateway's perspective (`SwapTimeoutError`, 504) but eventually completes server-side at 1CS, funds reach the buyer's destination normally — the gateway just stopped polling before observing SUCCESS. The buyer can verify on-chain via the destination tx hash 1CS would emit. No refund needed.

If `transferWithAuthorization` succeeds on Base but 1CS never sees the deposit (network issue, deposit-notify failure, …), the buyer's funds are at the deposit address indefinitely. 1CS's deadline-based auto-refund eventually triggers (on the deadline), routing back to `refundTo`. This is rare but worth knowing.

---

## First boot

The gateway uses SQLite (in-memory by default; set `STORE_FILE_PATH` for persistence). On startup, `SqliteStateStore.init()` runs a **stale-DB fail-fast check** (D12 in [implementation_plan.md](../implementation_plan.md)):

- If the database file is empty or fresh, boot proceeds normally.
- If existing rows lack the `swapInputs` field, the file was written by the predecessor merchant-mode codebase. Boot is **refused** with:
  ```
  Stale state database: existing rows lack `swapInputs`. This file was written by
  the predecessor merchant-mode codebase. Delete <path> before booting the swap
  service. See docs/OPERATOR_GUIDE.md § 'First boot'.
  ```

**To recover**: `rm <STORE_FILE_PATH>` and restart. There's no migration path — this is a fresh deploy of a different product. The merchant-mode predecessor never had public users in this folder, so nothing of value is lost.

For a fresh deploy with no prior file, you don't need to do anything special.

---

## Operational checklist before going public

Before you point real buyers at the gateway:

1. **TLS / HTTPS** — the `PAYMENT-SIGNATURE` header carries an EIP-712 authorization. Plaintext HTTP is replayable. Terminate TLS at a reverse proxy (nginx, Caddy, Cloudflare) or self-host with `https`. **Blocker** — see [TODO #1](TODO.md).

2. **File-based state persistence** — the in-memory SQLite default loses every in-flight settlement on crash or deploy. **Set `STORE_FILE_PATH`** to a writable absolute path (e.g. `/var/lib/x402-swapper/state.db`). The store flushes every `STORE_SAVE_INTERVAL_MS` (default 30 s) AND on graceful shutdown. ✅ implemented — see `.env.example`. D12 stale-DB check refuses to boot if the file was written by the predecessor merchant-mode codebase (see "First boot" above).

3. **Graceful shutdown** — on SIGTERM/SIGINT the server stops accepting new connections, then waits up to `SHUTDOWN_GRACE_MS` (default 30 s) for `SettlementLimiter.current` to drop to 0 before tearing down the store and providers. Surviving settlements are recovered on next start. Align this with your orchestration's stop-grace (k8s `terminationGracePeriodSeconds`, systemd `TimeoutStopSec`). On clean drain → exit 0; on timeout → exit 1 (operators can alert off non-zero exits). ✅ implemented.

4. **Legal opinion** — see the regulatory section above. Don't skip this for a public deployment. **Blocker** — see [TODO #4](TODO.md).

5. **Facilitator wallet hardening** — see [docs/Facilitator_keys_guidance.md](Facilitator_keys_guidance.md). The facilitator key is your most sensitive secret.

6. **Funded facilitator** — needs ETH on Base for gas. The startup log shows the balance; warn-level if zero. Plan to top it up.

7. **JWT expiry monitoring** — the 1CS JWT has an expiry claim. The gateway doesn't check it at startup yet ([TODO #6](TODO.md)). Set a calendar reminder.

8. **MAX_AMOUNT_IN cap** — bound your quote-economics exposure. Without this, a single buyer can request a quote for an arbitrarily large swap; you don't pay anything until they sign, but the 1CS quote itself counts against your JWT rate limit. [TODO #8](TODO.md).

9. **Slippage tolerance** — currently hardcoded at 50 bps. If you want tighter (10) or looser (200), it's a one-line change pending the env-var lift in [TODO #9](TODO.md).

10. **Gateway authentication** — anyone with the URL can hit the 402 flow. Consider an `X-API-Key` middleware or IP allowlist. [TODO #10](TODO.md).

11. **Discovery** — for x402scan registration, set `PUBLIC_BASE_URL` and add `OWNERSHIP_PROOFS` (use `npx tsx scripts/generate-ownership-proof.ts`). The discovery surfaces (`/openapi.json`, `/.well-known/x402`) are already wired and tested.

12. **Health checks + metrics** — `/health` exposes in-flight settlement count, RPC pool state, and rate-limiter state. Hook a monitor up to it. Prometheus `/metrics` is on the roadmap ([TODO #14](TODO.md)).

---

## Monitoring what's actually happening

The gateway logs at every state transition. With the default `console.log`-style output, you'll see lines like:

```
[x402] 402 issued for /api/swap?... → deposit=0x..., amount=10000000
[x402] ▶ Broadcasting origin tx for 0x...
[x402] ✓ Origin tx broadcast for 0x...: tx=0x..., block=12345678
[x402] ✓ deposit-notify OK (status=KNOWN_DEPOSIT_TX, correlationId=corr-...) for 0x... (tx: 0x...)
[x402] ⏳ Polling 1CS status for 0x... (budget: 300s)...
[x402] ✅ Settled 0x... → 1CS status=SUCCESS, destChain=near
```

Errors carry an 8-character `correlationId` that's also returned to the buyer in the response body — when a buyer reports an issue, ask for the `correlationId` and grep your logs.

For production deployments, plan to migrate to structured logging (`pino`) — see [TODO #7](TODO.md).

---

## Reference

| Doc | Purpose |
|---|---|
| [README.md](../README.md) | Project overview + setup walkthrough |
| [docs/USER_GUIDE.md](USER_GUIDE.md) | Buyer-facing usage guide |
| [docs/TODO.md](TODO.md) | Production-readiness checklist with priorities |
| [docs/Facilitator_keys_guidance.md](Facilitator_keys_guidance.md) | Facilitator key management — read before using a real funded key |
| [docs/X402SCAN_PLAN.md](X402SCAN_PLAN.md) | x402scan integration design notes (historical, predates the swap-mode pivot) |
| [implementation_plan.md](../implementation_plan.md) | Swap-mode pivot execution log |
| [SWAP_AS_RESOURCE.md](../SWAP_AS_RESOURCE.md) | Original product brief — particularly §5 (slippage, refund) and §6 (regulation) |
