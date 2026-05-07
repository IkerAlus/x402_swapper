# x402_swapper

**An x402-gated cross-chain swap service.** Buyers pay USDC on Base; the gateway routes funds via [NEAR Intents 1Click Swap](https://docs.near-intents.org) to any of 32+ destination chains (EVM, NEAR, Solana, Stellar, Bitcoin, …) at a buyer-supplied address. One signed EIP-3009 authorization per swap. No wallet-connect dance, no operator-side custody, x402-discoverable.

```
GET /api/swap?destinationChain=near&destinationAsset=...&destinationAddress=alice.near&amountIn=10000000
   │
   ▼ 402 + PAYMENT-REQUIRED  (deposit address + amount including operator margin)
   │
   ▼ buyer signs EIP-3009 authorization to the deposit address
   │
   ▼ retry with PAYMENT-SIGNATURE
   │
   ▼ gateway broadcasts on Base, polls 1CS, returns 200 + PAYMENT-RESPONSE
       (settlement receipt: destination tx hashes, slippage, operator fee, ...)
```

**Token flow:** `Buyer (USDC on Base) → 1CS Deposit Address → cross-chain swap → Buyer's destination address`

## ⚠️ WARNING ⚠️

This project is in alpha. See [docs/TODO.md](docs/TODO.md) for what's still missing for a live deployment — most importantly TLS, file-based persistence, graceful shutdown, and a regulatory review (this kind of service is, in many jurisdictions, a regulated money-transmission activity — see [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)).

This codebase pivoted from a single-merchant payment gateway to a swap-as-resource service on 2026-05-07. See [implementation_plan.md](implementation_plan.md) for the execution log and [SWAP_AS_RESOURCE.md](SWAP_AS_RESOURCE.md) for the original product brief.

---

## Project structure

```
x402_swapper/
├── src/
│   ├── server.ts                 # HTTP entry point
│   ├── index.ts                  # Library barrel export (no runtime side effects)
│   ├── types.ts                  # Shared types — SwapState, SwapRequestInput, errors
│   ├── e2e.test.ts               # HTTP protocol compliance tests
│   ├── live-1cs.test.ts          # Live 1CS API tests (gated by ONE_CLICK_JWT)
│   ├── server.test.ts            # CORS + helmet + discovery endpoint tests
│   ├── payment/                  # x402 payment pipeline
│   │   ├── quote-engine.ts       #   Validate inputs → 1CS quote → margin → x402 PaymentRequirements
│   │   ├── verifier.ts           #   EIP-3009 / Permit2 signature verification
│   │   ├── settler.ts            #   Broadcast + 1CS notify + status poll + receipt builder
│   │   └── chain-prefixes.ts     #   NEP-141 chain metadata + recipient helpers
│   ├── http/                     # Express wiring + discovery surfaces
│   │   ├── middleware.ts         #   x402 middleware (parse query → 402 / verify / settle)
│   │   ├── protected-routes.ts   #   Single-source registry — only GET /api/swap lives here
│   │   ├── swap-input.ts         #   Buyer query Zod validator + JSON Schema mirror
│   │   ├── discovery.ts          #   /.well-known/x402 document builder
│   │   ├── openapi.ts            #   /openapi.json document builder
│   │   ├── ownership-proof.ts    #   x402scan EIP-191 canonical message + helpers
│   │   └── cors-options.ts       #   CORS + helmet option builder
│   ├── storage/
│   │   └── store.ts              # SQLite + in-memory state store; D12 stale-DB fail-fast
│   ├── infra/                    # Runtime infrastructure
│   │   ├── config.ts             #   Zod-validated env config (no merchant fields)
│   │   ├── rate-limiter.ts       #   Per-IP quote limits, settlement cap, quote GC
│   │   └── provider-pool.ts      #   RPC provider rotation + failover
│   ├── client/                   # Buyer-side client library
│   │   ├── x402-client.ts        #   X402Client (requestResource / submitPayment / payAndFetch)
│   │   ├── signer.ts             #   EIP-3009 & Permit2 signing
│   │   └── types.ts              #   Client-side type definitions
│   └── mocks/                    # Test fixtures (barrel-exported via mocks/index.ts)
├── scripts/
│   ├── test-client.ts                   # CLI test client (dry-run / live, env-driven)
│   ├── verify-api-key.ts                # 1CS JWT verification
│   ├── generate-ownership-proof.ts      # x402scan ownership-proof signer CLI
│   └── test-1cs-quote.sh                # Shell script for raw quote testing
├── docs/
│   ├── TODO.md                       # Production-readiness checklist
│   ├── USER_GUIDE.md                 # Buyer-facing usage guide
│   ├── OPERATOR_GUIDE.md             # Operator regulatory + ops guide
│   ├── Facilitator_keys_guidance.md  # Facilitator wallet key management
│   └── X402SCAN_PLAN.md              # x402scan integration design notes (historical)
├── .env.example                      # Environment variable template
├── .env.swap.example                 # Pre-filled config example with buyer query notes
├── implementation_plan.md            # Swap-mode pivot execution log
├── SWAP_AS_RESOURCE.md               # Original product brief
├── CLAUDE.local.md                   # AI agent onboarding guide
└── package.json
```

Tests live next to their source (`src/payment/quote-engine.test.ts`, `src/http/middleware.test.ts`, etc.); `e2e.test.ts` and `live-1cs.test.ts` are system-level by design.

---

## Prerequisites

- **Node.js >= 20** and npm
- **A 1CS JWT token** — request one at https://docs.near-intents.org (needed for non-dry quotes)
- For full payment testing:
  - A **buyer wallet** funded with USDC on Base
  - A **facilitator wallet** funded with ETH on Base (for gas — see [docs/Facilitator_keys_guidance.md](docs/Facilitator_keys_guidance.md))

## 1. Install

```bash
npm install
```

If you hit the `@rollup/rollup-darwin-arm64` error:

```bash
npm install @rollup/rollup-darwin-arm64 --save-optional
```

## 2. Configure environment

```bash
cp .env.example .env
# Or for a pre-annotated swap-service template:
cp .env.swap.example .env
```

### Required fields

| Field | Format | Example |
|-------|--------|---------|
| `ONE_CLICK_JWT` | JWT string | `eyJhbGciOiJS...` |
| `ORIGIN_NETWORK` | CAIP-2 string | `eip155:8453` |
| `ORIGIN_ASSET_IN` | NEP-141 asset ID | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |
| `ORIGIN_TOKEN_ADDRESS` | EVM address | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `ORIGIN_RPC_URLS` | Comma-separated URLs | `https://mainnet.base.org,https://base.drpc.org` |
| `FACILITATOR_PRIVATE_KEY` | EVM private key (0x + 64 hex) | `0x59c6995e...` |
| `GATEWAY_REFUND_ADDRESS` | EVM address | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

There are **no merchant-side fields** — buyers supply destination per-request as query params.

### Optional fields (defaults shown)

| Field | Default | Notes |
|-------|---------|-------|
| `OPERATOR_MARGIN_BPS` | `30` (0.3%) | Margin added on top of the 1CS quote. Range `0`–`1000`. Surfaced in `extra.crossChain.operatorFee`. |
| `ALLOWED_ORIGINS` | unset (reflect any) | CORS allowlist for browser clients |
| `PUBLIC_BASE_URL` | unset | Required before registering on x402scan |
| `OWNERSHIP_PROOFS` | empty | Comma-separated EIP-191 proofs (use `npx tsx scripts/generate-ownership-proof.ts`) |

All other tuning knobs (rate limits, poll intervals, token metadata) have safe defaults — see `.env.example` for the full annotated list.

### Critical note: asset ID format

The 1CS API uses `nep141:` prefixed asset IDs:

```
nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near    # USDC on Base (origin)
nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near     # USDC on Arbitrum (destination example)
nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1  # USDC on NEAR (implicit account)
```

The old `base:0x...` and `near:nUSDC` short forms are **not accepted**. Verify by calling `GET https://1click.chaindefuser.com/v0/tokens` or running `./scripts/test-1cs-quote.sh`.

### Critical note: TOKEN_NAME

The EIP-712 domain name for USDC on Base is `"USD Coin"`, **not** `"USDC"`. If this is wrong, signature verification fails. Verify with Foundry's `cast`:

```bash
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)" --rpc-url https://mainnet.base.org
# Returns: "USD Coin"
```

## 3. Verify your API key

```bash
ONE_CLICK_JWT="your-jwt" npm run verify-key
```

Sends a dry quote, a real quote, and a status request. Exits with code 0 on success.

## 4. Start the gateway

```bash
npx env-cmd npx tsx src/server.ts
```

(`env-cmd` handles env vars with spaces like `TOKEN_NAME=USD Coin` correctly.)

You should see:

```
[x402-1CS] Loading configuration...
[x402-1CS] Config OK — network=eip155:8453, originAsset=nep141:base-0x833589f..., operatorMarginBps=30
[x402-1CS] State store initialized (SQLite in-memory)
[x402-1CS] Provider pool ready — 1 RPC endpoint(s)
[x402-1CS] Facilitator wallet: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
[x402-1CS] Rate limiting — 20 quotes/60000ms per IP, 10 max concurrent settlements
[x402-1CS] CORS: open (reflect any origin); helmet: enabled
[x402-1CS] Discovery — /.well-known/x402 (...), /openapi.json (OpenAPI 3.1)
[x402-1CS] Mounted 1 protected route(s): GET /api/swap

═══════════════════════════════════════════════════════
  x402-1CS Gateway running on http://localhost:3402

  Endpoints:
    GET /health                — health check (no payment)
    GET /openapi.json          — OpenAPI 3.1 spec (discovery)
    GET /.well-known/x402      — x402 resource manifest (discovery)
    GET /api/swap              — Cross-chain swap (x402)

  To test the 402 flow:
    curl -i http://localhost:3402/api/swap?destinationChain=near&destinationAsset=nep141:...&destinationAddress=alice.near&amountIn=10000000
═══════════════════════════════════════════════════════
```

If env vars are missing or malformed, the gateway exits with a Zod validation error listing exactly which field failed. **First boot only**: if you have a `state.db` file from a previous merchant-mode deploy, the D12 stale-DB fail-fast will refuse to boot — delete the file and start fresh.

## 5. Try the 402 flow

### Quick check with curl

```bash
# Empty query → 400 INVALID_INPUT (Zod validator catches missing fields)
curl -i http://localhost:3402/api/swap

# Valid query → 402 + PAYMENT-REQUIRED header
curl -i 'http://localhost:3402/api/swap?destinationChain=near&destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=alice.near&amountIn=10000000'
```

The 402 response carries a base64-encoded `PAYMENT-REQUIRED` header. Decode it to see the deposit address, the amount (including the operator margin), and the `extra.crossChain` metadata block (quote ID, expected destination amount, refund target, operator fee breakdown).

### End-to-end with the test client

```bash
# Dry run (no real payment, no funds needed) — prints the 402 envelope and stops
npx tsx scripts/test-client.ts

# Real payment (requires a funded buyer wallet)
DRY_RUN=false BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts

# Custom destination
SWAP_DESTINATION_CHAIN=arbitrum \
SWAP_DESTINATION_ASSET=nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near \
SWAP_DESTINATION_ADDRESS=0xYourArbAddress \
SWAP_AMOUNT_IN=10000000 \
DRY_RUN=false BUYER_PRIVATE_KEY=0x... \
npx tsx scripts/test-client.ts
```

The test client decodes the `PAYMENT-RESPONSE` header on success and prints the swap receipt: origin tx hash, destination tx hashes (with explorer URLs), realized slippage, operator fee, and the 1CS correlation ID.

## 6. Run the test suite

```bash
# Mocked tests (~375 tests, no API key needed) — finishes in ~2s
npm test

# Live 1CS API tests (10 tests, gated by ONE_CLICK_JWT)
ONE_CLICK_JWT="your-jwt" npm run test:live

# Type check
npm run typecheck

# Lint
npm run lint
```

---

## Buyer query format

The buyer sends `GET /api/swap?...` with five fields:

| Param | Required | Format | Meaning |
|---|---|---|---|
| `destinationChain` | yes | lowercase chain prefix (`near`, `arbitrum`, `solana`, …) | Display label echoed in the receipt |
| `destinationAsset` | yes | `nep141:...` (1CS NEP-141 asset ID) | What the buyer wants to receive |
| `destinationAddress` | yes | chain-specific (NEAR account, EVM `0x…`, Stellar `G…`, etc.) | Where to send it |
| `amountIn` | yes | digit-only positive integer (smallest unit) | What the buyer pays in `ORIGIN_ASSET_IN` |
| `refundAddress` | no | EVM address | Refund target if 1CS swap fails. Defaults to `cfg.gatewayRefundAddress` |

**Validation runs in two layers:**
1. **Zod schema** ([src/http/swap-input.ts](src/http/swap-input.ts)) — structural shape, regex patterns. Failures → `400 INVALID_INPUT` with field-level details.
2. **Chain-format cross-check** (`validateBuyerDestination` in [src/payment/quote-engine.ts](src/payment/quote-engine.ts)) — e.g. EVM-format `destinationAddress` is rejected for a NEAR-native `destinationAsset`. Failures → `400 INVALID_INPUT` with structured `reasons[]`.

Unknown chain prefixes pass through (1CS may know chains we don't); the destination-format check skips when it can't resolve the chain.

## Destination chain examples

The buyer can target **any of the 32+ chains supported by the 1CS API** (see https://docs.near-intents.org/resources/asset-support). Some common ones:

| Chain | `destinationChain` | `destinationAsset` | `destinationAddress` format |
|-------|-------------------|---------------------|----------------------------|
| **NEAR** | `near` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | NEAR account (`alice.near`) or 64-char hex |
| **Arbitrum** | `arbitrum` | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | EVM `0x...` |
| **Ethereum** | `ethereum` | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` | EVM `0x...` |
| **Polygon** | `polygon` | `nep141:polygon-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omft.near` | EVM `0x...` |
| **Optimism** | `optimism` | `nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85.omft.near` | EVM `0x...` |
| **Solana** | `solana` | `nep141:solana-...omft.near` | Solana public key |
| **Stellar** | `stellar` | `nep141:stellar-...omft.near` | Stellar `G...` (must have a USDC trustline) |
| **Bitcoin** | `bitcoin` | `nep141:bitcoin-...omft.near` | Bitcoin address |

---

## Settlement receipt (in the PAYMENT-RESPONSE header)

The 200 response body is `{}`. The swap receipt is carried on the `PAYMENT-RESPONSE` header's `extensions.crossChain` field — this is x402's standardized extensibility hook (see [D14 in implementation_plan.md](implementation_plan.md#d14-hard-cutover-for-the-sqlite-database) for the design rationale). Any conforming x402 client / indexer / explorer can read it without route-specific knowledge.

```json
{
  "settlementType": "crosschain-1cs",
  "destinationTxHashes": [{"hash": "...", "explorerUrl": "https://nearblocks.io/txns/..."}],
  "destinationChain": "near",
  "destinationRecipient": "alice.near",
  "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "destinationAmount": "9985000",
  "destinationAmountFormatted": "9.985",
  "destinationAmountUsd": "9.99",
  "slippage": 0.0015,
  "operatorFee": {"bps": 30, "amount": "30000", "currency": "USDC"},
  "swapStatus": "SUCCESS",
  "correlationId": "corr-..."
}
```

The OpenAPI doc advertises this shape at `components.schemas.CrossChainSettlementExtra`.

## Discovery surfaces (for x402scan and indexers)

The gateway serves three discovery endpoints, all unauthenticated and rate-limit-exempt:

```
GET /openapi.json         — OpenAPI 3.1 with x-payment-info, x-discovery, x-crosschain
GET /.well-known/x402     — Fan-out resource list + ownership proofs
GET /health               — Operator-facing health check (in-flight settlements, RPC status)
```

To register on [x402scan](https://www.x402scan.com/), set `PUBLIC_BASE_URL` and add ownership proofs (see [scripts/generate-ownership-proof.ts](scripts/generate-ownership-proof.ts)). Detailed integration notes: [docs/X402SCAN_PLAN.md](docs/X402SCAN_PLAN.md) (historical, predates the swap-mode pivot — the *integration shape* is unchanged but example payloads reference the merchant predecessor).

---

## Who would run this?

(See [SWAP_AS_RESOURCE.md § 3](SWAP_AS_RESOURCE.md) for the full discussion. Summary:)

- **NEAR-ecosystem onboarding endpoints** — wrap a `GET /onramp?chain=near&asset=USDC&recipient=alice.near&amount=10` around this and EVM-resident users get NEAR-native USDC in ~30 seconds with one signed authorization. No bridge UI.
- **Agentic infrastructure** — agents transacting cross-chain make one HTTP call instead of scripting a bridge.
- **Game / dApp economy operators** — players need destination-chain assets to play; one paid endpoint replaces a bridge integration.
- **Wallet / SDK providers** — "one-click cross-chain top-up" inside the wallet UI.
- **Generic "swap-as-an-API" service** — public x402-gated swap utility (with the regulatory caveats in [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)).

The differentiation versus existing bridges (LiFi / Across / Stargate / etc.) is: **single signed authorization, no wallet-connect dance, no operator-side custody during swap, x402-discoverable, no bilateral integration**. Worth most when the consumer is an agent or a script.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Buyer-facing usage guide — full curl walkthrough, error decoding, receipt parsing |
| [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) | Operator-facing — regulatory considerations, KYC/sanctions/geofencing, refund flow, margin guidance, first boot |
| [docs/Facilitator_keys_guidance.md](docs/Facilitator_keys_guidance.md) | Facilitator wallet key management |
| [docs/TODO.md](docs/TODO.md) | Production-readiness checklist with priorities |
| [docs/X402SCAN_PLAN.md](docs/X402SCAN_PLAN.md) | x402scan integration design notes (historical) |
| [implementation_plan.md](implementation_plan.md) | Swap-mode pivot execution log |
| [SWAP_AS_RESOURCE.md](SWAP_AS_RESOURCE.md) | Original product brief |
| [CLAUDE.local.md](CLAUDE.local.md) | AI agent onboarding guide (file map, design patterns, invariants) |

---

## License

MIT.
