# x402-1CS Swap Service — Buyer Guide

This guide is for anyone with an EVM wallet (MetaMask, Rabby, a CLI signer, or any ethers.js-compatible private key) who wants to use the swap service to move USDC on Base into another asset on another chain. It covers what you need, how the protocol works, and the exact steps for paying.

---

## What is this?

An HTTP service where you GET `/api/swap?...` with the destination you want, sign one EIP-3009 authorization, and the gateway routes USDC on Base through [NEAR Intents 1Click Swap](https://docs.near-intents.org) to your chosen destination chain (any of 32+ — EVM chains, NEAR, Solana, Stellar, Bitcoin, …) at the address you specified.

**You never need to interact with the destination chain to pay.** You sign one EIP-712 message on Base, the gateway broadcasts it on your behalf (paying gas), 1CS handles the cross-chain routing, and you receive the destination asset at your address.

The payment protocol is **x402** (version 2), an extension of the HTTP `402 Payment Required` status code. It uses standard HTTP headers and EIP-712 typed-data signatures, so it works with any EVM wallet that can sign structured data.

---

## Requirements

**1. An EVM wallet on Base (chain ID 8453)**

Any wallet that can sign EIP-712 typed data: MetaMask, Rabby, Coinbase Wallet, or a private key in code. You need the private key if you're using the CLI test client or the `X402Client` library directly.

**2. USDC on Base** (the origin asset)

The gateway accepts USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on the Base L2. You need enough USDC to cover your `amountIn` plus the operator's margin (typically 30 bps = 0.3%). For example, paying `10000000` (10 USDC) at `OPERATOR_MARGIN_BPS=30` requires you to authorize `10030000` (10.03 USDC).

How to get USDC on Base:
- Bridge from Ethereum mainnet via [bridge.base.org](https://bridge.base.org)
- Withdraw from a centralized exchange that supports Base (Coinbase, Binance, …)
- Swap on a Base DEX (Aerodrome, Uniswap on Base)

**3. ETH on Base — NOT required for paying**

The gateway's facilitator wallet pays gas on your behalf when broadcasting your signed authorization. You only need ETH if you want to do other on-chain operations (check balance, manually call the token contract, etc.).

---

## How the protocol works

Four steps. Understanding them helps you debug any issues.

### Step 1 — Request a quote (no payment)

You send a GET to `/api/swap` with your destination as query parameters. The gateway calls 1CS for a quote and responds with **402 Payment Required**:

```
GET /api/swap?destinationChain=near&destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=alice.near&amountIn=10000000 HTTP/1.1
Host: gateway.example.com

→ 402 Payment Required
→ PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbi...  (base64-encoded JSON)
→ X-RateLimit-Limit: 20
→ X-RateLimit-Remaining: 19
```

#### Required query parameters

| Param | Format | Meaning |
|---|---|---|
| `destinationChain` | lowercase prefix (`near`, `arbitrum`, `solana`, …) | Display label echoed in the receipt |
| `destinationAsset` | `nep141:...` (1CS NEP-141 asset ID) | What you want to receive |
| `destinationAddress` | chain-specific (NEAR account, EVM `0x…`, Stellar `G…`, etc.) | Where to send it |
| `amountIn` | digit-only positive integer (smallest unit) | What you pay in USDC on Base |

#### Optional query parameter

| Param | Format | Meaning |
|---|---|---|
| `refundAddress` | EVM address (`0x` + 40 hex) | Where to send refunds if 1CS fails to route. Defaults to the gateway's wallet (operator forwards manually). **Strongly recommended to supply your own.** |

#### What gets validated, when

If you forget a field or send an invalid value, the gateway returns a **400 INVALID_INPUT** with structured per-field details — *before* contacting 1CS. Two layers of validation:

1. **Zod schema** — required fields, regex patterns (e.g. `amountIn` must be `^[1-9]\d*$`).
2. **Chain-format cross-check** — e.g. an EVM-format `destinationAddress` is rejected for a NEAR-native `destinationAsset`.

```bash
$ curl 'http://localhost:3402/api/swap'
{
  "error": "INVALID_INPUT",
  "message": "Request input failed validation.",
  "details": [
    { "path": "destinationChain", "message": "Required" },
    { "path": "destinationAsset", "message": "Required" },
    { "path": "destinationAddress", "message": "Required" },
    { "path": "amountIn", "message": "Required" }
  ],
  "correlationId": "a1b2c3d4"
}
```

Unknown chain prefixes (e.g. a chain 1CS supports but the gateway doesn't yet recognise) are passed through to 1CS rather than rejected — that's deliberate.

### Step 2 — Decode the 402 envelope

The `PAYMENT-REQUIRED` header is a base64-encoded JSON envelope:

```json
{
  "x402Version": 2,
  "resource": { "url": "/api/swap?destinationChain=near&...", "description": "x402-1CS swap service" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "10030000",
      "payTo": "0x7a16fF8270133F063aAb6C9977183D9e72835428",
      "maxTimeoutSeconds": 86370,
      "extra": {
        "name": "USD Coin",
        "version": "2",
        "assetTransferMethod": "eip3009",
        "crossChain": {
          "protocol": "1cs",
          "quoteId": "corr-a1b2c3d4-...",
          "destinationRecipient": "alice.near",
          "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
          "amountOut": "9985000",
          "amountOutFormatted": "9.985",
          "amountOutUsd": "9.99",
          "amountInUsd": "10.03",
          "refundTo": "0x...",
          "operatorFee": { "bps": 30, "amount": "30000", "currency": "USDC" }
        }
      }
    }
  ]
}
```

#### Fields you'll use to sign

- **`amount`** — exactly what you authorize, in the token's smallest unit. **This is your `amountIn` plus the operator margin** (30 bps default).
- **`payTo`** — the unique 1CS deposit address generated for *this* quote. Funds you authorize will go here on Base; 1CS detects the deposit and routes them cross-chain.
- **`network`** — CAIP-2 chain ID (`eip155:8453` = Base mainnet).
- **`asset`** — the ERC-20 token contract (USDC on Base).
- **`extra.name` / `extra.version`** — EIP-712 domain parameters for the token (`"USD Coin"` and `"2"` for USDC on Base — must match exactly).
- **`extra.assetTransferMethod`** — `"eip3009"` (default, gasless) or `"permit2"` (requires a one-time on-chain approval to Permit2).
- **`maxTimeoutSeconds`** — how long the authorization stays valid.

#### Fields for buyer-facing UX (the `extra.crossChain` block)

The gateway carries the underlying 1CS quote metadata at `accepts[0].extra.crossChain` — purely informational, **never used for signing**. Your client can ignore it, or surface a richer summary:

```ts
const cross = accepted.extra.crossChain as
  | {
      protocol: "1cs";
      quoteId: string;                     // 1CS correlation ID — quote when contacting support
      destinationRecipient: string;        // your destination address (echoed)
      destinationAsset: string;            // the asset you'll receive
      amountOut: string;                   // expected destination amount (smallest unit)
      amountOutFormatted: string;          // human-readable (e.g. "9.985")
      amountOutUsd: string;                // USD value of what you'll receive
      amountInUsd: string;                 // USD value of what you'll pay (incl. margin)
      refundFee?: string;                  // optional — chain-dependent
      refundTo: string;                    // your refundAddress, or the gateway fallback
      depositMemo?: string;                // optional — required by Stellar/XRP/Cosmos
      operatorFee: { bps: number; amount: string; currency: "USDC" };
    }
  | undefined;

if (cross?.protocol === "1cs") {
  console.log(
    `Paying $${cross.amountInUsd} → ${cross.amountOutFormatted} ${cross.destinationAsset.split(':')[1]} ` +
    `(operator fee: ${cross.operatorFee.amount} ${cross.operatorFee.currency} = ${cross.operatorFee.bps}bps). ` +
    `Refunds → ${cross.refundTo}`,
  );
}
```

The full JSON schema is published at `/openapi.json#/components/schemas/CrossChainQuoteExtra` if you want a machine-readable contract.

### Step 3 — Sign the payment

Pick the entry from `accepts` (there's currently one) and sign an EIP-712 typed-data message authorizing the transfer.

For **EIP-3009 (gasless, default)**:

```
Domain:
  name:              "USD Coin"           ← from extra.name
  version:           "2"                  ← from extra.version
  chainId:           8453                 ← from network (eip155:8453)
  verifyingContract: 0x833589f...         ← from asset

Message (TransferWithAuthorization):
  from:        your wallet address
  to:          the payTo address          ← the 1CS deposit address
  value:       the amount                 ← amountIn + operator margin
  validAfter:  0                          ← immediately valid
  validBefore: now + maxTimeoutSeconds    ← expiration (unix seconds)
  nonce:       random 32-byte hex         ← unique per authorization
```

Then construct the `PAYMENT-SIGNATURE` payload:

```json
{
  "x402Version": 2,
  "resource": { "url": "/api/swap?destinationChain=near&..." },
  "accepted": { "...the accepted payment option from step 2..." },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0xYourAddress",
      "to": "0x7a16fF82...",
      "value": "10030000",
      "validAfter": "0",
      "validBefore": "1762800000",
      "nonce": "0x..."
    }
  }
}
```

For **Permit2**, you need a prior `approve()` to the Permit2 contract. The signing message structure differs — see [src/client/signer.ts](../src/client/signer.ts) `signPermit2` for the exact shape.

### Step 4 — Submit the signed payment

Retry the same GET request with the same query string AND the `PAYMENT-SIGNATURE` header (base64-encoded):

```
GET /api/swap?destinationChain=near&...  HTTP/1.1
Host: gateway.example.com
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbi...

→ 200 OK
→ PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVl...
→ {}
```

This step blocks while the gateway:

1. Verifies your signature and on-chain USDC balance
2. Broadcasts `transferWithAuthorization` on Base (the facilitator pays gas)
3. Notifies 1CS of the deposit
4. Polls 1CS until the cross-chain swap completes (~30–60 seconds)

**The 200 body is `{}` by design.** The settlement receipt is in the `PAYMENT-RESPONSE` header.

#### The receipt

The `PAYMENT-RESPONSE` header is a base64-encoded JSON `SettleResponse`. The swap-specific fields live in `extensions.crossChain` (a `CrossChainSettlementExtra`):

```json
{
  "success": true,
  "payer": "0xYourAddress",
  "transaction": "0xBaseTxHash...",
  "network": "eip155:8453",
  "amount": "10030000",
  "extensions": {
    "crossChain": {
      "settlementType": "crosschain-1cs",
      "destinationTxHashes": [
        { "hash": "9XzKqRu...", "explorerUrl": "https://nearblocks.io/txns/9XzKqRu..." }
      ],
      "destinationChain": "near",
      "destinationRecipient": "alice.near",
      "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "destinationAmount": "9985000",
      "destinationAmountFormatted": "9.985",
      "destinationAmountUsd": "9.99",
      "slippage": 0.0015,
      "operatorFee": { "bps": 30, "amount": "30000", "currency": "USDC" },
      "swapStatus": "SUCCESS",
      "correlationId": "corr-a1b2c3d4-..."
    }
  }
}
```

This is the on-the-wire contract — published as `components.schemas.CrossChainSettlementExtra` in `/openapi.json`. It's the standardized x402 way to carry protocol-specific settlement metadata; any conforming x402 client / indexer / explorer can consume it without route-specific knowledge.

---

## Easiest method: use the X402Client library

The repository ships a TypeScript client (`src/client/`) that handles the entire flow:

```ts
import { ethers } from "ethers";
import { X402Client } from "./src/client/index.js";

const wallet = new ethers.Wallet("0xYourBuyerPrivateKey");
const client = new X402Client({ gatewayUrl: "http://localhost:3402" });

const result = await client.payAndFetch(wallet, "/api/swap", {
  query: {
    destinationChain: "near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    destinationAddress: "alice.near",
    amountIn: "10000000",
    // refundAddress: "0xYourEvmRefundAddress",  // optional but recommended
  },
});

if (result.success) {
  // Body is `{}` by design — receipt is in result.paymentResponse.extensions.crossChain
  const receipt = result.paymentResponse?.extensions?.crossChain;
  console.log(`Origin tx:      ${result.paymentResponse?.transaction}`);
  console.log(`Destination tx: ${receipt?.destinationTxHashes?.[0]?.hash}`);
  console.log(`Slippage:       ${receipt?.slippage}`);
  console.log(`Operator fee:   ${receipt?.operatorFee?.amount} ${receipt?.operatorFee?.currency}`);
} else {
  console.log(`Failed (status ${result.status}): ${result.error}`);
}
```

The client handles all four protocol steps internally (request → decode → sign → submit). The `query` option is sent on both the initial 402 request AND the signed retry, so the URL is stable across the round-trip.

---

## CLI test client

The repository includes `scripts/test-client.ts` for manual end-to-end testing.

```bash
# Dry run — no funds needed, prints the 402 envelope and stops
npx tsx scripts/test-client.ts

# Custom destination via env vars
SWAP_DESTINATION_CHAIN=arbitrum \
SWAP_DESTINATION_ASSET=nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near \
SWAP_DESTINATION_ADDRESS=0xYourArbAddress \
SWAP_AMOUNT_IN=10000000 \
npx tsx scripts/test-client.ts

# Real payment (requires funded buyer wallet on the origin chain)
DRY_RUN=false BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts
```

The script prints each step: 402 envelope, signed payload, settlement response (decoded). On success it pretty-prints the receipt — origin/destination tx hashes, slippage, operator fee, correlation ID.

---

## Errors you might see

| Status | error code | What happened | What to do |
|---|---|---|---|
| `400` | `INVALID_INPUT` | Your query failed Zod validation OR `validateBuyerDestination` chain-format check | Read `details[].path` + `message` and fix the field |
| `402` | (with PAYMENT-REQUIRED) | Either no signature was sent, or the signature was rejected (signer mismatch, balance too low, signed wrong amount, etc.) | Check the `error` field on the 402 envelope, sign again |
| `409` | `NONCE_ALREADY_USED` | Reusing an EIP-3009 nonce that was already broadcast | Generate a fresh random nonce and re-sign |
| `429` | `RATE_LIMITED` | You hit the per-IP quote rate limit | Back off; check `Retry-After` header |
| `502` | `SWAP_FAILED` | 1CS reported `FAILED` or `REFUNDED` after your transfer landed | Check `correlationId`, contact the gateway operator. Refund handling depends on whether you supplied `refundAddress` (1CS routes refunds to it automatically when supplied) |
| `503` | `QUOTE_UNAVAILABLE` / `AUTHENTICATION_ERROR` / `SERVICE_UNAVAILABLE` / `DEADLINE_TOO_SHORT` / `INSUFFICIENT_GAS` | Upstream issue at 1CS, JWT, or facilitator gas | Try again shortly. Persistent → contact the operator with the correlation ID |
| `504` | `SWAP_TIMEOUT` | 1CS polling exceeded the gateway's max poll time mid-settlement | Your transfer may still complete on-chain. Contact the operator with the correlation ID |

Every error response carries a short `correlationId` (8 hex chars). Quote it when reporting issues — operators can grep server logs for the full context.

---

## Refund flow

If 1CS fails to complete your swap:
- **If you supplied `refundAddress`** (recommended): 1CS sends the refund directly to your EVM address on Base — no operator action needed. This is set as `refundTo` on the 1CS quote at the time you signed.
- **If you omitted `refundAddress`**: 1CS sends the refund to the gateway's wallet (`GATEWAY_REFUND_ADDRESS`). The operator then has to forward it to you manually using the `correlationId` to identify your settlement. The gateway has no automated path here yet — it's tracked as item #11 in [docs/TODO.md](TODO.md).

**Always supply `refundAddress` when you can.** It's a one-line change in your client and removes a manual operator step on failure.

---

## Reference

| Doc | Purpose |
|---|---|
| [README.md](../README.md) | Project overview, setup, gateway operator quickstart |
| [docs/OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) | Operator-facing — regulatory, KYC/sanctions, refund flow, margin guidance |
| [docs/TODO.md](TODO.md) | Production-readiness checklist |
| [implementation_plan.md](../implementation_plan.md) | Swap-mode pivot execution log |
| [SWAP_AS_RESOURCE.md](../SWAP_AS_RESOURCE.md) | Original product brief — explains *why* this exists |

The `/openapi.json` and `/.well-known/x402` endpoints expose machine-readable schemas for both the 402 envelope and the receipt, suitable for automated discovery (x402scan, agent SDKs).
