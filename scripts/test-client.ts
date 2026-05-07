/**
 * x402 Test Client — simulates a buyer wallet paying the swap gateway.
 *
 * Exercises the full live 402 flow against the swap-as-resource service:
 *   1. GET /api/swap?<destination params> → 402 + PAYMENT-REQUIRED
 *   2. Decode the requirements, sign an EIP-3009 authorization
 *   3. GET /api/swap?<same params> + PAYMENT-SIGNATURE → 200 + receipt
 *
 * The swap receipt is carried in the `PAYMENT-RESPONSE` header's
 * `extensions.crossChain` field (CrossChainSettlementExtra). The 200 body
 * is `{}` by design (D14 in implementation_plan.md).
 *
 * Usage:
 *   # First start the gateway in another terminal:
 *   #   npx env-cmd npx tsx src/server.ts
 *
 *   # Then run this client (dry run — no real funds):
 *   npx tsx scripts/test-client.ts
 *
 *   # Or with real signing (you must fund the buyer wallet on the origin chain):
 *   DRY_RUN=false BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts
 *
 *   # Customise the destination via env:
 *   SWAP_DESTINATION_CHAIN=arbitrum \
 *   SWAP_DESTINATION_ASSET=nep141:arb-0xaf88...omft.near \
 *   SWAP_DESTINATION_ADDRESS=0xBuyerArbAddress \
 *   SWAP_AMOUNT_IN=10000000 \
 *   DRY_RUN=false BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts
 *
 * ⚠️  WARNING: With a funded buyer wallet and a live gateway, this
 *    script will attempt a REAL on-chain payment. Use small amounts.
 */

import { ethers } from "ethers";
import {
  authorizationTypes,
  permit2WitnessTypes,
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3402";
const RESOURCE_PATH = process.env.RESOURCE_PATH ?? "/api/swap";

// Default: Hardhat test wallet #0 — has no funds on real chains
const DEFAULT_BUYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY ?? DEFAULT_BUYER_KEY;

const DRY_RUN = process.env.DRY_RUN !== "false"; // Default: dry run

// Swap-input defaults — buyer's destination on a live deploy.
const SWAP_QUERY: Record<string, string> = {
  destinationChain: process.env.SWAP_DESTINATION_CHAIN ?? "near",
  destinationAsset:
    process.env.SWAP_DESTINATION_ASSET ??
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  destinationAddress: process.env.SWAP_DESTINATION_ADDRESS ?? "buyer.near",
  amountIn: process.env.SWAP_AMOUNT_IN ?? "1000000", // 1 USDC (6 decimals)
};
if (process.env.SWAP_REFUND_ADDRESS) {
  SWAP_QUERY.refundAddress = process.env.SWAP_REFUND_ADDRESS;
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/** Base64-safe encode a JSON object (matching @x402/core/http). */
function encodeBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

/** Decode a base64-encoded JSON header. */
function decodeBase64<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
}

/**
 * Shape of the informational 1CS-quote metadata the gateway carries on
 * `accepts[0].extra.crossChain`. Mirrors `CrossChainQuoteExtra` in
 * `src/types.ts`. Present on every 402 from this gateway.
 */
interface CrossChainQuoteExtra {
  protocol: "1cs";
  quoteId: string;
  destinationRecipient: string;
  destinationAsset: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  amountInUsd: string;
  refundFee?: string;
  refundTo: string;
  depositMemo?: string;
  operatorFee: { bps: number; amount: string; currency: string };
}

/**
 * Shape of the swap receipt carried on the 200 response's
 * `PAYMENT-RESPONSE.extensions.crossChain` field. Mirrors
 * `CrossChainSettlementExtra` in `src/types.ts`.
 */
interface CrossChainSettlementExtra {
  settlementType: "crosschain-1cs";
  destinationTxHashes?: Array<{ hash: string; explorerUrl: string }>;
  destinationChain?: string;
  destinationRecipient?: string;
  destinationAsset?: string;
  destinationAmount?: string;
  destinationAmountFormatted?: string;
  destinationAmountUsd?: string;
  slippage?: number;
  operatorFee?: { bps: number; amount: string; currency: string };
  swapStatus: string;
  correlationId?: string;
}

interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: {
      name?: string;
      version?: string;
      assetTransferMethod?: string;
      crossChain?: CrossChainQuoteExtra;
      [key: string]: unknown;
    };
  }>;
}

interface PaymentResponse {
  success: boolean;
  payer?: string;
  transaction: string;
  network: string;
  extensions?: {
    crossChain?: CrossChainSettlementExtra;
    [key: string]: unknown;
  };
}

function buildUrl(path: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return `${GATEWAY_URL}${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const wallet = new ethers.Wallet(BUYER_PRIVATE_KEY);
  console.log("═══════════════════════════════════════════════════════");
  console.log("  x402 Swap Test Client");
  console.log(`  Gateway:        ${GATEWAY_URL}`);
  console.log(`  Resource:       ${RESOURCE_PATH}`);
  console.log(`  Buyer:          ${wallet.address}`);
  console.log("");
  console.log("  Buyer destination (query params):");
  for (const [k, v] of Object.entries(SWAP_QUERY)) {
    console.log(`    ${k.padEnd(20)} ${v}`);
  }
  console.log(`  Dry run:        ${DRY_RUN}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("");

  const url = buildUrl(RESOURCE_PATH, SWAP_QUERY);

  // ── Step 1: Request without payment ────────────────────────────────
  console.log("Step 1: GET (no payment header) → expecting 402...");
  console.log(`  URL: ${url}`);

  const initialRes = await fetch(url);
  console.log(`  Status: ${initialRes.status}`);

  if (initialRes.status === 400) {
    const body = await initialRes.text();
    console.error(`  ❌ 400 INVALID_INPUT — buyer query failed validation:`);
    console.error(`     ${body}`);
    process.exit(1);
  }

  if (initialRes.status !== 402) {
    console.error(
      `  ❌ Expected 402, got ${initialRes.status}. Body:`,
      await initialRes.text(),
    );
    process.exit(1);
  }

  // ── Step 2: Decode PAYMENT-REQUIRED ────────────────────────────────
  const paymentRequiredHeader = initialRes.headers.get("payment-required");
  if (!paymentRequiredHeader) {
    console.error("  ❌ No PAYMENT-REQUIRED header in 402 response");
    process.exit(1);
  }

  console.log("  ✅ Got 402 with PAYMENT-REQUIRED header");
  console.log("");

  const paymentRequired = decodeBase64<PaymentRequired>(paymentRequiredHeader);
  console.log("Step 2: Decoded PaymentRequired:");
  console.log(`  x402Version:       ${paymentRequired.x402Version}`);
  console.log(`  resource.url:      ${paymentRequired.resource.url}`);
  console.log(`  accepts count:     ${paymentRequired.accepts.length}`);

  if (paymentRequired.accepts.length === 0) {
    console.error("  ❌ No payment options in accepts array");
    process.exit(1);
  }

  const accepted = paymentRequired.accepts[0]!;
  console.log("");
  console.log("  Payment option [0]:");
  console.log(`    scheme:               ${accepted.scheme}`);
  console.log(`    network:              ${accepted.network}`);
  console.log(`    asset:                ${accepted.asset}`);
  console.log(`    amount:               ${accepted.amount} (smallest unit, includes operator margin)`);
  console.log(
    `    amount (human):       ${(Number(accepted.amount) / 1e6).toFixed(6)} USDC`,
  );
  console.log(`    payTo (deposit):      ${accepted.payTo}`);
  console.log(`    maxTimeoutSeconds:    ${accepted.maxTimeoutSeconds}`);
  console.log(`    extra.name:           ${accepted.extra.name}`);
  console.log(`    extra.version:        ${accepted.extra.version}`);
  console.log(`    extra.transferMethod: ${accepted.extra.assetTransferMethod}`);

  const cross = accepted.extra.crossChain;
  if (cross && cross.protocol === "1cs") {
    console.log("");
    console.log("  extra.crossChain (1CS quote metadata — informational):");
    console.log(`    quoteId:              ${cross.quoteId}`);
    console.log(`    destinationRecipient: ${cross.destinationRecipient}`);
    console.log(`    destinationAsset:     ${cross.destinationAsset}`);
    console.log(
      `    amountOut:            ${cross.amountOut} (${cross.amountOutFormatted}) = $${cross.amountOutUsd}`,
    );
    console.log(`    amountInUsd:          $${cross.amountInUsd}`);
    console.log(`    refundTo:             ${cross.refundTo}`);
    console.log(
      `    operatorFee:          ${cross.operatorFee.amount} ${cross.operatorFee.currency} (${cross.operatorFee.bps} bps)`,
    );
    if (cross.refundFee !== undefined) {
      console.log(`    refundFee:            ${cross.refundFee}`);
    }
    if (cross.depositMemo !== undefined) {
      console.log(`    depositMemo:          ${cross.depositMemo}`);
    }
  }

  if (DRY_RUN) {
    console.log("");
    console.log("═══════════════════════════════════════════════════════");
    console.log("  DRY RUN — stopping here.");
    console.log("  The 402 flow works. To attempt a real payment:");
    console.log("");
    console.log("  1. Fund the buyer wallet with USDC on the origin chain:");
    console.log(`     ${wallet.address}`);
    console.log("");
    console.log("  2. Fund the facilitator wallet with native gas token");
    console.log("     (see the gateway startup logs for address)");
    console.log("");
    console.log("  3. Run again with DRY_RUN=false:");
    console.log(
      "     DRY_RUN=false BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts",
    );
    console.log("═══════════════════════════════════════════════════════");
    return;
  }

  // ── Step 3: Sign the payment ───────────────────────────────────────
  console.log("");
  console.log("Step 3: Signing payment...");

  const transferMethod = accepted.extra.assetTransferMethod as string;
  let signedPayload: Record<string, unknown>;

  if (transferMethod === "eip3009") {
    signedPayload = await signEIP3009(wallet, accepted);
  } else if (transferMethod === "permit2") {
    signedPayload = await signPermit2(wallet, accepted);
  } else {
    console.error(`  ❌ Unknown transfer method: ${transferMethod}`);
    process.exit(1);
  }

  const paymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted,
    payload: signedPayload,
  };

  const encodedPayment = encodeBase64(paymentPayload);
  console.log(`  ✅ Signed (${transferMethod}) — payload length: ${encodedPayment.length} chars`);
  console.log(`  → Paying to deposit address: ${accepted.payTo}`);

  // ── Step 4: Retry with PAYMENT-SIGNATURE ───────────────────────────
  console.log("");
  console.log("Step 4: GET with PAYMENT-SIGNATURE → awaiting settlement...");
  console.log("  (This may take 30-60 seconds for the cross-chain swap...)");

  const startTime = Date.now();
  const paymentRes = await fetch(url, {
    headers: { "PAYMENT-SIGNATURE": encodedPayment },
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`  Status: ${paymentRes.status} (took ${elapsed}s)`);

  if (paymentRes.status === 200) {
    console.log("  ✅ Payment accepted!");
    console.log("");

    const paymentResponseHeader = paymentRes.headers.get("payment-response");
    if (paymentResponseHeader) {
      const paymentResponse = decodeBase64<PaymentResponse>(paymentResponseHeader);
      console.log("  PAYMENT-RESPONSE (settlement summary):");
      console.log(`    success:     ${paymentResponse.success}`);
      console.log(`    transaction: ${paymentResponse.transaction}  (origin tx)`);
      console.log(`    network:     ${paymentResponse.network}`);
      console.log(`    payer:       ${paymentResponse.payer}`);

      const receipt = paymentResponse.extensions?.crossChain;
      if (receipt) {
        console.log("");
        console.log("  Swap receipt (extensions.crossChain):");
        console.log(`    settlementType:           ${receipt.settlementType}`);
        console.log(`    swapStatus:               ${receipt.swapStatus}`);
        console.log(`    destinationChain:         ${receipt.destinationChain ?? "-"}`);
        console.log(`    destinationRecipient:     ${receipt.destinationRecipient ?? "-"}`);
        console.log(`    destinationAsset:         ${receipt.destinationAsset ?? "-"}`);
        console.log(`    destinationAmount:        ${receipt.destinationAmount ?? "-"}`);
        if (receipt.destinationAmountFormatted) {
          console.log(`    destinationAmount (fmt):  ${receipt.destinationAmountFormatted}`);
        }
        if (receipt.destinationAmountUsd) {
          console.log(`    destinationAmount (USD):  $${receipt.destinationAmountUsd}`);
        }
        if (receipt.slippage !== undefined) {
          console.log(`    slippage:                 ${receipt.slippage}`);
        }
        if (receipt.operatorFee) {
          console.log(
            `    operatorFee:              ${receipt.operatorFee.amount} ${receipt.operatorFee.currency} (${receipt.operatorFee.bps} bps)`,
          );
        }
        if (receipt.destinationTxHashes && receipt.destinationTxHashes.length > 0) {
          console.log("    destinationTxHashes:");
          for (const tx of receipt.destinationTxHashes) {
            console.log(`      - ${tx.hash}`);
            if (tx.explorerUrl) console.log(`        ${tx.explorerUrl}`);
          }
        }
        if (receipt.correlationId) {
          console.log(`    correlationId:            ${receipt.correlationId}`);
        }
      }
    }

    // Body is `{}` by design (D14) — surface it for completeness.
    const body = await paymentRes.json();
    console.log("");
    console.log("  Resource body (intentionally empty):", JSON.stringify(body));
  } else {
    console.log(`  ❌ Payment failed with status ${paymentRes.status}`);
    console.log(`  Deposit address: ${accepted.payTo}`);
    const body = await paymentRes.text();
    console.log(`  Body: ${body}`);

    const paymentRequiredRetryHeader = paymentRes.headers.get("payment-required");
    if (paymentRequiredRetryHeader) {
      const pr = decodeBase64<PaymentRequired>(paymentRequiredRetryHeader);
      if (pr.error) {
        console.log(`  Verification error: ${pr.error}`);
      }
    }

    const paymentResponseHeader = paymentRes.headers.get("payment-response");
    if (paymentResponseHeader) {
      const paymentResponse = decodeBase64<Record<string, unknown>>(paymentResponseHeader);
      console.log(
        "  PAYMENT-RESPONSE:",
        JSON.stringify(paymentResponse, null, 2),
      );
    }
  }

  console.log("");
  console.log("Done.");
}

// ═══════════════════════════════════════════════════════════════════════
// EIP-3009 signing
// ═══════════════════════════════════════════════════════════════════════

async function signEIP3009(
  wallet: ethers.Wallet,
  accepted: PaymentRequired["accepts"][0],
): Promise<Record<string, unknown>> {
  const chainId = parseInt(accepted.network.split(":")[1]!, 10);
  const nowSec = Math.floor(Date.now() / 1000);

  const authorization = {
    from: wallet.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: "0",
    validBefore: String(nowSec + accepted.maxTimeoutSeconds),
    nonce: "0x" + ethers.hexlify(ethers.randomBytes(32)).slice(2),
  };

  const domain: ethers.TypedDataDomain = {
    name: accepted.extra.name as string,
    version: accepted.extra.version as string,
    chainId,
    verifyingContract: accepted.asset,
  };

  const types = {
    TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
      (f) => ({ name: f.name, type: f.type }),
    ),
  };

  const message = {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return { signature, authorization };
}

// ═══════════════════════════════════════════════════════════════════════
// Permit2 signing
// ═══════════════════════════════════════════════════════════════════════

async function signPermit2(
  wallet: ethers.Wallet,
  accepted: PaymentRequired["accepts"][0],
): Promise<Record<string, unknown>> {
  const chainId = parseInt(accepted.network.split(":")[1]!, 10);
  const nowSec = Math.floor(Date.now() / 1000);

  const permit2Authorization = {
    from: wallet.address,
    permitted: {
      token: accepted.asset,
      amount: accepted.amount,
    },
    spender: x402ExactPermit2ProxyAddress,
    nonce: String(Math.floor(Math.random() * 1_000_000)),
    deadline: String(nowSec + accepted.maxTimeoutSeconds),
    witness: {
      to: accepted.payTo,
      validAfter: "0",
    },
  };

  const domain: ethers.TypedDataDomain = {
    name: "Permit2",
    verifyingContract: PERMIT2_ADDRESS,
    chainId,
  };

  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [key, fields] of Object.entries(permit2WitnessTypes)) {
    types[key] = fields.map((f: { name: string; type: string }) => ({
      name: f.name,
      type: f.type,
    }));
  }

  const message = {
    permitted: permit2Authorization.permitted,
    spender: permit2Authorization.spender,
    nonce: permit2Authorization.nonce,
    deadline: permit2Authorization.deadline,
    witness: permit2Authorization.witness,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return { signature, permit2Authorization };
}

// ═══════════════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
