#!/usr/bin/env npx tsx
/**
 * Generate an x402scan ownership-proof signature.
 *
 * Signs the canonical message `x402 ownership of <normalized PUBLIC_BASE_URL>`
 * with an EVM private key and prints the resulting EIP-191 signature so the
 * operator can paste it into `OWNERSHIP_PROOFS` in `.env`.
 *
 * Usage:
 *
 *   # Sign with the facilitator key already in your environment:
 *   FACILITATOR_PRIVATE_KEY=0x... PUBLIC_BASE_URL=https://gateway.example.com \
 *     npx tsx scripts/generate-ownership-proof.ts
 *
 *   # Sign with an explicit key / URL on the command line:
 *   npx tsx scripts/generate-ownership-proof.ts \
 *     --key 0xyour_private_key \
 *     --url https://gateway.example.com
 *
 *   # Read env from a dotenv file:
 *   env-cmd -f .env npx tsx scripts/generate-ownership-proof.ts
 *
 * Output is structured so you can pipe / copy it:
 *   - The canonical message (so you can paste it into a hardware-wallet
 *     prompt if you prefer to sign with e.g. a Ledger).
 *   - The signer address (sanity check — make sure it's the key you meant).
 *   - The signature string, printed on its own line, ready for
 *     `OWNERSHIP_PROOFS=<paste>`.
 *
 * ## Security
 *
 * This script is intentionally separate from the running gateway so the
 * signing key never touches the request path. Run it on a dev machine, in
 * a CI secrets context, or against a hardware wallet — never on the
 * production host unless you also rotate the key after.
 *
 * Exit codes:
 *   0 — signature generated successfully
 *   1 — missing / malformed input
 */

import { ethers } from "ethers";
import {
  buildOwnershipProofMessage,
  normalizePublicBaseUrl,
  signOwnershipProof,
  recoverOwnershipProofSigner,
} from "../src/http/ownership-proof.js";

// ═══════════════════════════════════════════════════════════════════════
// CLI / env parsing
// ═══════════════════════════════════════════════════════════════════════

interface Inputs {
  privateKey: string;
  publicBaseUrl: string;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Inputs {
  let privateKey = env.FACILITATOR_PRIVATE_KEY ?? "";
  let publicBaseUrl = env.PUBLIC_BASE_URL ?? "";

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--key" || flag === "-k") {
      if (!value) die(`${flag} requires a value`);
      privateKey = value;
      i++;
    } else if (flag === "--url" || flag === "-u") {
      if (!value) die(`${flag} requires a value`);
      publicBaseUrl = value;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      printUsage();
      process.exit(0);
    } else if (flag && flag.startsWith("-")) {
      die(`unknown flag: ${flag}`);
    }
  }

  if (!privateKey) {
    die("missing private key — set FACILITATOR_PRIVATE_KEY or pass --key 0x...");
  }
  if (!publicBaseUrl) {
    die("missing public URL — set PUBLIC_BASE_URL or pass --url https://...");
  }

  // Normalise and re-verify the URL before proceeding; fail fast if it's
  // not a valid http(s) origin.
  try {
    normalizePublicBaseUrl(publicBaseUrl);
  } catch (err) {
    die(`invalid public base URL: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { privateKey, publicBaseUrl };
}

function die(message: string): never {
  console.error(`❌  ${message}`);
  console.error("    Run with --help for usage.");
  process.exit(1);
}

function printUsage(): void {
  console.log(`Usage: generate-ownership-proof [--key <hex>] [--url <url>]

Signs the canonical x402scan ownership message with an EVM private key.
Inputs can come from flags or environment variables:

  --key, -k     EVM private key (0x + 64 hex). Falls back to $FACILITATOR_PRIVATE_KEY.
  --url, -u     Public base URL (http(s)://host[:port]). Falls back to $PUBLIC_BASE_URL.
  --help, -h    Show this message.

Prints the canonical message, signer address, and signature. Paste the
signature into OWNERSHIP_PROOFS in your .env. Each gateway can host
multiple proofs (comma-separated) if the operator uses multiple keys.`);
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const { privateKey, publicBaseUrl } = parseArgs(process.argv.slice(2), process.env);

  // Construct the wallet. `new ethers.Wallet` throws with a helpful error
  // for malformed keys (wrong length, non-hex, missing 0x).
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(privateKey);
  } catch (err) {
    die(`invalid private key: ${err instanceof Error ? err.message : String(err)}`);
  }

  const message = buildOwnershipProofMessage(publicBaseUrl);
  const signature = await signOwnershipProof(wallet, publicBaseUrl);

  // Sanity-check that the signature recovers to the expected address —
  // catches any future subtle bug in the message builder.
  const recovered = recoverOwnershipProofSigner(signature, publicBaseUrl);
  const expected = wallet.address.toLowerCase();
  if (recovered !== expected) {
    die(
      `signature verification mismatch: recovered ${recovered}, expected ${expected}. ` +
        `This is a library bug — stop and report before using the proof.`,
    );
  }

  const bar = "═".repeat(60);
  console.log(`\n${bar}`);
  console.log("  x402scan ownership proof");
  console.log(`${bar}\n`);
  console.log("Canonical message (signed bytes):");
  console.log(`  ${JSON.stringify(message)}\n`);
  console.log(`Signer address:  ${wallet.address}`);
  console.log(`Public base URL: ${publicBaseUrl}\n`);
  console.log("Signature (paste into OWNERSHIP_PROOFS in .env):");
  console.log(signature);
  console.log("");
  console.log("For multiple proofs, comma-separate them:");
  console.log(`  OWNERSHIP_PROOFS=${signature},<another-signature>`);
  console.log("");
}

main().catch((err) => {
  console.error("❌  Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
