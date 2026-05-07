# Swap-as-Resource — Implementation Plan

> **Status: Drafted — 2026-05-07.** Plan for converting the x402-1CS gateway from a single-merchant payment rail into a **dedicated cross-chain swap service**. This is a *replacement* of the merchant flow, not an addition: there is no `/api/premium`, no `MERCHANT_*` env vars, and no merchant-mode code path after this lands.

**Source brainstorm:** [SWAP_AS_RESOURCE.md](SWAP_AS_RESOURCE.md) — read for product motivation, the EXACT_INPUT vs EXACT_OUTPUT analysis, slippage UX, refund-flow trade-offs, and the regulatory caveat in §6.

---

## Context

The codebase in this directory was copied from a sibling project where it served a different use case (the operator pre-configured a merchant destination at boot; every paid request settled to that merchant; the "resource" was content the route handler returned). For *this* deployment, the use case changes:

- The deploy **is** a paid swap service — that's its only product.
- The buyer's request carries the swap parameters (`destinationChain`, `destinationAsset`, `destinationAddress`, `amountIn`, `refundAddress`).
- The gateway calls 1CS with `swapType: EXACT_INPUT` (so slippage upside accrues to the buyer).
- The funds land at the **buyer's** address on the destination chain.
- The operator's revenue is a transparent margin (basis points) on top of the 1CS quote, surfaced in `extra.crossChain.operatorFee`.
- The 200 response body is a **real swap receipt** (origin tx hash, destination tx hash, observed rate, fees, slippage actually paid).

The architectural wins from the previous design (state machine, settler, verifier, x402 surfaces, recovery, ownership proofs, discovery) are reused verbatim — those layers are destination-agnostic. The merchant-specific code paths (config fields, quote-engine call shape, premium handler, fixed/dynamic pricing union) are **deleted**, not preserved alongside swap mode. Single-product service, single code path, simpler invariants.

---

## Goals & Non-goals

**Goals**
- Delete merchant-mode code paths entirely. No `/api/premium`, no `MERCHANT_*` env vars, no `FixedPricing`/`DynamicPricing` types, no `buildPremiumHandler`.
- Add a single `/api/swap` route as the deploy's only paid resource. The route accepts buyer-supplied destination parameters per-request.
- Use **EXACT_INPUT** for 1CS quotes so slippage upside lands on the buyer.
- Per-request buyer-supplied refund address (with `gatewayRefundAddress` as graceful fallback if buyer omits it).
- Operator margin in basis points (configurable via `OPERATOR_MARGIN_BPS` env var), transparently surfaced in `extra.crossChain.operatorFee`.
- Real swap receipt as 200 response body, built from data the settler already collects.
- Make `inputSchema` load-bearing — runtime Zod validation of buyer-supplied fields, with structured 400s on failure.
- Reuse `diagnoseQuoteRequest` from the existing codebase to validate buyer-supplied addresses against the chain prefix at request time (one place for `0x` vs NEAR vs Solana vs Stellar vs Bitcoin format rules).
- Rewrite affected tests; delete merchant-mode tests outright.
- Rewrite affected docs; reposition the project as a swap service (README, USER_GUIDE, .env.example, CLAUDE.local.md).

**Non-goals (explicitly deferred)**
- **Multi-origin support** (buyer choosing origin chain/asset). Stays single-origin per deploy; the `ORIGIN_*` env vars still anchor the buyer's pay side. Adds 3–5 days and is a separate plan.
- **Automated buyer refunds.** We surface `refundTo` to 1CS; if 1CS-side automatic refund-to-buyer fires, great. If a deeper failure leaves funds at the gateway address, the operator forwards manually. A fully automated refund flow is a separate plan.
- **KYC / sanctions screening / geofencing.** Deployment-time concern, documented in a new operator guide. Not built into the codebase.
- **Renaming the npm package / repo.** The folder is already `x402_swapper`; the package name change is a separate housekeeping pass.
- **Preserving merchant-mode as dead code.** Git history retains the previous behavior — no need for in-tree backwards-compatibility scaffolding.

---

## Readiness Assessment

| Capability | Current state | Action |
|---|---|---|
| Route registry | `pricing.mode: "fixed" \| "dynamic"`; `dynamic` is dormant ([src/http/protected-routes.ts:56](src/http/protected-routes.ts)) | **Replace** the union with `SwapPricing`; the registry holds a single `/api/swap` entry |
| Quote-engine inputs | `buildQuoteRequest(cfg, deadline)` reads `cfg.merchantRecipient/AssetOut/AmountOut` directly ([src/payment/quote-engine.ts:194](src/payment/quote-engine.ts)) | **Replace** with `buildSwapQuoteRequest(cfg, inputs, deadline)` taking buyer-supplied destination + refund + amount |
| Swap type | Hardcoded `EXACT_OUTPUT` ([src/payment/quote-engine.ts:200](src/payment/quote-engine.ts)) | **Switch to** `EXACT_INPUT` |
| Refund address | Hardcoded `cfg.gatewayRefundAddress` (operator wallet) | **Per-request** `refundTo` from buyer input; operator address only as fallback if buyer omits |
| Operator margin | None — operator pockets/absorbs slippage silently | **New**: `OPERATOR_MARGIN_BPS` env var; added to `amountIn` exposed to buyer; surfaced in `extra.crossChain.operatorFee` |
| `inputSchema` validation | Type field exists; **no enforcement** — purely decorative for x402scan/OpenAPI ([src/http/protected-routes.ts:85](src/http/protected-routes.ts)) | **Add** `inputValidator: z.ZodType<SwapRequestInput>` field; wire validation in middleware before the quote step |
| Middleware → quote engine wiring | Single `buildPaymentRequirements(cfg, store, url, quoteFn)` call, no per-request inputs threaded ([src/http/middleware.ts:227](src/http/middleware.ts)) | **Pass route descriptor** in `MiddlewareDeps`; parse + validate inputs; thread through to quote engine |
| `/api/premium` | Single mounted route + `buildPremiumHandler` echoing merchant fields ([src/http/protected-routes.ts:218](src/http/protected-routes.ts)) | **Delete**: route entry, handler factory, output schema |
| 200 response body | Whatever the route handler returns (e.g. `/api/premium` echoes merchant fields) | **New** `buildSwapReceipt(state)` helper reads from `SwapState.settlementResponse`; the swap route handler returns the receipt JSON |
| `SwapState` | Stores `originTxHash`, `oneClickStatus`, `settlementResponse` with destination tx hashes, slippage, amounts ([src/payment/settler.ts:802](src/payment/settler.ts)) | **Extend** with required `swapInputs` snapshot + `operatorMarginBps` (so handler + recovery have the buyer's per-request params after restart) |
| Settler — destination-chain extraction | `extractDestinationChain(cfg.merchantAssetOut)` ([src/payment/settler.ts:494,811](src/payment/settler.ts)) | **Replace** with `extractDestinationChain(state.swapInputs.destinationAsset)` |
| `MERCHANT_*` env vars | Required in `GatewayConfig`; validated at boot via `validateRecipientFormat(cfg)` ([src/infra/config.ts:212](src/infra/config.ts)) | **Delete** all three. Boot-time validation removed; replaced by per-request validation |
| Recipient validation | Boot-time check on cfg's merchant fields | **Move** to per-request: reuse `diagnoseQuoteRequest` against buyer-supplied destination + recipient |
| State persistence | SQLite + in-memory stores already round-trip arbitrary `SwapState` JSON | **SQLite migration**: add `swap_inputs` JSON column + `operator_margin_bps` integer column |
| OpenAPI / discovery | Emits `pricing.mode` into `x-payment-info` ([src/http/openapi.ts](src/http/openapi.ts)) | **Update** to emit swap-mode `x-payment-info` (range pricing) and a real `requestBody` from `inputSchema` |
| Settlement pipeline | `settlePayment` is destination-agnostic — works the same whether recipient is merchant or buyer | **Reused unchanged** beyond the cfg→state field rename above |
| Tests | 485 tests; merchant-config-heavy in quote-engine, middleware, e2e | **Rewrite** ~335 merchant-affected tests; **delete** `/api/premium` tests; **add** ~110 swap-mode tests |
| Docs | README, USER_GUIDE, .env.example all framed as merchant payment gateway | **Major rewrite** to reposition as swap service |

The settlement pipeline, state machine, error taxonomy, recovery-on-restart, ownership-proof story, rate-limiter, RPC pool, and discovery surfaces are all reusable verbatim. The merchant-specific code paths and the tests that exercise them are deleted.

---

## Design Decisions (with rationale)

### D1. Drop the `pricing.mode` discriminator entirely

The union (`FixedPricing | DynamicPricing`) was forward-extension headroom. With a single-product service, it's dead weight. `RoutePricing` becomes a single struct (`SwapPricing` shape). If a future product ever needs alternative pricing modes, the discriminator can be reintroduced — YAGNI for now.

### D2. EXACT_INPUT for swap mode (the brainstorm's §5 conclusion)

Buyer signs an authorization for an exact `amountIn`. The destination amount becomes the variable. Slippage upside lands on the buyer (where it belongs in a swap product), and the buyer experience matches what they get from any other bridge. EXACT_OUTPUT was correct for merchant settlement (merchant must receive an exact amount); it inverts badly for user settlement.

### D3. Operator margin as a service-level env var, not per-route

`OPERATOR_MARGIN_BPS` lives in `GatewayConfig` (e.g. `30` = 0.3%). The quote engine multiplies the 1CS-quoted `amountIn` by `(10000 + bps) / 10000` and uses that as the x402 `PaymentRequirements.amount`. The original 1CS amount and the margin amount are surfaced separately in `extra.crossChain.operatorFee` so the buyer sees exactly what they're paying. Service-level (not per-route) because there's only one route; operators who want differentiated margins (e.g. a "fast" lane) can add it later.

### D4. `inputSchema` becomes load-bearing — wire Zod validation

Today `inputSchema` is decorative (only used for OpenAPI/x402scan). For the swap route, it's the contract. The route entry carries an `inputValidator: z.ZodType<SwapRequestInput>` field; middleware runs validation before the quote step; failures return a structured 400 with field-level errors (`{ error: "INVALID_INPUT", details: [{path, message}] }`). The JSON Schema in `inputSchema` is generated from the Zod schema (via `zod-to-json-schema` or hand-kept-in-sync) so the OpenAPI doc stays accurate.

### D5. `SwapState.swapInputs` is required (not optional)

Every state in this service has buyer inputs — there's no other code path. Type it as required, not optional. Eliminates a class of "is this a swap-mode state?" branches in the receipt builder. SQLite migration adds the column as `NOT NULL` for new rows; pre-existing rows from the old merchant-mode database are not preserved (this is a fresh deploy of a different product — see D10).

### D6. Buyer's refund address is per-request, defaulting to the gateway address

If the buyer supplies `refundAddress`, use it. If they omit it (e.g. they don't have an EVM-side address they trust), fall back to `cfg.gatewayRefundAddress` and the operator handles forwarding manually. The default behavior degrades gracefully and matches the existing behavior for the operator-managed wallet.

### D7. Receipt response body (200) is JSON with a stable schema

Defined in the route's `outputSchema` and validated by tests. Shape:
```json
{
  "success": true,
  "originTxHash": "0x...",
  "destinationTxHashes": [{"hash": "...", "explorerUrl": "..."}],
  "destinationChain": "near",
  "destinationAsset": "nep141:...",
  "destinationAmount": "9985000",
  "destinationAmountFormatted": "9.985",
  "destinationAmountUsd": "9.99",
  "slippage": 0.0015,
  "operatorFee": {"bps": 30, "amount": "30000", "currency": "USDC"},
  "correlationId": "corr-...",
  "settledAt": "2026-05-07T12:00:00Z"
}
```
Built by a new pure function `buildSwapReceipt(state: SwapState): SwapReceipt` from data the settler already collects (`destinationChainTxHashes`, `slippage`, `amountOut*` are all in `swapDetails` from the 1CS status response).

### D8. GET `/api/swap` with query parameters (not POST with body)

x402 is method-agnostic — the protocol works on any HTTP verb — but the canonical x402 flow demonstrated by Coinbase, used by the bulk of existing x402-gated endpoints, and matched by the deleted predecessor's `/api/premium` is `GET`. Standard x402 clients are more likely to handle GET-with-query out of the box than POST-with-body. The swap inputs are five small scalar fields (~150–200 chars total when URL-encoded) that fit cleanly in a query string; the 1CS asset ID's colon round-trips as `%3A`.

Picking GET also drops a real operational concern: no `express.json()` body parser, no content-type negotiation, no "is the retry's body the same as the initial's?" question. The buyer's signature commits to the deposit address (which is the `to` field of the EIP-3009 authorization); deposit address binds 1:1 to a `SwapState` whose `swapInputs` were locked in at quote time. So the security model is identical whether inputs arrive via query or body — the choice is purely idiomatic.

The Bazaar `inputSchema` is method-agnostic in description but conventionally surfaces as `parameters: [{in: "query", ...}]` in `/openapi.json` for GET endpoints — Phase 9 reflects this.

### D9. Existing `defaultQuoteFn` stays unchanged

The 1CS SDK call signature is the same; only the *request shape* differs (EXACT_INPUT vs EXACT_OUTPUT, buyer-supplied recipient/asset/refund). `MiddlewareDeps.quoteFn` keeps its current type and default. No new injection point needed.

### D10. Delete merchant-mode code; do not preserve as dead paths

The git history retains the previous behavior. Keeping merchant-mode files in-tree as "future reference" creates dead code, dead tests, and dead docs that drift over time. Single product → single code path.

### D11. `.env.stellar` becomes `.env.swap.example`

The existing `.env.stellar` is a pre-filled merchant-mode config targeting Stellar. Rather than delete it, repurpose: rename to `.env.swap.example` and strip merchant fields, add comments showing how the buyer's request would supply Stellar destination params instead.

### D12. Hard cutover for the SQLite database

Pre-existing SQLite database files from a merchant-mode boot of this codebase are **not migrated**. The schema itself is unchanged — `state_json` already stores the full `SwapState` blob, so the new required `swapInputs` and `operatorMarginBps` fields round-trip for free. The cutover protection is a startup-time **fail-fast check**: if any existing row's `state_json` lacks `swapInputs`, the service refuses to boot and points the operator to `OPERATOR_GUIDE.md`'s "First boot" section. Operators delete `state.db` before first boot. Documented in `OPERATOR_GUIDE.md` and called out in `README.md`'s deploy section. Rationale: this is a fresh deploy of a different product; carrying migration scaffolding for a non-existent legacy is dead defensive code; failing loud at boot beats crashing mid-recovery on a dereference.

### D13. Delete superseded marketing/audit docs outright

Docs that framed the merchant-mode predecessor — `docs/AGENTIC_MARKET_PLAN.md`, `docs/POSITIONING.md`, `docs/CODEBASE_AUDIT_2026-04-22.md`, `docs/verifier-flow.svg`, `docs/X402SCAN.md` — are deleted in this change, not preserved with historical-context headers. They reference a product that no longer exists in this tree; preserving them creates drift and confuses readers about what this service is. Git history retains them. Phase 13 lists the deletions explicitly.

---

## Implementation Phases

### Phase 1 — Config: delete merchant fields, add operator margin

**File: [src/infra/config.ts](src/infra/config.ts)**

Delete from the Zod schema and from `GatewayConfig`:
- `merchantRecipient`
- `merchantAssetOut`
- `merchantAmountOut`

Delete `validateRecipientFormat(cfg)` and the call site at the end of `loadConfigFromEnv()`. The merchant-recipient validation moves to per-request validation (Phase 4).

Add to the schema:
- `operatorMarginBps`: Zod `number().int().min(0).max(1000)` — basis points, 0–10%. Default `30` (0.3%).
- (Keep) `gatewayRefundAddress`: still useful as the fallback when the buyer omits `refundAddress`.

Update tests in [src/infra/config.test.ts](src/infra/config.test.ts):
- Delete tests covering `MERCHANT_*` env var parsing and recipient-format warnings.
- Add tests for `OPERATOR_MARGIN_BPS` parsing, defaults, and bounds.

**File: [.env.example](.env.example)**

Strip the `MERCHANT_*` block; add `OPERATOR_MARGIN_BPS=30` with an explanatory comment.

**File: rename [.env.stellar](.env.stellar) → [.env.swap.example](.env.swap.example)**

Update content: drop `MERCHANT_*`, add a header comment explaining this is a swap-only deploy and the buyer supplies destination params per-request, add `OPERATOR_MARGIN_BPS=30`.

### Phase 2 — Types: introduce swap input/output, extend SwapState

**File: [src/types.ts](src/types.ts)**

Add:
```ts
export interface SwapRequestInput {
  destinationChain: string;       // e.g. "near", "arbitrum", "solana"
  destinationAsset: string;       // 1CS asset ID, e.g. "nep141:..."
  destinationAddress: string;     // buyer's recipient on destination chain
  amountIn: string;               // exact origin amount (smallest unit)
  refundAddress?: string;         // buyer's refund target on origin chain (EVM addr)
}

export interface SwapReceipt {
  success: boolean;
  originTxHash: string;
  destinationTxHashes: Array<{ hash: string; explorerUrl?: string }>;
  destinationChain: string;
  destinationAsset: string;
  destinationAmount: string;
  destinationAmountFormatted?: string;
  destinationAmountUsd?: string;
  slippage?: number;
  operatorFee: { bps: number; amount: string; currency: string };
  correlationId: string;
  settledAt: string;
}
```

Extend `SwapState` with required fields (no optional — every state in this service is a swap state):
```ts
export interface SwapState {
  // ...existing fields...
  swapInputs: SwapRequestInput;
  operatorMarginBps: number;
}
```

### Phase 3 — Route registry: collapse to swap-only

**File: [src/http/protected-routes.ts](src/http/protected-routes.ts)**

Delete:
- `FixedPricing` interface
- `DynamicPricing` interface
- `RoutePricing` discriminated union
- `PREMIUM_OUTPUT_SCHEMA`
- `/api/premium` registry entry
- `buildPremiumHandler`
- The `case "/api/premium":` arm in `buildProtectedRoutes`

Add:
```ts
import type { z } from "zod";
import type { SwapRequestInput } from "../types.js";

export interface SwapPricing {
  /** Indicative price band in USD. Actual price computed per-request from buyer's amountIn. */
  min: string;
  max: string;
  currency: "USD";
}

export interface ProtectedRoute {
  path: string;
  method: ProtectedMethod;
  summary: string;
  description?: string;
  pricing: SwapPricing;                    // simplified — no discriminator
  inputSchema: Record<string, unknown>;    // now required (was optional)
  outputSchema: Record<string, unknown>;   // now required (was optional)
  inputValidator: z.ZodType<SwapRequestInput>;  // NEW: required Zod validator
  handler: RequestHandler;
}
```

Update `validateProtectedRoute`:
- Drop the `pricing.mode === "fixed"` / `"dynamic"` branches.
- Validate that `pricing.min`, `pricing.max` are non-empty strings.
- Validate that `inputValidator`, `inputSchema`, `outputSchema` are present.

Add the swap output schema:
```ts
const SWAP_RECEIPT_SCHEMA: Record<string, unknown> = { /* mirrors SwapReceipt shape */ };
```

Add the registry entry:
```ts
export const PROTECTED_ROUTES: readonly ProtectedRoute[] = [
  {
    path: "/api/swap",
    method: "GET",
    summary: "Cross-chain swap",
    description:
      "Pay USDC on Base; receive any 1CS-supported asset on any 1CS-supported chain " +
      "at a buyer-supplied address. Single signed authorisation, no wallet-connect dance. " +
      "Buyer supplies destination params via query string (see inputSchema).",
    pricing: { min: "0.01", max: "100000", currency: "USD" },
    inputSchema: SwapRequestInputJsonSchema,   // from src/http/swap-input.ts
    outputSchema: SWAP_RECEIPT_SCHEMA,
    inputValidator: SwapRequestInputSchema,    // from src/http/swap-input.ts
    handler: (_req, _res, next) => next(new Error("handler not bound — see buildSwapHandler")),
  },
];

export function buildSwapHandler(_cfg: GatewayConfig): RequestHandler {
  return (req, res) => {
    const state = (req as Request & { swapState?: SwapState }).swapState;
    if (!state) throw new Error("Swap state not attached — middleware bug");
    res.json(buildSwapReceipt(state));
  };
}

export function buildProtectedRoutes(cfg: GatewayConfig): ProtectedRoute[] {
  const bound = PROTECTED_ROUTES.map((route) => {
    switch (route.path) {
      case "/api/swap":
        return { ...route, handler: buildSwapHandler(cfg) };
      default:
        return { ...route };
    }
  });
  validateProtectedRoutes(bound);
  return bound;
}
```

**File: new [src/http/swap-input.ts](src/http/swap-input.ts)**

```ts
import { z } from "zod";
import type { SwapRequestInput } from "../types.js";

export const SwapRequestInputSchema: z.ZodType<SwapRequestInput> = z.object({
  destinationChain: z.string().min(1),
  destinationAsset: z.string().regex(/^nep141:/, "Must be a NEP-141 asset ID"),
  destinationAddress: z.string().min(1),
  amountIn: z.string().regex(/^\d+$/, "Must be a positive integer (smallest unit)"),
  refundAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
});

/** JSON Schema mirror used in OpenAPI + 402 envelope's extensions.bazaar.info. */
export const SwapRequestInputJsonSchema: Record<string, unknown> = {
  type: "object",
  required: ["destinationChain", "destinationAsset", "destinationAddress", "amountIn"],
  properties: {
    destinationChain: { type: "string", description: "Chain prefix, e.g. 'near', 'arbitrum'." },
    destinationAsset: { type: "string", pattern: "^nep141:", description: "1CS asset ID." },
    destinationAddress: { type: "string", description: "Recipient on destination chain." },
    amountIn: { type: "string", pattern: "^\\d+$", description: "Origin amount in smallest unit." },
    refundAddress: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "Optional EVM refund address; defaults to gateway." },
  },
  additionalProperties: false,
};
```

### Phase 4 — Quote engine: replace merchant path with swap path

**File: [src/payment/quote-engine.ts](src/payment/quote-engine.ts)**

Delete:
- `buildQuoteRequest(cfg, deadline)` — uses `EXACT_OUTPUT` and reads merchant fields.
- The merchant-field reads in `mapToPaymentRequirements` and `buildCrossChainExtra`.

Replace `buildPaymentRequirements` signature to take buyer inputs:
```ts
export async function buildPaymentRequirements(
  cfg: GatewayConfig,
  store: StateStore,
  resourceUrl: string,
  inputs: SwapRequestInput,
  quoteFn: QuoteFn = defaultQuoteFn,
): Promise<BuildPaymentRequirementsResult> { /* ... */ }

function buildSwapQuoteRequest(
  cfg: GatewayConfig,
  inputs: SwapRequestInput,
  deadline: Date,
): QuoteRequest {
  return {
    dry: false,
    swapType: SwapType.EXACT_INPUT,           // ← key shift from merchant mode
    slippageTolerance: 50,
    originAsset: cfg.originAssetIn,
    destinationAsset: inputs.destinationAsset,
    amount: inputs.amountIn,                   // exact buyer input
    refundTo: inputs.refundAddress ?? cfg.gatewayRefundAddress,
    refundType: RefundType.ORIGIN_CHAIN,
    recipient: inputs.destinationAddress,
    recipientType: deriveRecipientType(inputs.destinationAsset),
    deadline: deadline.toISOString(),
    referral: cfg.referralTag,
  };
}

function applyOperatorMargin(amountIn: string, bps: number): { amountWithMargin: string; marginAmount: string } {
  const base = BigInt(amountIn);
  const margin = (base * BigInt(bps)) / 10000n;
  return { amountWithMargin: (base + margin).toString(), marginAmount: margin.toString() };
}

function buildCrossChainExtra(
  quoteResponse: QuoteResponse,
  inputs: SwapRequestInput,
  margin: { bps: number; amount: string },
): CrossChainQuoteExtra { /* surfaces inputs + operator fee */ }

function deriveRecipientType(destinationAsset: string): RecipientType {
  // Extract chain prefix; map to DESTINATION_CHAIN vs INTENTS via existing helpers.
}
```

The new `buildPaymentRequirements` flow:
1. Validate buyer-supplied address against destination asset via `diagnoseQuoteRequest` (reused from existing code).
2. Build the swap-shaped quote request; call `quoteFn`.
3. Apply the operator margin to `quote.amountIn` to compute the price the buyer signs.
4. Build `PaymentRequirements` with `payTo = depositAddress`, `amount = amountWithMargin`.
5. Persist new `SwapState` with `swapInputs`, `operatorMarginBps`, the 1CS quote response, deadline, etc.

`diagnoseQuoteRequest` is reused unchanged — it already validates `0x[a-fA-F0-9]{40}` for EVM, NEAR account format, and the EVM-vs-non-EVM cross-check. Just call it with the buyer's destination + recipient instead of cfg's.

### Phase 5 — Middleware: parse + validate inputs

**File: [src/http/middleware.ts](src/http/middleware.ts)**

Extend `MiddlewareDeps` with the route descriptor:
```ts
export interface MiddlewareDeps {
  // ...existing fields...
  route: ProtectedRoute;   // required — middleware needs the validator + pricing
}
```

In `handleX402Request`, before calling `buildPaymentRequirements`:

1. **No payment signature** path:
   - Parse buyer input from `req.query`. All five fields arrive as URL-decoded strings (`amountIn` stays a string for BigInt parsing downstream — Zod schema enforces the digits-only pattern).
   - Validate via `route.inputValidator.safeParse(req.query)`. On failure → 400 with structured error:
     ```json
     {"error": "INVALID_INPUT", "details": [{"path": "destinationAddress", "message": "..."}]}
     ```
   - Pass validated input into `buildPaymentRequirements(cfg, store, url, input, quoteFn)`.
   - Quote engine internally calls `diagnoseQuoteRequest` for chain-format validation; failures map to 400 `INVALID_INPUT` (overriding the default 503 mapping for swap routes — see "Decided" section).

2. **Payment signature present** path:
   - Look up `SwapState` by deposit address (unchanged).
   - `state.swapInputs` is already populated from the QUOTED phase.

3. **After settlement**, attach the SETTLED state to `req.swapState` so the swap handler can build the receipt without re-querying the store.

Add to the file (top-level declaration merge):
```ts
declare module "express-serve-static-core" {
  interface Request {
    swapState?: SwapState;
  }
}
```

### Phase 6 — Receipt as PAYMENT-RESPONSE header (x402-native)

**Decision (D14):** the swap receipt is carried in the `PAYMENT-RESPONSE` header's `extensions.crossChain` field, not in the 200 response body. The body is `{}` — matching the empty-body convention x402 uses elsewhere and avoiding two sources of truth for the same data. Reasoning: the existing settler already populates `extensions.crossChain` via `CrossChainSettlementExtra`, and `extensions` is the standardized x402 extensibility hook. Any conforming x402 client / indexer / explorer can consume the receipt without special-case knowledge of `/api/swap`.

**File: [src/types.ts](src/types.ts)**

Extend `CrossChainSettlementExtra` with the receipt fields the settler currently doesn't surface:
```ts
export interface CrossChainSettlementExtra {
  settlementType: "crosschain-1cs";
  destinationTxHashes?: Array<{ hash: string; explorerUrl: string }>;
  destinationChain?: string;
  destinationRecipient?: string;          // NEW — echo of swapInputs.destinationAddress
  destinationAsset?: string;
  destinationAmount?: string;
  destinationAmountFormatted?: string;     // NEW — from swapDetails
  destinationAmountUsd?: string;           // NEW — from swapDetails
  slippage?: number;                       // NEW — realised slippage from swapDetails
  operatorFee?: { bps: number; amount: string; currency: string };  // NEW
  swapStatus: OneClickStatus;
  correlationId?: string;
}
```

Delete the now-unused `SwapReceipt` type added in Phase 2 — `CrossChainSettlementExtra` is the on-the-wire receipt.

**File: [src/http/protected-routes.ts](src/http/protected-routes.ts)**

Simplify the swap handler — body is `{}`:
```ts
export function buildSwapHandler(_cfg: GatewayConfig): RequestHandler {
  return (req, res) => {
    const state = (req as RequestWithSwapState).swapState;
    if (!state) throw new Error("Swap state not attached to request — middleware bug");
    res.json({});
  };
}
```

Replace `SWAP_RECEIPT_SCHEMA` with an empty body schema (the receipt lives in the header):
```ts
const SWAP_BODY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Empty body. Settlement receipt is carried in the PAYMENT-RESPONSE header's " +
    "extensions.crossChain field (CrossChainSettlementExtra).",
};
```

### Phase 7 — Settler: cfg→state refs + receipt enrichment

**File: [src/payment/settler.ts](src/payment/settler.ts)**

Two related changes:

1. Replace `cfg.merchantAssetOut` reads with `state.swapInputs.destinationAsset` (5 sites). The function signature for `buildSettlementResponse` already takes `state`; the change is purely "read from state instead of cfg."

2. Enrich `buildSettlementResponse()` to populate the new `CrossChainSettlementExtra` fields from `state.swapInputs`, `state.operatorMarginBps`, and `state.oneClickStatus?.swapDetails`. Factor the receipt-building into a small helper:
```ts
function buildCrossChainSettlementExtra(
  state: SwapState,
  swapDetails: SwapDetails | undefined,
  status: OneClickStatus,
): CrossChainSettlementExtra {
  const marginAmount = applyOperatorMargin(
    state.quoteResponse.quote.amountIn,
    state.operatorMarginBps,
  ).marginAmount;
  return {
    settlementType: "crosschain-1cs",
    destinationTxHashes: swapDetails?.destinationChainTxHashes,
    destinationChain: extractDestinationChain(state.swapInputs.destinationAsset),
    destinationRecipient: state.swapInputs.destinationAddress,
    destinationAsset: state.swapInputs.destinationAsset,
    destinationAmount: swapDetails?.amountOut,
    destinationAmountFormatted: swapDetails?.amountOutFormatted,
    destinationAmountUsd: swapDetails?.amountOutUsd,
    slippage: swapDetails?.slippage,
    operatorFee: {
      bps: state.operatorMarginBps,
      amount: marginAmount,
      currency: "USDC",
    },
    swapStatus: status,
    correlationId: state.quoteResponse.correlationId,
  };
}
```
The helper is kept inside settler.ts (rather than a new `src/payment/receipt.ts`) because it has no consumers outside settlement and Phase 12 tests can drive it through `buildSettlementResponse` end-to-end.

### Phase 8 — Storage: stale-DB fail-fast (no schema change)

**File: [src/storage/store.ts](src/storage/store.ts)**

The existing schema serializes the full `SwapState` as JSON in the `state_json` TEXT column. The new required fields (`swapInputs`, `operatorMarginBps`) round-trip for free as additional JSON keys — no SQLite schema change is needed, and no SELECT queries need them as indexed columns. Adding separate columns would duplicate data already in the JSON blob without enabling any new queries.

What we **do** need is a hard-cutover check (D12): if an operator boots the swap service against a `state.db` left over from the predecessor product, the recovery loop would crash mid-flight when it dereferences `state.swapInputs.destinationAsset` on a row that lacks the field. To avoid that, we fail fast at init.

`InMemoryStateStore`: no change.

`SqliteStateStore.init()`: after `createSchema()`, sample one existing row's `state_json` and assert it parses with a `swapInputs` key. If the column has rows but none carry `swapInputs`, throw a clear error pointing to `docs/OPERATOR_GUIDE.md`'s "First boot" section. Empty DBs pass through cleanly (fresh deploy). The check runs once at startup and is bounded — `LIMIT 1`.

### Phase 9 — Discovery surfaces

**File: [src/http/openapi.ts](src/http/openapi.ts)**

For the swap route (GET with query params):
- Emit `parameters: [{in: "query", name: "destinationChain", required: true, schema: {...}}, ...]` — one entry per top-level field of `SwapRequestInputJsonSchema`. (No `requestBody` — that's POST-only in OpenAPI 3.x.)
- Emit `x-payment-info` as `{currency: "USD", min: "...", max: "..."}` plus `x-operator-margin-bps`.
- Emit the receipt schema as `responses.200`.
- Update the existing `CrossChainQuoteExtra` schema to include the `operatorFee` block.

Add a small helper `jsonSchemaToQueryParameters(schema)` that walks the top-level `properties` of a flat object schema and emits one `ParameterObject` per field. Keep it scoped to flat schemas (no nested objects) — the swap input is intentionally flat for query-string carriage.

**File: [src/http/discovery.ts](src/http/discovery.ts)**

No structural change — the `/.well-known/x402` document just lists each route's URL. The single `/api/swap` route surfaces the same way `/api/premium` did.

### Phase 10 — Server wiring

**File: [src/server.ts](src/server.ts)**

Update the route mount loop to pass the route descriptor into `MiddlewareDeps`:
```ts
for (const route of protectedRoutes) {
  const x402 = createX402Middleware({ ...deps, route });
  const method = route.method.toLowerCase() as "get" | "post";
  app[method](route.path, x402, route.handler);
}
```

No body parser needed — the GET-with-query-params choice (D8) means the middleware reads from `req.query`, which Express parses by default.

### Phase 11 — Client SDK + test client

**File: [src/client/x402-client.ts](src/client/x402-client.ts)**

Extend `requestResource` / `payAndFetch` to accept `query?: Record<string, string>` and append it to the URL. The same query string is used on both the initial 402 request (so the server can quote) and the signed retry — though the server only reads the deposit address from the signature on retry, sending the same query keeps the URL stable for any HTTP middleware (logs, caches, proxies).

**File: [scripts/test-client.ts](scripts/test-client.ts)**

Replace any merchant-mode parametrization with swap inputs as env vars:
```
RESOURCE_PATH=/api/swap            # default
SWAP_DESTINATION_CHAIN=near
SWAP_DESTINATION_ASSET=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
SWAP_DESTINATION_ADDRESS=alice.near
SWAP_AMOUNT_IN=10000000            # 10 USDC
SWAP_REFUND_ADDRESS=               # optional; defaults to gateway
```
The script URL-encodes these into a query string, GETs `/api/swap?...`, follows the 402 → sign → retry flow, decodes the receipt body on success, pretty-prints.

### Phase 12 — Tests: rewrite + delete merchant tests, add swap tests

**Delete** outright (merchant-only tests):
- Tests in [src/http/protected-routes.test.ts](src/http/protected-routes.test.ts) covering `/api/premium`, `buildPremiumHandler`, fixed/dynamic pricing branches.
- Tests in [src/infra/config.test.ts](src/infra/config.test.ts) covering `MERCHANT_*` env-var parsing and recipient-format warnings.

**Rewrite** (merchant-config-dependent, but the test scenario is still relevant):
- [src/payment/quote-engine.test.ts](src/payment/quote-engine.test.ts) — every test that built a fixture using `cfg.merchantRecipient` now builds it with `SwapRequestInput`; assertions on `EXACT_OUTPUT` flip to `EXACT_INPUT`; assertions on the request `recipient`/`refundTo` shift from cfg-sourced to input-sourced.
- [src/http/middleware.test.ts](src/http/middleware.test.ts) — every 402 → sign → 200 flow becomes a swap flow with body parsing; verify 400s on bad input.
- [src/e2e.test.ts](src/e2e.test.ts) — full HTTP roundtrip becomes a swap-only flow.
- [src/mocks/integration.test.ts](src/mocks/integration.test.ts) — multi-chain parametrized flow keeps using `DESTINATION_PRESETS` but as buyer-supplied inputs, not cfg merchant fields.
- [src/http/openapi.test.ts](src/http/openapi.test.ts) — OpenAPI assertions match the new shape (single swap route, requestBody, operator-fee in CrossChainQuoteExtra).
- [src/http/discovery.test.ts](src/http/discovery.test.ts) — assertions about route count / URLs.
- [src/server.test.ts](src/server.test.ts) — surface checks; should be minimal touch.
- [src/client/x402-client.test.ts](src/client/x402-client.test.ts) — buyer flow includes body now.
- [src/live-1cs.test.ts](src/live-1cs.test.ts) — replace EXACT_OUTPUT live tests with EXACT_INPUT live tests; small-amount real swap to a test address.
- [src/payment/settler.test.ts](src/payment/settler.test.ts) — assertions in `buildSettlementResponse` tests use `state.swapInputs.destinationAsset`. New assertions cover the enriched `extensions.crossChain` payload: `operatorFee` matches `applyOperatorMargin(quote.amountIn, marginBps).marginAmount`, `slippage`/`destinationAmountFormatted`/`destinationAmountUsd` echo from `swapDetails`, `destinationRecipient` echoes `swapInputs.destinationAddress`.

**Add** (new test files):

| File | Purpose | Approx count |
|---|---|---|
| `src/payment/quote-engine.swap.test.ts` | Parts of the rewrite that don't fit in the existing file: EXACT_INPUT request shape, margin math, refund-address default fallback, `validateBuyerDestination` across `DESTINATION_PRESETS`, `applyOperatorMargin` BigInt edge cases | ~30 |
| `src/http/swap-input.test.ts` | Zod schema accepts/rejects expected inputs; JSON Schema mirrors Zod | ~15 |
| `src/http/middleware.swap.test.ts` | New test cases: 400 on missing query param, 400 on bad EVM address format for an EVM destination, 400 on NEAR account format mismatch, URL-decoding of asset IDs containing `:` | ~20 |
| `src/swap-e2e.test.ts` | Multi-chain parametrized e2e (NEAR, Arbitrum, Ethereum, Polygon, Stellar, Solana) using `DESTINATION_PRESETS` as buyer inputs; asserts the receipt is in `PAYMENT-RESPONSE` header and the body is `{}` | ~15 |
| `src/storage/store.swap.test.ts` | `state_json` blob round-trips `swapInputs` + `operatorMarginBps` cleanly; stale-DB fail-fast at init throws on rows missing `swapInputs`; empty DB initialises cleanly; fresh-write DB initialises cleanly | ~8 |

**Mocks to update** ([src/mocks/](src/mocks/)):

- `mock-config.ts`: drop `MERCHANT_*` from `mockGatewayConfig()`; add `operatorMarginBps: 30`. Repurpose `DESTINATION_PRESETS` from "merchant configs" to "buyer inputs" — the structure is similar, just renamed.
- `mock-1cs-responses.ts`: replace `mockQuoteResponse()` (currently EXACT_OUTPUT, hardcoded merchant fields) with one that takes a `SwapRequestInput` and builds an EXACT_INPUT response. Add `mockHappyPathStatusSequenceWithSwapDetails()` so settler/receipt assertions have realistic `swapDetails.slippage`, `destinationChainTxHashes`.
- `mocks/index.ts`: update re-exports.

Total swap-mode tests after rewrite: roughly 500 tests (down ~50 from current 485 after deletions, up ~110 from new files).

### Phase 13 — Documentation

**Major rewrite** ([README.md](README.md)):
- Replace the "merchant payment gateway" framing with "x402-gated cross-chain swap service."
- Architecture diagram: single buyer flow (user → GET /api/swap?... → 402 + quote → sign → 200 + receipt). Drop the merchant-flow diagram.
- Quickstart with a minimal `curl` example for the full flow.
- "Who runs this?" section — adapt §3 of `SWAP_AS_RESOURCE.md` (NEAR onboarding, agentic infra, game economies, wallet/SDK providers, generic swap-as-API).

**Major rewrite** ([docs/USER_GUIDE.md](docs/USER_GUIDE.md)):
- Single buyer flow: how to format the query string, how to read the 402 envelope (especially `extra.crossChain.operatorFee`), how to sign EIP-3009, how to retry with the signed header, how to interpret the receipt.
- Concrete `curl` example of the full 402 → sign → 200 flow.
- Note on x402 method-agnosticism: this service uses GET because the inputs are small and scalar; same buyer signing flow as content-purchase x402 endpoints.

**Update** ([.env.example](.env.example)):
- Strip `MERCHANT_*`.
- Add `OPERATOR_MARGIN_BPS=30` with explanation.
- Update file header comment to reflect the single product.

**Rename + update** [.env.stellar](.env.stellar) → [.env.swap.example](.env.swap.example):
- Strip merchant fields.
- Add buyer-input example as a comment block (so operators can see what a buyer would POST).

**New** [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md):
- Adapted from §6 of `SWAP_AS_RESOURCE.md`.
- Regulatory considerations (MSB / money transmitter / MiCA / FCA / MAS) — explicitly framed as "consult a crypto-competent lawyer in your jurisdiction; this codebase makes no assumptions."
- KYC/sanctions/geofencing as deployment-time concerns, not in-tree code.
- Refund SLA disclosure pattern (link from `extra.crossChain.terms`).
- Operator margin guidance: typical bridges charge 5–30 bps; this is the knob; keep it transparent.
- Refund flow: how 1CS handles per-quote refunds, the `refundAddress` default behavior, when manual operator action is needed.

**Update** ([docs/TODO.md](docs/TODO.md)):
- Replace merchant-product items with swap-product items: automated buyer refunds, multi-origin support, KYC/sanctions hooks, slippage-tolerance configurability.
- Remove items that referenced `/api/premium`, `MERCHANT_*` env vars, or the deleted docs.

**Update** ([CLAUDE.local.md](CLAUDE.local.md)):
- Rewrite the architecture summary to reflect the swap-only product.
- Update the file map (delete `buildPremiumHandler`/`/api/premium` mentions; add `src/payment/receipt.ts`, `src/http/swap-input.ts`).
- Update the test count.
- Drop the "merchant destination" framing throughout.
- Remove references to deleted docs.

**Delete** (per D13 — superseded marketing/audit docs):
- `docs/AGENTIC_MARKET_PLAN.md`
- `docs/POSITIONING.md`
- `docs/CODEBASE_AUDIT_2026-04-22.md`
- `docs/verifier-flow.svg`
- `docs/X402SCAN.md`

After deletion, grep the remaining tree for inbound references to these files and clean up any links: README.md, USER_GUIDE.md, X402SCAN_PLAN.md, CLAUDE.local.md. The `X402SCAN_PLAN.md` historical doc references the deleted X402SCAN.md — flag it for the operator to either delete or update; the plan does not auto-delete it because it documents a shipped integration that's still live (the `/.well-known/x402` and `/openapi.json` surfaces the swap service uses).

**Mark** [SWAP_AS_RESOURCE.md](SWAP_AS_RESOURCE.md):
- Add a header note: "Implemented YYYY-MM-DD via [implementation_plan.md](implementation_plan.md). Doc preserved as the original product brief; refer to README.md for the live shape of the service."

### Phase 14 — Verification

End-to-end checks before declaring done:

1. `npm run typecheck` — clean.
2. `npm run lint` — clean.
3. `npm test` — full suite passes (~500 tests).
4. **Precondition for fresh boot**: any pre-existing `state.db` from a merchant-mode boot is deleted (D12). The startup-time schema check fails fast with a pointer to `OPERATOR_GUIDE.md` if a stale DB is present — verify this fail-fast path manually.
5. `npx tsx src/server.ts` boots a deploy with **only** `/api/swap` mounted; no `/api/premium`; no `MERCHANT_*` env vars set.
6. `curl http://localhost:3402/api/premium` returns 404 (route does not exist).
7. `curl 'http://localhost:3402/api/swap'` (no query params) returns 400 with `INVALID_INPUT` and field-level details listing every required field.
8. `curl 'http://localhost:3402/api/swap?destinationChain=near&destinationAsset=nep141:...&destinationAddress=not-a-near-account!!&amountIn=10000000'` returns 400 `INVALID_INPUT` with a chain-format diagnosis.
9. `curl 'http://localhost:3402/api/swap?destinationChain=near&destinationAsset=nep141:...&destinationAddress=alice.near&amountIn=10000000'` returns 402 with `accepts[0].extra.crossChain.operatorFee` populated, `payTo` equal to a 1CS deposit address, and `amount` equal to `(quote.amountIn × (10000 + bps) / 10000)`.
10. `npx tsx scripts/test-client.ts` (with `SWAP_*` env vars) runs the full flow end-to-end. The 200 body is `{}`; the receipt is decoded from the `PAYMENT-RESPONSE` header's `extensions.crossChain` field and pretty-printed.
11. `curl http://localhost:3402/openapi.json` shows a single `/api/swap` GET operation with declared query `parameters`, x402scan-shaped `x-payment-info`, an empty body schema for the 200 response, and the `CrossChainSettlementExtra` shape under the response's `headers.PAYMENT-RESPONSE`.
12. `curl http://localhost:3402/.well-known/x402` lists `/api/swap` (only).
13. (Optional, gated by JWT) `ONE_CLICK_JWT=... npm run test:live` — a real EXACT_INPUT swap to a test address.

If all green: the swap service is shippable.

---

## Critical files (modify)

| File | Change |
|---|---|
| `src/infra/config.ts` | **Delete** `MERCHANT_*` fields + `validateRecipientFormat`; **add** `OPERATOR_MARGIN_BPS` |
| `src/types.ts` | **Add** `SwapRequestInput`, `SwapReceipt`; **extend** `SwapState` with required `swapInputs`, `operatorMarginBps` |
| `src/http/protected-routes.ts` | **Delete** `FixedPricing`/`DynamicPricing`/`/api/premium`/`buildPremiumHandler`/`PREMIUM_OUTPUT_SCHEMA`; **add** `SwapPricing`/`/api/swap`/`buildSwapHandler`/`SWAP_RECEIPT_SCHEMA`; require `inputValidator`+`inputSchema`+`outputSchema` |
| `src/http/middleware.ts` | **Add** `route` to `MiddlewareDeps`; parse + Zod-validate input before quote step; attach `swapState` to `req` |
| `src/http/openapi.ts` | Single swap operation; require `requestBody`; emit `operatorFee` in CrossChainQuoteExtra schema |
| `src/payment/quote-engine.ts` | **Delete** merchant `buildQuoteRequest` + merchant code paths in `mapToPaymentRequirements`/`buildCrossChainExtra`; **add** `buildSwapQuoteRequest`, `applyOperatorMargin`, `deriveRecipientType`; switch to `EXACT_INPUT`; update `buildPaymentRequirements` signature to take inputs |
| `src/payment/settler.ts` | **Replace** `cfg.merchantAssetOut` reads with `state.swapInputs.destinationAsset` (2 sites) |
| `src/storage/store.ts` | SQLite migration: add `swap_inputs`, `operator_margin_bps` columns; update INSERT/SELECT |
| `src/server.ts` | Pass `route` into `createX402Middleware` for each mount; confirm `express.json()` |
| `src/client/x402-client.ts` | Accept optional `body` in `requestResource` / `payAndFetch` |
| `scripts/test-client.ts` | Replace merchant params with `SWAP_*` env-var inputs |
| `.env.example` | Strip `MERCHANT_*`; add `OPERATOR_MARGIN_BPS` |
| `README.md` | Rewrite as swap-service docs |
| `docs/USER_GUIDE.md` | Rewrite buyer flow |
| `docs/X402SCAN.md` | Update route references |
| `docs/TODO.md` | Replace merchant items with swap items |
| `CLAUDE.local.md` | Rewrite architecture summary |

## Critical files (new)

| File | Purpose |
|---|---|
| `src/http/swap-input.ts` | Zod schema + JSON Schema mirror for `SwapRequestInput` |
| `src/payment/quote-engine.swap.test.ts` | Unit tests for swap-mode-specific quote logic |
| `src/http/swap-input.test.ts` | Schema tests |
| `src/http/middleware.swap.test.ts` | Middleware integration tests |
| `src/swap-e2e.test.ts` | Multi-chain parametrized e2e tests |
| `src/storage/store.swap.test.ts` | SQLite migration tests |
| `docs/OPERATOR_GUIDE.md` | Operator regulatory + ops guide |
| `.env.swap.example` | Renamed from `.env.stellar`; pre-filled swap-only config |

## Critical files (delete)

| File | Reason |
|---|---|
| `.env.stellar` | Replaced by `.env.swap.example` |
| `docs/AGENTIC_MARKET_PLAN.md` | Marketing doc for the merchant predecessor (D13) |
| `docs/POSITIONING.md` | Positioning doc for the merchant predecessor (D13) |
| `docs/CODEBASE_AUDIT_2026-04-22.md` | Audit of the merchant predecessor (D13) |
| `docs/verifier-flow.svg` | Diagram of the merchant verify/settle flow (D13) |
| `docs/X402SCAN.md` | Operator guide for the merchant predecessor's x402scan registration (D13) |

(No source files are deleted outright — the changes are surgical edits within retained files. The merchant-specific *content* of files like `protected-routes.ts`, `quote-engine.ts`, `config.ts` is what gets removed.)

## Reused (no edits)

| File | Why it's safe |
|---|---|
| `src/payment/verifier.ts` | EIP-712 verification is identical |
| `src/payment/chain-prefixes.ts` | `extractChainPrefix`, `isValidNearAccount`, `EVM_CHAIN_PREFIXES` reused for buyer-input validation |
| `src/infra/rate-limiter.ts` | Per-IP quote limits + concurrent settlement caps apply unchanged |
| `src/infra/provider-pool.ts` | Origin chain RPC pool — same |
| `src/http/discovery.ts` | Already route-agnostic |
| `src/http/ownership-proof.ts` | Same operator-key signing; nothing swap-specific |
| `src/storage/store.ts` (in-memory store) | Opaque JSON serialization — new fields just round-trip |
| `src/http/cors-options.ts` | Cross-cutting; no merchant assumptions |
| `scripts/generate-ownership-proof.ts` | x402scan ownership-proof signing — unchanged |
| `scripts/verify-api-key.ts` | 1CS JWT validation — unchanged |
| `scripts/test-1cs-quote.sh` | Raw 1CS shell — unchanged |

---

## Effort estimate

This is a larger refactor than the sibling-product framing because we're rewriting tests and docs rather than just adding alongside.

- Phase 1 (config delete + add): ~30 min
- Phase 2 (types): ~30 min
- Phase 3 (route registry collapse): ~1 hour
- Phase 4 (quote engine rewrite): ~3 hours
- Phase 5 (middleware): ~1.5 hours
- Phase 6 (receipt builder): ~30 min
- Phase 7 (settler edits): ~15 min
- Phase 8 (SQLite migration): ~45 min
- Phase 9 (discovery surfaces): ~1 hour
- Phase 10 (server wiring): ~30 min
- Phase 11 (client SDK + test client): ~1.5 hours
- Phase 12 (tests rewrite + new): ~6–8 hours (the heaviest phase — ~335 tests touched + ~110 new)
- Phase 13 (docs rewrite): ~3–4 hours
- Phase 14 (verification): ~1 hour

Total: **~21–25 hours** (3 focused workdays). Larger than the 13–18 hour sibling estimate because rewriting affected tests and rewriting docs is the bulk of the effort.

---

## Decided (recorded for reviewers)

- **SQLite hard cutover** — pre-existing `state.db` files are deleted before first boot. The schema itself is unchanged (the `state_json` blob carries the new fields); a startup-time check sniffs the first row's JSON for `swapInputs` and fails fast if missing, pointing to the operator guide. (See D12 + Phase 8 + Phase 14 step 4.)
- **Superseded marketing/audit docs are deleted, not preserved** — `AGENTIC_MARKET_PLAN.md`, `POSITIONING.md`, `CODEBASE_AUDIT_2026-04-22.md`, `verifier-flow.svg`, `X402SCAN.md`. (See D13 + Phase 13.)
- **`OPERATOR_MARGIN_BPS = 0`** is allowed (operators may run a free service); no special casing in code, receipt's `operatorFee.amount` simply becomes `"0"`.
- **Per-request validation errors return 400 `INVALID_INPUT`**, not 503 `QuoteUnavailableError` — Phase 5 overrides the error mapping for the swap route since the buyer can fix the input themselves.
- **Receipt lives in the `PAYMENT-RESPONSE` header, not the body (D14)** — extends the existing `extensions.crossChain` `CrossChainSettlementExtra` carrier with `operatorFee`, `slippage`, formatted/USD destination amounts, and a `destinationRecipient` echo. The 200 body is `{}`. Single source of truth, x402-native extensibility hook, any conforming client/indexer can consume it without route-specific knowledge. (See Phase 6 + Phase 7.)

## Risks & open questions

1. **`recipientType` derivation** for non-EVM destinations. The 1CS SDK distinguishes `DESTINATION_CHAIN` vs `INTENTS` recipient types. NEAR-native is `INTENTS`; EVM is `DESTINATION_CHAIN`; Solana, Stellar, Bitcoin via OMFT all need verification. Mitigation: `deriveRecipientType(destinationAsset)` is a small helper; unit-test it against every prefix in `DESTINATION_PRESETS` before relying on it in live flows.

2. **Slippage tolerance** is hardcoded at `50` bps in the existing quote-engine. For swap mode the buyer is more sensitive than a merchant; consider making this an env var (`SLIPPAGE_TOLERANCE_BPS`) with a sane default. Easy follow-on; not a Phase-1 blocker.

3. **Buyer abuse vectors**. A public GET endpoint that quotes 1CS for any destination/asset/amount is a quote-DoS surface. Mitigations already in place: per-IP `quoteLimiter` (rate-limits 402 generation), `settlementLimiter` (caps concurrent settlements). Consider adding `MAX_AMOUNT_IN` env var (per-request maximum) in Phase 1 to bound quote economics. Document in `OPERATOR_GUIDE.md`.

4. **`X402SCAN_PLAN.md` fate**. The historical x402scan integration plan references the now-deleted `X402SCAN.md`. The integration itself (well-known + OpenAPI surfaces) is still live and used by the swap service. Decide whether to: (a) keep the plan doc as historical record of how the integration was built, (b) update it to reflect the new operator surface, or (c) delete since the integration is shipped and the operator-facing doc is gone. Default in this plan: keep as-is; note in PR description.

---

## What this plan deliberately does not do

- Preserve merchant-mode code paths or tests.
- Preserve `/api/premium`, `MERCHANT_*` env vars, `FixedPricing`/`DynamicPricing`, `buildPremiumHandler`.
- Add multi-origin support. Buyer pays in the operator-configured `ORIGIN_*` token.
- Add KYC, sanctions, geofencing hooks. Documented as deployment-time operator concerns.
- Build automated buyer refunds. We surface `refundTo` to 1CS and rely on its refund flow; deeper failures still require manual operator action.
- Touch the ownership-proof / x402scan registration flow. Same operator key, same proof, just a single swap route to advertise.
- Modify `defaultQuoteFn`. Same SDK call; only the request shape differs.
- Auto-rename the npm package or repo.
