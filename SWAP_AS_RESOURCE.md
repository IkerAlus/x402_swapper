# Use case: x402-gated cross-chain swaps (the resource is the routing itself)

> **Brainstorm doc.** Not a build plan. Asks the question: *should this gateway also support a flow where the x402 buyer is paying for a cross-chain swap to their own address, instead of paying a merchant for content?*

---

## 1. The shape of the proposed flow

In the current gateway:

- The operator pre-configures a **merchant destination** (`MERCHANT_RECIPIENT` + `MERCHANT_ASSET_OUT` + `MERCHANT_AMOUNT_OUT`) at boot.
- Every paid request settles to *that* merchant on *that* chain in *that* asset.
- The "resource" the buyer purchases is whatever the route's handler returns — content, an API result, an action.

In the proposed flow:

- The operator runs the gateway as a **paid swap service**.
- The buyer's GET request carries the swap parameters as query-string or body fields: `destinationChain`, `destinationAsset`, `destinationAddress`, `amountOut`.
- The gateway quotes 1CS dynamically with those fields (instead of reading from static config), presents the resulting `amountIn` as the x402 price, and the buyer signs an EIP-3009 transfer to the per-request 1CS deposit address.
- After settlement, **funds land at the buyer's own address on the destination chain**, not at a merchant's.
- The operator's revenue is a margin on top of the 1CS-quoted rate, paid in USDC on the origin chain.
- The "resource" is the swap receipt: deposit tx hash, destination tx hash, realised rate, settlement timestamp.

Architecturally this is a small delta on the existing codebase. Commercially it's a different product.

---

## 2. Is this a valid x402 use case?

**Yes, but with one caveat that's worth stating up front.**

x402 is, formally, "pay for HTTP resources." The protocol is silent on what the resource *is* — content, API access, compute, an action. A cross-chain swap is a perfectly valid paid action: the buyer pays, the server performs the work (custody-free routing via 1CS), and returns a receipt. Spec-conformant, no protocol abuse.

The caveat: in a *content* purchase, the resource has standalone value beyond the payment. In a *swap* purchase, the resource and the payment are entangled — the buyer pays N units of asset A and the "resource" is "we routed those N units to address X on chain Y." The buyer is fundamentally paying *to receive their own funds back, on a different chain*. That's a fine use case, but it makes UX, slippage, and refund handling more delicate than for content purchases. We'll come back to this in §5.

---

## 3. Who would actually run this?

Plausible operators, ranked by how compelling the fit is:

### a. NEAR-ecosystem onboarding endpoints

A NEAR-native dApp wanting to onboard EVM-resident users without sending them through a bridge UI. The dApp exposes a single endpoint:

```
GET /onramp?chain=near&asset=USDC&recipient=alice.near&amount=10
```

The user (or their wallet, or an agent acting on their behalf) signs one EIP-3009 authorisation; gets `10 USDC` at `alice.near` ~30 seconds later. No wallet connect dance, no manual bridge UI, no "approve, swap, confirm" three-step flow. Discoverable via x402scan; usable from any standard x402 client.

This is the cleanest fit. NEAR's whole product narrative is "users shouldn't see chain boundaries." A cross-chain-swap-as-paid-resource turns a marketing claim into an HTTP endpoint.

### b. Agentic infrastructure operators

An AI-agent-platform whose agents transact across chains. An agent reasons "I have USDC on Base, I need SOL on Solana to call this program" — currently it has to script a bridge with chain-specific signing. With a swap-as-resource endpoint, it makes one HTTP call:

```
POST /swap  body={chain:"solana", asset:"SOL", recipient:"<agent's solana address>", amount:"0.5"}
```

The agent's existing x402 client signs and pays; the funds appear. The platform charges a margin per call. This is the agentic-payments thesis applied to liquidity routing rather than to content.

### c. Game / dApp economy operators

A game or dApp whose users need a destination-chain asset to play (e.g. SOL for a Solana game, NEAR for a NEAR program). The operator exposes a paid swap endpoint integrated into onboarding; the player pays once with whatever they have on Base; the asset arrives on the play chain at their own wallet. The operator earns a small per-swap margin and avoids building/integrating a bridge UI inside the product.

### d. Wallet / SDK providers

A non-custodial wallet builder offering "one-click cross-chain top-up" inside the wallet UI. The wallet posts to the operator's endpoint, signs the x402 challenge with the user's key, returns the receipt. Behind the scenes it's the gateway. The wallet can either run their own deployment or use a hosted one.

### e. Generic "swap-as-an-API" service

A standalone product where the operator simply runs a public x402-gated endpoint as a cross-chain swap utility. Differentiated from LiFi / Across / Stargate by:

- **Single signed authorisation, no wallet-connect dance.** Critical for agents and scripts.
- **No operator-side custody during swap.** Funds go from buyer's wallet → 1CS deposit address → buyer's destination wallet. The operator's wallet is in the loop only for gas.
- **x402-discoverable.** Other agents can find and route through this endpoint via standard discovery surfaces.
- **No bilateral integration.** Anyone with a v2-conformant x402 client can use it.

This is the most ambitious framing and probably the most regulated; see §6.

---

## 4. What changes in the codebase

The current architecture supports this with surprisingly small edits. Concretely:

| Area | Current | Required for swap-as-resource |
|---|---|---|
| `infra/config.ts` | Reads `MERCHANT_RECIPIENT` / `MERCHANT_ASSET_OUT` / `MERCHANT_AMOUNT_OUT` as static config | Either: keep them as defaults, or mark this deploy as "swap mode" and require per-request fields instead |
| `http/protected-routes.ts` | `pricing.mode: "fixed"` is the only branch wired up | The registry already has `pricing.mode: "dynamic"` defined but dormant. Wire the engine to it. |
| Route's `inputSchema` | Optional, mostly empty | Required: must declare `{destinationChain, destinationAsset, destinationAddress, amountOut}` as required fields, with chain-specific address validation per `chain-prefixes.ts` |
| `payment/quote-engine.ts` | Reads `cfg.merchantRecipient`, etc. when calling 1CS | Reads from the parsed request inputs (validated against `inputSchema`) |
| Recipient validation | `infra/config.ts` runs `isValidNearAccount` etc. at boot | Needs to run at request-handling time on buyer-supplied addresses, with a clear 400 if the address is malformed |
| Operator margin | None — operator absorbs/pockets slippage silently | New config knob (`OPERATOR_MARGIN_BPS` or fixed `OPERATOR_MARGIN_USD`) added to the quoted `amountIn`; surfaced in `extra.crossChain` so the buyer can see what they're paying for |
| Response body | Whatever the route handler returns | A swap receipt: deposit tx hash, destination tx hash, realised rate, slippage actually paid, fees |
| Multi-origin support | Single `ORIGIN_NETWORK` + `ORIGIN_ASSET_IN` per deploy | Optional but high-value: let the buyer pay with any 1CS-supported origin asset |

The state machine, settlement flow, error taxonomy, recovery-on-restart, discovery surfaces, and ownership-proof story all stay identical. **The settlement pipeline doesn't care whether the recipient is a merchant or the buyer.** That's the structural reason this works.

Estimate: ~1–2 days of focused work for the single-origin variant; ~3–5 days for the multi-origin variant. Plus tests.

---

## 5. The honest UX and trust trade-offs

Three places where the swap-as-resource use case is meaningfully harder than the merchant-content use case:

### Slippage asymmetry is much worse for the buyer

In the current EXACT_OUTPUT model, the buyer signs an authorisation for `amountIn` (the upper bound). If the swap settles at a better rate, the difference refunds to the operator's `GATEWAY_REFUND_ADDRESS` — not to the buyer. For a $0.10 content purchase this is rounding error. For a $1,000 cross-chain swap, the buyer could "tip" the operator $20–50 of unintended slippage savings on every transaction. **That's a structural disadvantage of the current architecture for swap UX, and it has to be addressed before this use case is buyer-friendly.**

Two ways out:
- **Switch to EXACT_INPUT semantics** for swap-mode routes (1CS supports both). Buyer signs for an exact `amountIn`; the destination amount becomes the variable. Slippage downside lands on the buyer (as it does in every other bridge), but slippage upside also lands on the buyer.
- **Refund the slippage upside to the buyer's destination address.** Possible but requires gateway to either custody temporarily and forward, or coordinate a second small swap. More complex.

For the use case to be honest, EXACT_INPUT is probably the right answer. The current EXACT_OUTPUT design was chosen for *merchant* settlement (merchant must receive an exact amount); it inverts badly for *user* settlement.

### Refund-on-failure has higher stakes

If the cross-chain leg fails mid-flight under the current design, refunds land at the operator's `GATEWAY_REFUND_ADDRESS` and require manual forwarding. For content purchases the dollar amount is small and the operational pain is bounded. For a swap service, refund-on-failure can be $1k+ per event, and the operator becomes responsible for forwarding to the buyer in the buyer's preferred asset — non-trivial. Either:
- The route advertises a clear refund SLA (e.g., manual within 24h, with the operator's contact), and the operator runs a refund tool, or
- The codebase grows an automated refund flow (1CS-side refund_to address can be set per-quote — currently the gateway hardcodes the operator's wallet, but in swap mode this should be a buyer-supplied address).

The second option is mostly free architecturally (the 1CS API supports a per-quote refund address) and changes the failure-mode UX dramatically. **For swap-as-resource, the buyer's refund address should be a per-request input, not a static operator config.** That's a one-line change in the quote-engine and a substantial improvement in trust.

### "What did I just pay for?" 

Buyers of content get a thing. Buyers of a swap get a confirmation that the swap happened. The 200 response body has to be a *real* swap receipt — origin tx hash, destination tx hash, observed rate, fees breakdown, timestamp — and the gateway has to produce it from data the settler already has (`SwapState` already tracks all of this). This is documentation/UX work, not architecture work, but it's load-bearing.

---

## 6. The thing nobody wants to talk about: regulation

Running a public, paid, anything-to-anything cross-chain swap service is, in many jurisdictions, a **money services business** or its regional equivalent. Even if the gateway is non-custodial in the strict sense (1CS holds funds, not the operator), a regulator looking at an operator who:

- Accepts USDC from a buyer,
- Charges a margin,
- Routes funds to a different chain, and
- Returns the funds at a destination of the buyer's choosing,

…will have a hard time concluding "this person is not running a money transmission service." The legal analysis differs by jurisdiction (US state-by-state for MSB / money transmitter, EU under MiCA, UK under FCA, Singapore under MAS, etc.) and by whether the operator is touching fiat (here: no).

This is **out of scope for this codebase**, but it is in scope for any operator who wants to deploy this use case publicly. A reasonable boilerplate before any of the runners in §3 ship to production:

- Get an opinion from a crypto-competent lawyer in their primary jurisdiction.
- Decide whether the service is geofenced, whitelisted, KYC'd at signup, or fully open.
- Decide whether ToS / disclaimers are required at the 402 challenge level (the `extra` block can carry a link).

The current gateway emits no jurisdiction headers, no KYC hooks, no geofencing. A swap-mode deploy might want all three. None of that is hard to add; all of it is necessary before public production launch in many places.

The merchant-content use case (current design) sidesteps most of this: the merchant is selling content, the operator is just a payment rail for one merchant, the buyer's funds always go to that one preconfigured merchant. The swap use case loses that simplicity.

---

## 7. So — is it worth building?

Honest verdict: **yes, but as a sibling product, not as a config flag.**

The architectural cost is small — most of the codebase (state machine, settler, discovery, error handling, recovery) is reusable verbatim. The product, UX, and regulatory work is substantial. Trying to ship "the same gateway, but in swap mode" by toggling an env var would underestimate the buyer-facing changes (EXACT_INPUT vs EXACT_OUTPUT, buyer-supplied refund address, real swap receipts, slippage transparency, possibly multi-origin support, possibly KYC hooks).

A reasonable path:

1. **Branch the protected-route registry to support a "swap" pricing mode.** Keep the merchant mode untouched and proven.
2. **Wire a swap-mode quote-engine path** that reads from buyer-supplied request fields instead of operator config, and uses EXACT_INPUT semantics on the 1CS side.
3. **Make the buyer's refund address a per-request input** (the 1CS API supports per-quote refunds; the gateway just hasn't surfaced this).
4. **Build a real receipt response body** from data the settler already produces.
5. **Treat regulation, KYC, and ToS as deployment-time concerns** — document what an operator should think about; don't bake assumptions in.

Done in that shape, the gateway becomes a two-product codebase: *merchant payment gateway* (current) and *cross-chain swap-as-a-paid-resource* (new). They share a settlement engine, an x402 surface, a state machine, and a discovery story. They differ in the route registry, the quote-engine inputs, and the buyer-facing semantics.

The use case is real. The buyer is real (NEAR-ecosystem onboarding endpoints, agentic infra, game economies, wallet SDKs). The differentiation versus existing bridges is real (single signed authorisation, no wallet-connect dance, no operator-side custody, x402-discoverable). The trade-offs are real (slippage UX, refund UX, regulation). The build effort is moderate (1–2 days for single-origin, 3–5 days for multi-origin, plus tests and docs).

This is the most natural second use case for the codebase. The current architecture is shaped well for it. The gap between "merchant payment" and "swap as resource" is, mostly, the inversion of who owns the destination address — and that inversion is one config-vs-request-input change in the quote engine.

Worth pursuing as a follow-on, not as a feature.
