# Directory registration drafts — x402-swapper

> Working file for the 2026-06-10 registration round. Tunnel URL of the day:
> `https://lemon-pens-invite.loca.lt` (ephemeral — every URL-bound listing
> below dies with the tunnel; project-level listings survive).
>
> **Tunnel-stability tip discovered during this round**: localtunnel accepts
> `--subdomain lemon-pens-invite`, which lets us *reclaim the same URL* after
> a tunnel restart (verified working). Always start the tunnel with:
> `npx -y localtunnel --port 3402 --subdomain lemon-pens-invite`
> This makes the URL semi-stable — it survives restarts as long as no one
> else claims the name while we're down. Not a substitute for a real domain,
> but it keeps directory listings alive across tunnel hiccups.
>
> Delete this file or refresh its URLs whenever a new tunnel/domain goes live.

## Status board

| Directory | Mechanism | Status |
|---|---|---|
| 402index.io | API `POST /api/v1/register` | ✅ **Registered** — id `c3536bf2-1520-47af-8723-bb3173ca60ac`, status `pending` review, health `healthy`, x402 protocol verified |
| Satring | Browser form (satring.com/submit) | ⏳ operator action — values below |
| x402-index | GitHub issue | ⏳ operator action — draft below |
| NEAR Catalog | submit.nearcatalog.xyz (NEAR login) | ⏳ operator action — copy below |
| awesome-x402 | PR to Merit-Systems/awesome-x402 | ⏳ operator action — line below |

---

## 1. Satring form values (satring.com/submit)

| Field | Value |
|---|---|
| Service name | `x402-swapper` |
| URL | `https://lemon-pens-invite.loca.lt/api/swap?destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=test.near&amountIn=1000000` |
| Protocol | ☑ x402 (only) |
| Price (sats) | `0` (pricing is dynamic per 1CS quote; leave 0 or blank) |
| Model / pricing | dynamic |
| Description | x402-gated cross-chain swap service. Pay USDC on Base via one signed EIP-3009 authorization; receive any NEAR-Intents-1Click-supported asset on 32+ chains (NEAR, Solana, Arbitrum, Stellar, Bitcoin…) at a buyer-supplied address. Dynamic pricing via live 1CS quotes; settlement receipt with destination tx hashes in the PAYMENT-RESPONSE header. |
| Source / repo | (your GitHub repo URL) |

Submission is payment-gated (small x402/L402 fee paid at submit time from your wallet).

## 2. x402-index GitHub issue (github.com/x402-index/x402-discovery-index → New issue)

**Title**: `Register service: x402-swapper (cross-chain swap API, x402 on Base)`

**Body**:

```
**Endpoint URL**: https://lemon-pens-invite.loca.lt/api/swap?destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=test.near&amountIn=1000000

**Payment address (facilitator/broadcaster on Base)**: 0x8D53dc3Bb085a1C26F9f48F669394A3c2dd84983
(note: `accepts[0].payTo` rotates per-quote — it is a one-shot NEAR Intents 1Click deposit address)

**Protocol**: x402 v2 (PAYMENT-REQUIRED header transport, EVM `exact` scheme, USDC on Base eip155:8453)

**Discovery surfaces**:
- OpenAPI: https://lemon-pens-invite.loca.lt/openapi.json (x-payment-info, x-discovery.ownershipProofs)
- Well-known: https://lemon-pens-invite.loca.lt/.well-known/x402
- Runtime 402 carries extensions.bazaar.info.{inputSchema,outputSchema}

**Description**: x402-gated cross-chain swap service. Pay USDC on Base with one signed
EIP-3009 authorization; receive any NEAR-Intents-1Click-supported asset on 32+ chains
(NEAR, Solana, Arbitrum, Stellar, Bitcoin, …) at a buyer-supplied address. Dynamic
pricing via live 1CS quotes. Settlement receipt (destination tx hashes, slippage,
operator fee) returned in the PAYMENT-RESPONSE header.

Note: the URL is currently an ephemeral tunnel while we finalize permanent hosting —
happy to update the listing when the stable domain lands.
```

## 3. NEAR Catalog (submit.nearcatalog.xyz — NEAR account login, NEAR Intents category)

| Field | Value |
|---|---|
| Project name | x402-swapper |
| Category | NEAR Intents |
| One-liner | Cross-chain swaps as a paid HTTP endpoint — x402 payments routed through NEAR Intents 1Click. |
| Description | x402-swapper turns a cross-chain swap into a single paid HTTP request. A buyer (human or AI agent) GETs `/api/swap` with a destination asset + address, receives an HTTP 402 quote backed by NEAR Intents 1Click Swap, signs one EIP-3009 USDC authorization on Base, and receives the destination asset on any of 32+ chains (NEAR, Solana, Arbitrum, Stellar, Bitcoin…). No wallet-connect dance, no bridge UI, no operator custody — funds flow buyer → 1CS deposit → buyer's destination address. Discovery surfaces (OpenAPI + /.well-known/x402) make the service indexable by agentic-commerce directories. Built on the NEAR Intents 1Click API. |
| Links | GitHub repo (primary), demo URL omitted while hosting is ephemeral |

## 4. awesome-x402 PR (github.com/Merit-Systems/awesome-x402)

Add under the most fitting section (Services / Examples):

```markdown
- [x402-swapper](https://github.com/<your-org>/<your-repo>) — Cross-chain swap as a paid endpoint: pay USDC on Base via x402, receive any asset on 32+ chains through NEAR Intents 1Click. Single EIP-3009 signature, non-custodial, receipt in the PAYMENT-RESPONSE header.
```

(Replace the repo URL; the repo must be public for the PR to be accepted.)

---

## Optional follow-up — `.well-known` static verification files

Both 402index.io (`/.well-known/402index-verify.txt`) and Satring
(`/.well-known/satring-verify`) support HTTP-challenge domain verification
for instant approval / listing-edit credentials. We control the server, so
serving these is possible with a small gateway feature:

- New env `WELL_KNOWN_DIR` → serve static files from that directory under
  `/.well-known/` (mounted above the paid-route loop, like the discovery
  endpoints). ~15 LOC + test.
- Then: `curl -X POST https://402index.io/api/v1/claim -d '{"domain": "<tunnel-host>"}'`,
  write the returned hash into `$WELL_KNOWN_DIR/402index-verify.txt`, done.

Not implemented yet — worth doing when the stable domain lands (verification
of a tunnel domain dies with the tunnel anyway).
