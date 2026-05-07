#!/usr/bin/env npx tsx
/**
 * Verify that a 1Click Swap API key is valid and working.
 *
 * Usage:
 *   ONE_CLICK_JWT="<your-jwt>" npx tsx scripts/verify-api-key.ts
 *
 * This script:
 *   1. Sends a dry quote request to verify authentication
 *   2. Sends a real (non-dry) quote request to verify full functionality
 *   3. Reports the response structure and key fields
 *
 * Exit codes:
 *   0 — API key is valid and both requests succeeded
 *   1 — API key is invalid or requests failed
 */

import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";

// ─── Config ────────────────────────────────────────────────────────────

const JWT = process.env.ONE_CLICK_JWT;
const BASE_URL = process.env.ONE_CLICK_BASE_URL ?? "https://1click.chaindefuser.com";

if (!JWT) {
  console.error("❌  Missing ONE_CLICK_JWT environment variable.");
  console.error("    Usage: ONE_CLICK_JWT=\"<jwt>\" npx tsx scripts/verify-api-key.ts");
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}\n`);
}

function field(label: string, value: unknown) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  OpenAPI.BASE = BASE_URL;
  OpenAPI.TOKEN = JWT;

  console.log("🔑  1Click Swap API Key Verification");
  field("Base URL", BASE_URL);
  field("JWT (first 40 chars)", JWT!.substring(0, 40) + "...");

  // ── Test 1: Dry quote (no deposit address generated) ─────────────
  section("Test 1: Dry Quote Request");

  const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
    const dryResp = await OneClickService.getQuote({
      dry: true,
      swapType: QuoteRequest.swapType.EXACT_OUTPUT,
      slippageTolerance: 50,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: "1000000", // 1 USDC
      refundTo: "0x0000000000000000000000000000000000000001",
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: "test.near",
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline,
    });

    console.log("  ✅  Dry quote succeeded!\n");
    field("Correlation ID", dryResp.correlationId);
    field("Amount In (max)", `${dryResp.quote.amountIn} (${dryResp.quote.amountInFormatted} USDC)`);
    field("Min Amount In", dryResp.quote.minAmountIn);
    field("Amount Out", `${dryResp.quote.amountOut} (${dryResp.quote.amountOutFormatted} USDC)`);
    field("Deposit Address", dryResp.quote.depositAddress ?? "(none — dry mode)");
    field("Deadline", dryResp.quote.deadline);
    field("Time Estimate", `${dryResp.quote.timeEstimate}s`);
    field("Timestamp", dryResp.timestamp);
  } catch (err: any) {
    console.error("  ❌  Dry quote FAILED\n");
    console.error(`  Status:  ${err.status ?? "N/A"}`);
    console.error(`  Message: ${err.message}`);
    if (err.body) console.error(`  Body:    ${JSON.stringify(err.body)}`);

    if (err.status === 401) {
      console.error("\n  🔐  Your API key is invalid or expired.");
      console.error("     Check that ONE_CLICK_JWT is a valid JWT from the 1CS dashboard.");
    }
    process.exit(1);
  }

  // ── Test 2: Real quote (generates deposit address) ───────────────
  section("Test 2: Real Quote Request (non-dry)");

  try {
    const realResp = await OneClickService.getQuote({
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_OUTPUT,
      slippageTolerance: 50,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: "1000000", // 1 USDC
      refundTo: "0x0000000000000000000000000000000000000001",
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: "test.near",
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline,
    });

    console.log("  ✅  Real quote succeeded!\n");
    field("Correlation ID", realResp.correlationId);
    field("Deposit Address", realResp.quote.depositAddress ?? "(unexpectedly empty)");
    field("Amount In (max)", `${realResp.quote.amountIn} (${realResp.quote.amountInFormatted} USDC)`);
    field("Min Amount In", realResp.quote.minAmountIn);
    field("Amount Out", `${realResp.quote.amountOut} (${realResp.quote.amountOutFormatted} USDC)`);
    field("Deadline", realResp.quote.deadline);
    field("Time Estimate", `${realResp.quote.timeEstimate}s`);
    field("Time When Inactive", realResp.quote.timeWhenInactive ?? "N/A");
  } catch (err: any) {
    console.error("  ❌  Real quote FAILED\n");
    console.error(`  Status:  ${err.status ?? "N/A"}`);
    console.error(`  Message: ${err.message}`);
    if (err.body) console.error(`  Body:    ${JSON.stringify(err.body)}`);
    process.exit(1);
  }

  // ── Test 3: Try status endpoint (should return status for any address) ─
  section("Test 3: Status Endpoint (sanity check)");

  try {
    const statusResp = await OneClickService.getExecutionStatus(
      "0x0000000000000000000000000000000000000000",
    );
    console.log("  ✅  Status endpoint reachable\n");
    field("Status", statusResp.status);
  } catch (err: any) {
    // A 404 or empty response is fine — it means the endpoint works but the address isn't known
    if (err.status === 404 || err.status === 400) {
      console.log("  ✅  Status endpoint reachable (returned expected error for unknown address)\n");
      field("Status Code", err.status);
    } else {
      console.error("  ⚠️  Status endpoint returned unexpected error\n");
      console.error(`  Status:  ${err.status ?? "N/A"}`);
      console.error(`  Message: ${err.message}`);
      // Non-fatal — don't exit
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  section("Summary");
  console.log("  ✅  API key is valid and functional!");
  console.log("  ✅  Quote endpoint works (dry + real)");
  console.log("  ✅  1CS service is reachable\n");
  console.log("  You're ready to run the live integration tests:");
  console.log("  ONE_CLICK_JWT=\"<jwt>\" npm run test:live\n");
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
