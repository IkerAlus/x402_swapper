#!/usr/bin/env bash
#
# Test script: hit the live 1CS API with an EXACT_OUTPUT quote request
# and inspect the raw JSON response for field naming (amountIn vs maxAmountIn).
#
# Usage:
#   chmod +x scripts/test-1cs-quote.sh
#   ./scripts/test-1cs-quote.sh
#
# No JWT required for dry quotes or token listing.

set -euo pipefail

API_BASE="https://1click.chaindefuser.com"

# ── Step 1: Find correct asset IDs ──────────────────────────────────
echo "=== Step 1: Fetching supported tokens ==="
echo ""

TOKENS=$(curl -s "$API_BASE/v0/tokens")

echo "Looking for USDC on Base..."
echo "$TOKENS" | python3 -c "
import json, sys
tokens = json.load(sys.stdin)
for t in tokens:
    symbol = t.get('symbol', '')
    chain = t.get('blockchain', '')
    asset_id = t.get('defuseAssetId', '') or t.get('assetId', '') or t.get('id', '')
    # Show all USDC variants and any Base tokens
    if 'USDC' in symbol.upper() or 'base' in chain.lower() or 'base' in str(asset_id).lower():
        print(f'  chain={chain:12s}  symbol={symbol:10s}  id={asset_id}')
" 2>/dev/null || echo "(Could not parse tokens — dumping first 3000 chars)"

echo ""
echo "Looking for NEAR native or wrap.near..."
echo "$TOKENS" | python3 -c "
import json, sys
tokens = json.load(sys.stdin)
for t in tokens:
    symbol = t.get('symbol', '')
    chain = t.get('blockchain', '')
    asset_id = t.get('defuseAssetId', '') or t.get('assetId', '') or t.get('id', '')
    if 'near' in chain.lower() and ('NEAR' == symbol or 'wrap' in str(asset_id).lower() or 'usdc' in symbol.lower()):
        print(f'  chain={chain:12s}  symbol={symbol:10s}  id={asset_id}')
" 2>/dev/null

echo ""
echo "=== Full token list structure (first token) ==="
echo "$TOKENS" | python3 -c "
import json, sys
tokens = json.load(sys.stdin)
if tokens:
    print(json.dumps(tokens[0], indent=2))
    print(f'... ({len(tokens)} tokens total)')
" 2>/dev/null

# ── Step 2: Extract USDC-on-Base asset ID ────────────────────────────
ORIGIN_ASSET=$(echo "$TOKENS" | python3 -c "
import json, sys
tokens = json.load(sys.stdin)
for t in tokens:
    symbol = t.get('symbol', '')
    chain = t.get('blockchain', '')
    asset_id = t.get('defuseAssetId', '') or t.get('assetId', '') or t.get('id', '')
    if 'USDC' in symbol.upper() and 'base' in chain.lower():
        print(asset_id)
        sys.exit(0)
print('NOT_FOUND')
" 2>/dev/null)

DEST_ASSET=$(echo "$TOKENS" | python3 -c "
import json, sys
tokens = json.load(sys.stdin)
for t in tokens:
    symbol = t.get('symbol', '')
    chain = t.get('blockchain', '')
    asset_id = t.get('defuseAssetId', '') or t.get('assetId', '') or t.get('id', '')
    if 'NEAR' == symbol and 'near' in chain.lower():
        print(asset_id)
        sys.exit(0)
# Fallback: wrap.near
for t in tokens:
    asset_id = t.get('defuseAssetId', '') or t.get('assetId', '') or t.get('id', '')
    if 'wrap.near' in str(asset_id):
        print(asset_id)
        sys.exit(0)
print('nep141:wrap.near')
" 2>/dev/null)

echo ""
echo "=== Step 2: Using asset IDs ==="
echo "  Origin (USDC on Base): $ORIGIN_ASSET"
echo "  Destination (NEAR):    $DEST_ASSET"

if [ "$ORIGIN_ASSET" = "NOT_FOUND" ]; then
  echo ""
  echo "ERROR: Could not find USDC on Base in token list."
  echo "Try running with just the token dump to inspect manually."
  exit 1
fi

# ── Step 3: Request EXACT_OUTPUT quote ───────────────────────────────
echo ""
echo "=== Step 3: EXACT_OUTPUT Quote Request ==="

# Deadline: 30 minutes from now (ISO-8601 UTC)
if date --version >/dev/null 2>&1; then
  DEADLINE=$(date -u -d "+30 minutes" +%Y-%m-%dT%H:%M:%SZ)
else
  DEADLINE=$(date -u -v+30M +%Y-%m-%dT%H:%M:%SZ)
fi

# 1 NEAR = 10^24 yoctoNEAR, use a small amount for testing
BODY=$(cat <<EOF
{
  "dry": true,
  "swapType": "EXACT_OUTPUT",
  "slippageTolerance": 50,
  "originAsset": "$ORIGIN_ASSET",
  "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "$DEST_ASSET",
  "amount": "1000000000000000000000000",
  "refundTo": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "refundType": "ORIGIN_CHAIN",
  "recipient": "test.near",
  "recipientType": "DESTINATION_CHAIN",
  "deadline": "$DEADLINE"
}
EOF
)

echo "Deadline: $DEADLINE"
echo ""
echo "Request body:"
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
echo ""
echo "--- Sending request ---"
echo ""

RESPONSE=$(curl -s -w "\n\nHTTP_STATUS:%{http_code}" \
  -X POST "$API_BASE/v0/quote" \
  -H "Content-Type: application/json" \
  -d "$BODY")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | sed 's/HTTP_STATUS://')
RESPONSE_BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS:/d')

echo "HTTP Status: $HTTP_STATUS"
echo ""
echo "=== Full response ==="
echo "$RESPONSE_BODY" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE_BODY"

echo ""
echo "=== Step 4: Field Analysis ==="
echo ""

echo "$RESPONSE_BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
quote = data.get('quote', {})

if not quote:
    print('ERROR: No quote object in response. Full response keys:', list(data.keys()))
    if 'message' in data:
        print('API error:', data['message'])
    sys.exit(1)

print('All fields in quote object:')
for key in sorted(quote.keys()):
    val = quote[key]
    print(f'  {key:30s} = {val}')

print()
print('=== CRITICAL FIELD CHECK ===')
print()

has_amountIn = 'amountIn' in quote
has_maxAmountIn = 'maxAmountIn' in quote
has_minAmountIn = 'minAmountIn' in quote

print(f'  amountIn     present? {\"YES\":>5s}  value = {quote.get(\"amountIn\", \"N/A\")}' if has_amountIn else f'  amountIn     present?    NO')
print(f'  maxAmountIn  present? {\"YES\":>5s}  value = {quote.get(\"maxAmountIn\", \"N/A\")}' if has_maxAmountIn else f'  maxAmountIn  present?    NO')
print(f'  minAmountIn  present? {\"YES\":>5s}  value = {quote.get(\"minAmountIn\", \"N/A\")}' if has_minAmountIn else f'  minAmountIn  present?    NO')

print()
print('=== VERDICT ===')
print()

if has_amountIn and has_maxAmountIn:
    if quote['amountIn'] == quote['maxAmountIn']:
        print('Both amountIn and maxAmountIn exist and are EQUAL.')
        print('Our code using quote.amountIn is correct.')
    else:
        print('!!! BOTH EXIST BUT DIFFER !!!')
        print(f'  amountIn    = {quote[\"amountIn\"]}')
        print(f'  maxAmountIn = {quote[\"maxAmountIn\"]}')
        print()
        print('ACTION REQUIRED: Check which one should be the x402 payment amount.')
        print('  - If maxAmountIn > amountIn: we should use maxAmountIn (buyer needs to cover worst case)')
        print('  - If amountIn > maxAmountIn: unclear, investigate further')
elif has_maxAmountIn and not has_amountIn:
    print('!!! Only maxAmountIn exists (no amountIn) !!!')
    print('ACTION REQUIRED: Our code is BROKEN — it reads quote.amountIn which does not exist.')
    print('Fix: change quote-engine.ts to use quote.maxAmountIn')
elif has_amountIn and not has_maxAmountIn:
    print('Only amountIn exists (no maxAmountIn).')
    print('Our code using quote.amountIn is correct — it IS the upper bound.')
else:
    print('Neither amountIn nor maxAmountIn found — unexpected response format.')
" 2>/dev/null || echo "(Could not parse response as JSON)"
