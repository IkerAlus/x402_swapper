/**
 * Ownership-proof helpers for x402scan discovery registration.
 *
 * x402scan (and the IETF `_x402` TXT-record draft) requires operators to
 * prove they control the domain they're registering by supplying a list of
 * EIP-191 signatures over a canonical message. The signatures are emitted
 * in:
 *   - `GET /.well-known/x402` → `ownershipProofs: ["0x..."]`
 *   - `GET /openapi.json` → `x-discovery.ownershipProofs: ["0x..."]`
 *
 * **Signing never happens inside the running gateway.** The operator uses
 * the stand-alone script (`scripts/generate-ownership-proof.ts`) with the
 * facilitator private key — or any other key they choose — and pastes the
 * resulting signature into `OWNERSHIP_PROOFS`. This keeps the private key
 * off the request path even if a future code change exposed it there.
 *
 * ## Canonical message format
 *
 * ```
 * x402 ownership of <origin>
 * ```
 *
 * where `<origin>` is the normalised public base URL — lowercase scheme +
 * host + optional port + **no trailing slash, no path, no query**.
 *
 * Example (verbatim bytes signed by the operator):
 * ```
 * x402 ownership of https://gateway.example.com
 * ```
 *
 * Design choices:
 *  - **Short and literal** — easy to copy into hardware wallet prompts.
 *  - **No timestamp / nonce** — proofs are long-lived assertions; we rely
 *    on the operator rotating `OWNERSHIP_PROOFS` if the signing key changes.
 *    If x402scan's spec later adds a rotation field we'll extend here.
 *  - **EIP-191** `personal_sign` flavour so standard wallets (`eth_sign` /
 *    `ethers.Wallet.signMessage`) produce a valid signature without the
 *    operator needing EIP-712 typed data.
 *
 * @module ownership-proof
 */

import { ethers } from "ethers";

// ═══════════════════════════════════════════════════════════════════════
// Canonical message
// ═══════════════════════════════════════════════════════════════════════

/**
 * Prefix used in the canonical ownership-proof message. Kept as a named
 * constant so the generator script, the verifier, and any future ecosystem
 * tool all use byte-identical text.
 */
export const OWNERSHIP_PROOF_PREFIX = "x402 ownership of ";

/**
 * Normalise a public base URL for inclusion in the canonical message.
 * Returns the string the signer must commit to; throws on obviously
 * malformed input.
 *
 * Rules:
 *  - Must parse as a `URL`.
 *  - Only `http://` / `https://` accepted.
 *  - Path, query, and fragment are stripped — only scheme + host + port.
 *  - Scheme + host are lowercased; any trailing slash is removed.
 *  - Default ports (`:80` for http, `:443` for https) are removed so
 *    operators who specify them don't produce a different message than
 *    operators who don't.
 */
export function normalizePublicBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `PUBLIC_BASE_URL must use http or https scheme, got ${url.protocol}`,
    );
  }

  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  let port = url.port;
  // Drop default ports so http://host and http://host:80 yield identical output.
  if ((scheme === "http:" && port === "80") || (scheme === "https:" && port === "443")) {
    port = "";
  }
  const authority = port ? `${host}:${port}` : host;
  return `${scheme}//${authority}`;
}

/**
 * Build the canonical text the operator must sign.
 *
 * @example
 *   buildOwnershipProofMessage("https://gateway.example.com/")
 *   // → "x402 ownership of https://gateway.example.com"
 */
export function buildOwnershipProofMessage(publicBaseUrl: string): string {
  return `${OWNERSHIP_PROOF_PREFIX}${normalizePublicBaseUrl(publicBaseUrl)}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Signature shape + verification
// ═══════════════════════════════════════════════════════════════════════

/**
 * Regex for a structurally valid EIP-191 signature: `0x` + 130 hex chars
 * (r: 32 + s: 32 + v: 1 = 65 bytes). Does **not** check cryptographic
 * validity — use {@link recoverOwnershipProofSigner} for that.
 */
export const OWNERSHIP_PROOF_SIGNATURE_REGEX = /^0x[a-fA-F0-9]{130}$/;

/**
 * Lightweight shape check applied to every entry in `OWNERSHIP_PROOFS`.
 * Fast — called at config load, before the server binds its socket.
 */
export function isValidOwnershipProofFormat(signature: string): boolean {
  return OWNERSHIP_PROOF_SIGNATURE_REGEX.test(signature);
}

/**
 * Recover the signer address from an ownership-proof signature.
 * Returns the lowercase EVM address that produced the signature for the
 * given public base URL. Throws if the signature is malformed (bad hex,
 * wrong length, unable to recover a public key).
 *
 * Callers can compare the recovered address to a known operator key to
 * decide whether the proof is "theirs"; we don't enforce that here
 * because some operators sign with a multisig / hardware wallet whose
 * address isn't the same as `FACILITATOR_PRIVATE_KEY`'s.
 */
export function recoverOwnershipProofSigner(
  signature: string,
  publicBaseUrl: string,
): string {
  if (!isValidOwnershipProofFormat(signature)) {
    throw new Error(
      `ownership proof signature is malformed — expected 0x + 130 hex chars, got ${signature.slice(0, 12)}…`,
    );
  }
  const message = buildOwnershipProofMessage(publicBaseUrl);
  return ethers.verifyMessage(message, signature).toLowerCase();
}

/**
 * Produce an ownership-proof signature for a given wallet and public URL.
 * Used by the stand-alone helper script; never called by the running
 * server (the signing key must never be exercised on the request path).
 */
export async function signOwnershipProof(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  publicBaseUrl: string,
): Promise<string> {
  const message = buildOwnershipProofMessage(publicBaseUrl);
  return wallet.signMessage(message);
}

// ═══════════════════════════════════════════════════════════════════════
// Startup validation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Result of the startup validation pass. Callers in `config.ts` log each
 * warning and move on — malformed proofs are a misconfiguration signal but
 * not a hard startup failure, because the operator may still be mid-setup
 * and the discovery surfaces simply won't be published until the proofs
 * become valid.
 */
export interface OwnershipProofValidation {
  /** Proofs that passed the shape + recovery check. */
  valid: string[];
  /** Human-readable warning strings for the operator. */
  warnings: string[];
}

/**
 * Validate a list of ownership proofs against a public base URL at
 * startup.
 *
 * Checks:
 *  - If proofs are non-empty, `publicBaseUrl` must also be set (otherwise
 *    no discovery document can be served and the proofs are dead weight).
 *  - Each proof must match the EIP-191 hex shape.
 *  - Each proof must recover to a valid EVM address under the canonical
 *    message for `publicBaseUrl`.
 *
 * Duplicate signatures and signatures recovering to the same address are
 * allowed (multi-key operators may want one proof per key, even if a few
 * point to the same address after key rotation).
 */
export function validateOwnershipProofs(
  proofs: readonly string[],
  publicBaseUrl: string | undefined,
): OwnershipProofValidation {
  const warnings: string[] = [];
  const valid: string[] = [];

  if (proofs.length > 0 && !publicBaseUrl) {
    warnings.push(
      "OWNERSHIP_PROOFS is set but PUBLIC_BASE_URL is not — discovery documents cannot be served without a canonical URL; set PUBLIC_BASE_URL to enable",
    );
    return { valid, warnings };
  }

  if (!publicBaseUrl) {
    // Nothing to validate — discovery is simply off.
    return { valid, warnings };
  }

  for (const [idx, proof] of proofs.entries()) {
    if (!isValidOwnershipProofFormat(proof)) {
      warnings.push(
        `OWNERSHIP_PROOFS[${idx}] is malformed — expected 0x + 130 hex chars (EIP-191 signature)`,
      );
      continue;
    }
    try {
      const signer = recoverOwnershipProofSigner(proof, publicBaseUrl);
      valid.push(proof);
      // Light informational log so the operator can confirm at a glance
      // which key signed each proof.
      warnings.push(
        `OWNERSHIP_PROOFS[${idx}] recovered to ${signer} (over "${buildOwnershipProofMessage(publicBaseUrl)}")`,
      );
    } catch (err) {
      warnings.push(
        `OWNERSHIP_PROOFS[${idx}] failed signature recovery: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { valid, warnings };
}
