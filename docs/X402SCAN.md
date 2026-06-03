# Registering with x402scan

Operator guide for making this gateway discoverable by [x402scan](https://www.x402scan.com/).

This gateway ships three discovery surfaces out of the box:

| Surface | Path | Purpose |
|---|---|---|
| OpenAPI | `GET /openapi.json` | Primary — OpenAPI 3.1 doc with `x-payment-info` + `x-discovery.ownershipProofs` |
| Well-known | `GET /.well-known/x402` | Fallback / DNS `_x402` target — resources list + ownership proofs |
| Runtime 402 | Every paid route | Live x402 `PAYMENT-REQUIRED` envelope (v2) |

Adding a new paid endpoint is a one-line addition to `src/http/protected-routes.ts` — all three surfaces pick it up automatically.

---

## Prerequisites

1. **An EVM key** whose address you can publicly associate with this gateway. The existing `FACILITATOR_PRIVATE_KEY` works, but any key you control is fine — the proof only proves *some* key controls the domain, not specifically the facilitator.
2. **A public HTTPS URL** where the gateway will run (e.g. `https://gateway.example.com`). TLS is mandatory in production — see the separate TLS section in `docs/TODO.md`.
3. **Env access** to set `PUBLIC_BASE_URL` and `OWNERSHIP_PROOFS` on the production deployment.

You do **not** need HTTPS during development — all three endpoints run fine on `http://localhost:3402` for local verification. You only need the HTTPS URL locked in before submitting to x402scan, because x402scan probes the URL you register.

---

## Registration in 5 steps

### 1. Decide on the public URL

Pick the exact URL x402scan will probe. No trailing slash, no path, no query string. Examples:

```
https://gateway.example.com          ✅
https://api.example.com:8443         ✅  (non-default port OK)
https://example.com/x402             ✅  (subpath deployment OK)
https://gateway.example.com/         ❌  (trailing slash — gets normalised, but don't put it here)
https://gateway.example.com:443      ❌  (drop default port — gets normalised, but don't put it here)
```

The gateway normalises the URL internally (lowercase, drops default ports, strips trailing slash) before signing or emitting it, so you and everyone else must use the **same** canonical form the gateway would produce. If in doubt, run the script (step 2) with the URL you have and it will print the canonical form.

### 2. Generate an ownership proof

Run the helper script with the key and URL. The script prints the canonical message, the signer address, and a ready-to-paste signature.

```bash
# Option A — sign with the facilitator key already in your env
FACILITATOR_PRIVATE_KEY=0x... PUBLIC_BASE_URL=https://gateway.example.com \
  npx tsx scripts/generate-ownership-proof.ts

# Option B — sign with an explicit key (e.g. a cold-storage key)
npx tsx scripts/generate-ownership-proof.ts \
  --key 0xyour_private_key \
  --url https://gateway.example.com
```

Example output:

```
════════════════════════════════════════════════════════════
  x402scan ownership proof
════════════════════════════════════════════════════════════

Canonical message (signed bytes):
  "x402 ownership of https://gateway.example.com"

Signer address:  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Public base URL: https://gateway.example.com

Signature (paste into OWNERSHIP_PROOFS in .env):
0x4aada660a077336dd15800e19093c09bd0757f31d5e128a09be1e4990c3a251352115ecf991839cb8de231a43a5eabab39a87bc54ce01be3fb57cff978f4330b1c
```

**Security notes.**
- Run the script on a trusted host (dev machine, CI secrets context, or against a hardware wallet). The script never touches the production gateway's request path — that's by design so the signing key cannot leak through a future code bug.
- The canonical message is short and literal so you can paste it into a hardware-wallet prompt if you prefer to sign with a Ledger or similar.
- Signatures are long-lived assertions. They do not expire on their own — rotate `OWNERSHIP_PROOFS` if the signing key changes.

### 3. Set the env vars

In your production `.env`:

```bash
PUBLIC_BASE_URL=https://gateway.example.com
OWNERSHIP_PROOFS=0x4aada660a077336dd15800e19093c09bd0757f31d5e128a09be1e4990c3a251352115ecf991839cb8de231a43a5eabab39a87bc54ce01be3fb57cff978f4330b1c
```

Multiple proofs are comma-separated. See [Multi-key setups](#multi-key-setups) below.

### 4. Restart the gateway and check the startup log

Restart and look for these lines:

```
[x402] ⚠️  Discovery check: OWNERSHIP_PROOFS[0] recovered to 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 (over "x402 ownership of https://gateway.example.com")
[x402-1CS] Discovery — /.well-known/x402 (1 resource(s), 1 proof(s)), /openapi.json (OpenAPI 3.1)
```

- The first line confirms the proof recovers to the key you expected. If the recovered address is wrong, you signed with the wrong key or a different URL than what's in `PUBLIC_BASE_URL`.
- The second line confirms both discovery surfaces are served and shows how many resources and proofs they'll carry.

If you see a line like `OWNERSHIP_PROOFS[0] is malformed — expected 0x + 130 hex chars`, the signature didn't paste correctly — check for wrapping, missing `0x`, or truncation.

### 5. Verify from a public probe

**Easiest** — use the official validator CLI from any host with `npx`:

```bash
npx -y @agentcash/discovery gateway.example.com -v
```

This runs the same probe x402scan performs (OpenAPI-first precedence, runtime 402 classification) and prints per-route pass/fail with the specific spec violation if any. Worth running before clicking "Add Server".

**Manual probes** — exercise all three surfaces from outside your network:

```bash
# Well-known fan-out
curl -s https://gateway.example.com/.well-known/x402 | jq

# OpenAPI doc
curl -s https://gateway.example.com/openapi.json | jq '{openapi, info, "x-discovery", paths: (.paths|keys)}'

# Runtime 402 challenge — supply minimum valid buyer inputs
curl -si 'https://gateway.example.com/api/swap?destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=alice.near&amountIn=1000000' | head -40
```

Expected (well-known):
```json
{
  "version": 1,
  "resources": ["https://gateway.example.com/api/swap"],
  "ownershipProofs": ["0x4aada6...0b1c"],
  "instructions": "Prefer /openapi.json for per-route schemas..."
}
```

Expected (OpenAPI, abbreviated):
```json
{
  "openapi": "3.1.0",
  "info": { "title": "x402-swapper", "version": "0.1.0" },
  "x-discovery": { "ownershipProofs": ["0x4aada6...0b1c"] },
  "paths": ["/api/swap"]
}
```

Expected (runtime 402): `HTTP/1.1 402` with a `PAYMENT-REQUIRED` header carrying a base64-encoded envelope. Decode it to confirm:
- `accepts[0]` carries `scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds`
- `extensions.bazaar.info.inputSchema` is present (required for x402scan to mark the route "invocable" — per DISCOVERY.md § C)

```bash
curl -si 'https://gateway.example.com/api/swap?destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=alice.near&amountIn=1000000' \
  | grep -i '^payment-required:' | awk '{print $2}' | tr -d '\r\n' \
  | base64 -d | jq '{accepts: .accepts[0], bazaar: .extensions.bazaar.info}'
```

Once all three checks pass, submit the URL at <https://www.x402scan.com/resources/register>. Two button choices:
- **Add Server** — x402scan fans out from your base URL, discovers `/openapi.json` and `/.well-known/x402`, and probes every listed resource.
- **Register This URL Only** — registers only the exact URL you give. Useful for partial rollouts or rate-limited providers.

---

## Multi-key setups

`OWNERSHIP_PROOFS` accepts multiple signatures. Useful when:

- **Multi-signer attestation** — two or more team members each sign the canonical message with their own keys. Register all signatures so any one of them is a valid proof of control.
- **Key rotation window** — after rotating the signing key, publish proofs from both the old key and the new key for a transition period, then remove the old one.
- **Hardware wallet + hot wallet** — the facilitator hot key signs one proof for automation, the team's cold key signs another for human-auditable assurance.

Example with two proofs:

```bash
OWNERSHIP_PROOFS=0x4aada6...0b1c,0x8f21c3...ab99
```

The startup log reports one "recovered to" line per proof so you can verify every signer at a glance.

---

## Subpath deployments

If the gateway is mounted behind a reverse proxy under a path (e.g. `https://example.com/x402`), set the full path in `PUBLIC_BASE_URL`:

```bash
PUBLIC_BASE_URL=https://example.com/x402
```

The discovery documents then emit:

```json
{
  "resources": ["https://example.com/x402/api/swap"]
}
```

And the OpenAPI `servers[0].url` is `https://example.com/x402`. The signed canonical message is over `x402 ownership of https://example.com/x402`, so regenerate proofs when you change the base URL.

The only constraint: your reverse proxy must forward both `/openapi.json` and `/.well-known/x402` relative to the mount path. x402scan probes them at `${PUBLIC_BASE_URL}/.well-known/x402` and `${PUBLIC_BASE_URL}/openapi.json`.

---

## Adding a new paid route

The discovery surfaces read from a single registry in `src/http/protected-routes.ts`. Add a new entry and the OpenAPI doc, the well-known manifest, and the Express mount all pick it up automatically. Sketch:

```ts
export const PROTECTED_ROUTES: readonly ProtectedRoute[] = [
  // existing /api/swap entry
  {
    path: "/api/reports",
    method: "GET",
    summary: "Fetch a structured market report",
    description: "Returns a JSON report for the requested symbol.",
    // Today every paid route uses the swap-mode dynamic-pricing shape
    // (currency + min/max). When we add a fixed-price route, RoutePricing
    // will grow a `mode` discriminator — see TODO #?.
    pricing: { currency: "USD", min: "0.25", max: "0.25" },
    inputValidator: ReportRequestInputSchema, // Zod schema for query params
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", pattern: "^[A-Z]{1,5}$" } },
      required: ["symbol"],
      additionalProperties: false,
    },
    outputSchema: { /* ... */ },
    handler: (req, res) => { /* ... */ },
  },
];
```

Every entry **must** have an `inputSchema` — x402scan marks routes without one as non-invocable and skips them from the payable index. The `protected-routes.test.ts` suite asserts this invariant at test time so a forgotten schema fails CI rather than shipping.

---

## What's in the 402 envelope

When x402scan (or any other indexer / integrator) probes a paid route, the gateway returns HTTP 402 with a base64-encoded `PAYMENT-REQUIRED` header. Decoded, every envelope carries an informational cross-chain block at `accepts[0].extra.crossChain` describing the underlying 1Click Swap.

**The block never affects signing.** The EVM `exact` scheme's signing inputs live on the sibling keys `extra.name`, `extra.version`, plus the top-level `asset` / `network`. Clients that don't care about cross-chain metadata ignore the whole object.

### Machine-readable shape

The OpenAPI document (`/openapi.json`) advertises the shape at:

- Top-level **`x-crosschain`** — protocol discriminator + pointer:
  ```json
  "x-crosschain": {
    "protocol": "1cs",
    "schema": "#/components/schemas/CrossChainQuoteExtra"
  }
  ```
- **`components.schemas.CrossChainQuoteExtra`** — JSON Schema for the block:
  ```json
  {
    "type": "object",
    "required": [
      "protocol", "quoteId", "destinationRecipient", "destinationAsset",
      "amountOut", "amountOutFormatted", "amountOutUsd", "amountInUsd", "refundTo"
    ],
    "properties": {
      "protocol":             { "type": "string", "enum": ["1cs"] },
      "quoteId":              { "type": "string" },
      "destinationRecipient": { "type": "string" },
      "destinationAsset":     { "type": "string" },
      "amountOut":            { "type": "string" },
      "amountOutFormatted":   { "type": "string" },
      "amountOutUsd":         { "type": "string" },
      "amountInUsd":          { "type": "string" },
      "refundFee":            { "type": "string" },
      "refundTo":             { "type": "string" },
      "depositMemo":          { "type": "string" }
    }
  }
  ```
- Each paid operation's **`responses.402.description`** explicitly mentions `accepts[0].extra.crossChain` and cross-links to the schema.

### Field meaning

| Key | Purpose |
|---|---|
| `protocol` | Always `"1cs"`. Clients key on this before reading further. |
| `quoteId` | 1CS quote correlation ID — the same identifier logged by the gateway and echoed on the eventual `PAYMENT-RESPONSE` header. Use it when opening a support ticket. |
| `destinationRecipient` | The buyer's recipient on the destination chain (supplied per-request by the buyer; this gateway is a swap-as-resource service, not single-merchant). |
| `destinationAsset` | The 1CS asset ID the buyer receives (supplied per-request). |
| `amountOut` / `amountOutFormatted` | Expected destination amount (smallest unit + human-readable). |
| `amountOutUsd` / `amountInUsd` | USD values on both sides, for disclosure UX. |
| `refundFee` | Fee 1CS charges if the deposit is refunded. Optional — absent when the destination chain has no refund fee. |
| `refundTo` | Address that receives refunds from failed swaps. |
| `depositMemo` | **Chain-dependent.** Required by Stellar, XRP, and Cosmos-family chains; omitted otherwise. Silent failures happen if a client drops this when the destination chain needs it. |

### What's NOT in the block

The gateway deliberately omits a few fields the 1CS SDK also returns:

- `minAmountIn`, `deadline`, `timeEstimate` — buyer doesn't need them (the first is a 1CS internal threshold, the second is already encoded in the top-level `maxTimeoutSeconds`, the third is a heuristic).
- `quoteRequest` — echoes gateway config; kept internal.
- `virtualChainRecipient` / `virtualChainRefundRecipient` / `customRecipientMsg` — 1CS routing internals.

### Verifying from a probe

```bash
# OpenAPI advertises the shape:
curl -s https://gateway.example.com/openapi.json \
  | jq '."x-crosschain", .components.schemas.CrossChainQuoteExtra'

# A real 402 envelope carries the block:
curl -si 'https://gateway.example.com/api/swap?destinationAsset=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1&destinationAddress=alice.near&amountIn=1000000' \
  | grep -i '^payment-required:' | awk '{print $2}' | tr -d '\r\n' \
  | base64 -d | jq '.accepts[0].extra.crossChain'
```

---

## DNS `_x402` TXT records (optional, infrastructure)

The IETF `_x402` TXT record draft points resolvers at `/.well-known/x402`. If you have DNS zone access for the gateway's domain, publish:

```
_x402.gateway.example.com. TXT "well-known=https://gateway.example.com/.well-known/x402"
```

x402scan and third-party discovery tools can then find the gateway from DNS alone. This is a pure DNS operation — no gateway code changes needed.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Startup warns `PUBLIC_BASE_URL is not` | `OWNERSHIP_PROOFS` set but `PUBLIC_BASE_URL` empty | Set `PUBLIC_BASE_URL` in `.env` and restart. |
| Startup warns `OWNERSHIP_PROOFS[N] is malformed` | Signature wrapped, truncated, or missing `0x` | Re-copy the full signature from the generator script. Each proof is `0x` + exactly 130 hex chars. |
| `recovered to` shows an unexpected address | Signed with a different key than you thought, or signed a different URL | Re-run the generator with the right key and URL. Check you're signing `PUBLIC_BASE_URL` verbatim. |
| `/openapi.json` returns 404 | Gateway still running a pre-Phase-4 build | Pull the latest code and restart. The route mounts before paid routes in `src/server.ts`. |
| `/.well-known/x402` has empty `resources` | `PUBLIC_BASE_URL` is unset | Set it. Without a base URL, the gateway can't emit absolute URLs in the document. |
| `/.well-known/x402` has empty `ownershipProofs` despite being configured | Proofs were all rejected as malformed; or `PUBLIC_BASE_URL` is unset | Check the startup log — every malformed proof logs a warning. Fix the signatures or unset/set URL accordingly. |
| x402scan indexes the domain but marks routes as `skipped` | Route missing an `inputSchema` | Add one to the registry entry. `inputSchema: { type: "object", properties: {}, additionalProperties: false }` is the minimum for parameterless routes. |
| Discovery endpoints return 402 instead of 200 | Someone moved them below the paid-routes loop in `src/server.ts` | The discovery mounts must stay above the protected-routes loop. See the test in `src/server.test.ts` (`both endpoints skip the x402 middleware`). |

---

## References

- [x402scan DISCOVERY.md](https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md) — authoritative spec for fields and classifications
- [x402scan registration form](https://www.x402scan.com/resources/register) — self-serve submission ("Add Server" / "Register This URL Only")
- [x402scan marketplace](https://www.x402scan.com/resources) — see what indexed services look like
- [x402 protocol](https://x402.org) — payment protocol this gateway implements
- Validation CLI: `npx -y @agentcash/discovery <domain> -v`
- `src/http/openapi.ts` — OpenAPI document builder (pure function, tested in `src/http/openapi.test.ts`)
- `src/http/discovery.ts` — well-known document builder (pure function, tested in `src/http/discovery.test.ts`)
- `src/http/ownership-proof.ts` — canonical message + EIP-191 signing / recovery helpers
- `src/http/protected-routes.ts` — registry of paid routes consumed by both discovery surfaces
- `scripts/generate-ownership-proof.ts` — stand-alone proof generator
