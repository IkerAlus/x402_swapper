/**
 * Verifier — validates the buyer's x402 payment signature against stored requirements.
 *
 * When the buyer retries a request with a `PAYMENT-SIGNATURE` header, the
 * verifier:
 *
 * 1. Decodes the payment payload to determine the asset transfer method
 *    (EIP-3009 or Permit2)
 * 2. Reconstructs the EIP-712 typed data and recovers the signer address
 * 3. Validates fields: recipient, amount, time bounds
 * 4. Optionally checks on-chain balance and simulates the transfer
 * 5. Updates the state store: phase → VERIFIED, saves paymentPayload + signerAddress
 *
 * The verification logic follows the same algorithm as `@x402/evm`'s
 * `ExactEvmScheme` facilitator, but adapted for ethers.js (the gateway's
 * EVM library) and with gateway-specific state management.
 *
 * **Simplification note:** The spec recommends simulating
 * `transferWithAuthorization` / `x402ExactPermit2Proxy.settle()` via
 * `eth_call` to confirm the transfer won't revert. The current
 * implementation performs signature recovery, field validation, and
 * on-chain balance/allowance checks but **skips the simulation step**.
 * This is acceptable because the settler handles broadcast errors
 * gracefully (D-S3 nonce pre-check + revert handling). Simulation is a
 * defense-in-depth item tracked in `docs/TODO.md`.
 *
 * @module verifier
 */

import { ethers } from "ethers";
import type { GatewayConfig } from "../infra/config.js";
import type {
  StateStore,
  PaymentPayloadRecord,
  PaymentRequirementsRecord,
} from "../types.js";
import {
  isEIP3009Payload,
  isPermit2Payload,
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
  authorizationTypes,
  permit2WitnessTypes,
  eip3009ABI,
  erc20AllowanceAbi,
} from "@x402/evm";
import type {
  ExactEIP3009Payload,
  ExactPermit2Payload,
  ExactEvmPayloadV2,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Result of a successful payment verification.
 */
export interface VerifyResult {
  /** Whether the payment payload is valid. */
  valid: boolean;
  /** Human-readable reason if validation failed. */
  error?: string;
  /** The EVM address that signed the payment (recovered from the signature). */
  signerAddress?: string;
}

/**
 * Injectable interface for on-chain RPC operations.
 *
 * In production this is backed by an ethers.js `JsonRpcProvider`.
 * In tests it can be replaced with a stub to avoid real RPC calls.
 */
export interface ChainReader {
  /**
   * Read from a contract. Used for balance checks and allowance verification.
   *
   * @param address Contract address.
   * @param abi     ABI fragment for the function.
   * @param method  Function name to call.
   * @param args    Call arguments.
   * @returns The decoded return value.
   */
  readContract(
    address: string,
    abi: readonly unknown[],
    method: string,
    args: unknown[],
  ): Promise<unknown>;

  /**
   * Get the current chain ID. Used to reconstruct EIP-712 domains.
   */
  getChainId(): Promise<number>;
}

/**
 * Configuration for the verifier, beyond the base GatewayConfig.
 */
export interface VerifierOptions {
  /**
   * If true, skip on-chain balance and allowance checks.
   * Useful for testing or when the provider is unavailable.
   * @default false
   */
  skipOnChainChecks?: boolean;
}

/**
 * Verify a buyer's payment payload against stored payment requirements.
 *
 * This is the main entry point for the verifier module. It:
 * 1. Looks up the SwapState from the store using the payload's `payTo` field
 * 2. Validates the payment signature and fields
 * 3. On success, transitions the state to VERIFIED
 *
 * @param paymentPayload  The decoded buyer payload from the PAYMENT-SIGNATURE header.
 * @param store           State persistence layer.
 * @param chainReader     Injectable chain reader for on-chain checks.
 * @param cfg             Validated gateway configuration.
 * @param options         Optional verifier configuration.
 *
 * @returns VerifyResult with `valid: true` + `signerAddress`, or `valid: false` + `error`.
 */
export async function verifyPayment(
  paymentPayload: PaymentPayloadRecord,
  store: StateStore,
  chainReader: ChainReader,
  cfg: GatewayConfig,
  options: VerifierOptions = {},
): Promise<VerifyResult> {
  // ── 1. Look up the stored state by deposit address (payTo) ────────
  const depositAddress = paymentPayload.accepted.payTo;
  const storedState = await store.get(depositAddress);

  if (!storedState) {
    return {
      valid: false,
      error: `No swap state found for deposit address: ${depositAddress}`,
    };
  }

  // ── 2. Check state phase ──────────────────────────────────────────
  if (storedState.phase !== "QUOTED") {
    // If already settled, return cached success
    if (storedState.phase === "SETTLED") {
      return {
        valid: true,
        signerAddress: storedState.signerAddress,
      };
    }
    // If already verified or in-progress, reject duplicate
    if (storedState.phase === "VERIFIED" || storedState.phase === "BROADCASTING" ||
        storedState.phase === "BROADCAST" || storedState.phase === "POLLING") {
      return {
        valid: false,
        error: `Swap already in progress (phase: ${storedState.phase})`,
      };
    }
    // FAILED or EXPIRED
    return {
      valid: false,
      error: `Swap is in terminal state: ${storedState.phase}`,
    };
  }

  // ── 3. Check quote deadline hasn't expired ────────────────────────
  const quoteDeadline = storedState.quoteResponse.quote.deadline;
  if (quoteDeadline) {
    const deadlineMs = new Date(quoteDeadline).getTime();
    if (Date.now() > deadlineMs) {
      // Transition to EXPIRED
      await store.update(depositAddress, {
        phase: "EXPIRED",
        error: "Quote deadline expired before verification",
      });
      return {
        valid: false,
        error: "Quote deadline has expired. Request a fresh quote.",
      };
    }
  }

  // ── 4. Validate the payment payload matches stored requirements ───
  const storedReqs = storedState.paymentRequirements;
  const matchError = validateRequirementsMatch(paymentPayload.accepted, storedReqs);
  if (matchError) {
    return { valid: false, error: matchError };
  }

  // ── 5. Decode and verify the signature ────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload: ExactEvmPayloadV2 = paymentPayload.payload as unknown as ExactEvmPayloadV2;

  let result: VerifyResult;
  if (isEIP3009Payload(payload)) {
    result = await verifyEIP3009(
      payload,
      storedReqs,
      chainReader,
      cfg,
      options,
    );
  } else if (isPermit2Payload(payload)) {
    result = await verifyPermit2(
      payload,
      storedReqs,
      chainReader,
      cfg,
      options,
    );
  } else {
    return {
      valid: false,
      error: "Unrecognized payload format: missing both 'authorization' and 'permit2Authorization'",
    };
  }

  // ── 6. On success, update state to VERIFIED ───────────────────────
  if (result.valid && result.signerAddress) {
    await store.update(depositAddress, {
      phase: "VERIFIED",
      paymentPayload: paymentPayload,
      signerAddress: result.signerAddress,
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// EIP-3009 verification
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verify an EIP-3009 `transferWithAuthorization` payment.
 *
 * Algorithm (mirrors `@x402/evm` ExactEvmScheme):
 * 1. Extract authorization fields (from, to, value, validAfter, validBefore, nonce)
 * 2. Reconstruct the EIP-712 domain for the token contract
 * 3. Verify the signature recovers to `authorization.from`
 * 4. Check `to` matches the deposit address (payTo)
 * 5. Check `value` >= required amount
 * 6. Check time bounds: validAfter < now < validBefore
 * 7. Optionally: check on-chain balance
 */
async function verifyEIP3009(
  payload: ExactEIP3009Payload,
  requirements: PaymentRequirementsRecord,
  chainReader: ChainReader,
  cfg: GatewayConfig,
  options: VerifierOptions,
): Promise<VerifyResult> {
  const auth = payload.authorization;

  // ── Field validation ──────────────────────────────────────────────

  // Check recipient matches payTo (deposit address)
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return {
      valid: false,
      error: `Authorization recipient mismatch: expected ${requirements.payTo}, got ${auth.to}`,
    };
  }

  // Check amount is sufficient
  if (BigInt(auth.value) < BigInt(requirements.amount)) {
    return {
      valid: false,
      error: `Authorization amount too low: need ${requirements.amount}, got ${auth.value}`,
    };
  }

  // Check time bounds
  const nowSec = Math.floor(Date.now() / 1000);

  // validAfter must be in the past (with tolerance matching x402/evm: -600s)
  const validAfter = Number(auth.validAfter);
  if (validAfter > nowSec + 600) {
    return {
      valid: false,
      error: `Authorization not yet valid: validAfter=${auth.validAfter} is in the future`,
    };
  }

  // validBefore must be in the future (with tolerance matching x402/evm: +6s)
  const validBefore = Number(auth.validBefore);
  if (validBefore < nowSec - 6) {
    return {
      valid: false,
      error: `Authorization expired: validBefore=${auth.validBefore} is in the past`,
    };
  }

  // ── Signature verification ────────────────────────────────────────

  // Extract the signature
  const signature = payload.signature ?? extractSignatureFromAuth(auth);
  if (!signature) {
    return {
      valid: false,
      error: "No signature found in EIP-3009 payload",
    };
  }

  // Reconstruct the EIP-712 domain for the token contract
  const chainId = extractChainId(requirements.network);
  const extraRecord = requirements.extra as Record<string, unknown> | undefined;
  const domain: ethers.TypedDataDomain = {
    name: (typeof extraRecord?.name === "string" ? extraRecord.name : undefined) ?? cfg.tokenName,
    version: (typeof extraRecord?.version === "string" ? extraRecord.version : undefined) ?? cfg.tokenVersion,
    chainId,
    verifyingContract: requirements.asset,
  };

  // The EIP-712 types for TransferWithAuthorization
  const types = {
    TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
      (field) => ({ name: field.name, type: field.type }),
    ),
  };

  // The message to verify
  const message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value).toString(),
    validAfter: BigInt(auth.validAfter).toString(),
    validBefore: BigInt(auth.validBefore).toString(),
    nonce: auth.nonce,
  };

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyTypedData(domain, types, message, signature);
  } catch (err) {
    return {
      valid: false,
      error: `Signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Check recovered address matches authorization.from
  if (recoveredAddress.toLowerCase() !== auth.from.toLowerCase()) {
    return {
      valid: false,
      error: `Signer mismatch: signature recovers to ${recoveredAddress}, expected ${auth.from}`,
    };
  }

  // ── On-chain checks (optional) ────────────────────────────────────
  if (!options.skipOnChainChecks) {
    const balanceError = await checkERC20Balance(
      chainReader,
      requirements.asset,
      auth.from,
      BigInt(auth.value),
    );
    if (balanceError) {
      return { valid: false, error: balanceError };
    }
  }

  return {
    valid: true,
    signerAddress: recoveredAddress,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Permit2 verification
// ═══════════════════════════════════════════════════════════════════════

/**
 * Verify a Permit2 `permitWitnessTransferFrom` payment.
 *
 * Algorithm (mirrors `@x402/evm` ExactEvmScheme):
 * 1. Extract permit2Authorization fields
 * 2. Verify spender is the x402ExactPermit2ProxyAddress
 * 3. Reconstruct the Permit2 EIP-712 domain (fixed: name="Permit2", verifyingContract=PERMIT2_ADDRESS)
 * 4. Verify the signature recovers to `permit2Authorization.from`
 * 5. Check witness.to matches the deposit address (payTo)
 * 6. Check permitted.token matches the required asset
 * 7. Check permitted.amount >= required amount
 * 8. Check time bounds: witness.validAfter < now, deadline > now
 * 9. Optionally: check on-chain Permit2 allowance
 */
async function verifyPermit2(
  payload: ExactPermit2Payload,
  requirements: PaymentRequirementsRecord,
  chainReader: ChainReader,
  _cfg: GatewayConfig,
  options: VerifierOptions,
): Promise<VerifyResult> {
  const p2auth = payload.permit2Authorization;

  // ── Field validation ──────────────────────────────────────────────

  // Spender must be the x402 Permit2 proxy
  if (p2auth.spender.toLowerCase() !== x402ExactPermit2ProxyAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Permit2 spender mismatch: expected ${x402ExactPermit2ProxyAddress}, got ${p2auth.spender}`,
    };
  }

  // Token must match the required asset
  if (p2auth.permitted.token.toLowerCase() !== requirements.asset.toLowerCase()) {
    return {
      valid: false,
      error: `Permit2 token mismatch: expected ${requirements.asset}, got ${p2auth.permitted.token}`,
    };
  }

  // Check recipient in witness matches payTo (deposit address)
  if (p2auth.witness.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return {
      valid: false,
      error: `Permit2 witness.to mismatch: expected ${requirements.payTo}, got ${p2auth.witness.to}`,
    };
  }

  // Check amount is sufficient
  if (BigInt(p2auth.permitted.amount) < BigInt(requirements.amount)) {
    return {
      valid: false,
      error: `Permit2 amount too low: need ${requirements.amount}, got ${p2auth.permitted.amount}`,
    };
  }

  // Check time bounds
  const nowSec = Math.floor(Date.now() / 1000);

  // validAfter must be in the past (with tolerance: -600s)
  const validAfter = Number(p2auth.witness.validAfter);
  if (validAfter > nowSec + 600) {
    return {
      valid: false,
      error: `Permit2 not yet valid: validAfter=${p2auth.witness.validAfter} is in the future`,
    };
  }

  // deadline must be in the future (with tolerance: +6s)
  const deadline = Number(p2auth.deadline);
  if (deadline < nowSec - 6) {
    return {
      valid: false,
      error: `Permit2 deadline expired: deadline=${p2auth.deadline} is in the past`,
    };
  }

  // ── Signature verification ────────────────────────────────────────

  // Permit2 uses a fixed EIP-712 domain
  const chainId = extractChainId(requirements.network);
  const domain: ethers.TypedDataDomain = {
    name: "Permit2",
    verifyingContract: PERMIT2_ADDRESS,
    chainId,
  };

  // The EIP-712 types for PermitWitnessTransferFrom (from @x402/evm)
  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [key, fields] of Object.entries(permit2WitnessTypes)) {
    types[key] = (fields as unknown as Array<{ name: string; type: string }>).map((f) => ({
      name: f.name,
      type: f.type,
    }));
  }

  // The message to verify
  const message = {
    permitted: {
      token: p2auth.permitted.token,
      amount: BigInt(p2auth.permitted.amount).toString(),
    },
    spender: p2auth.spender,
    nonce: BigInt(p2auth.nonce).toString(),
    deadline: BigInt(p2auth.deadline).toString(),
    witness: {
      to: p2auth.witness.to,
      validAfter: BigInt(p2auth.witness.validAfter).toString(),
    },
  };

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyTypedData(domain, types, message, payload.signature);
  } catch (err) {
    return {
      valid: false,
      error: `Permit2 signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Check recovered address matches permit2Authorization.from
  if (recoveredAddress.toLowerCase() !== p2auth.from.toLowerCase()) {
    return {
      valid: false,
      error: `Permit2 signer mismatch: signature recovers to ${recoveredAddress}, expected ${p2auth.from}`,
    };
  }

  // ── On-chain checks (optional) ────────────────────────────────────
  if (!options.skipOnChainChecks) {
    // Check buyer's ERC-20 balance
    const balanceError = await checkERC20Balance(
      chainReader,
      requirements.asset,
      p2auth.from,
      BigInt(p2auth.permitted.amount),
    );
    if (balanceError) {
      return { valid: false, error: balanceError };
    }

    // Check buyer's Permit2 allowance
    const allowanceError = await checkPermit2Allowance(
      chainReader,
      requirements.asset,
      p2auth.from,
      BigInt(p2auth.permitted.amount),
    );
    if (allowanceError) {
      return { valid: false, error: allowanceError };
    }
  }

  return {
    valid: true,
    signerAddress: recoveredAddress,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// On-chain checks
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check that the buyer has sufficient ERC-20 balance for the transfer.
 *
 * @returns Error message if balance is insufficient, or null if OK.
 */
async function checkERC20Balance(
  chainReader: ChainReader,
  tokenAddress: string,
  ownerAddress: string,
  requiredAmount: bigint,
): Promise<string | null> {
  try {
    const balance = await chainReader.readContract(
      tokenAddress,
      eip3009ABI, // contains balanceOf
      "balanceOf",
      [ownerAddress],
    );
    const balanceBn = BigInt(balance as bigint);
    if (balanceBn < requiredAmount) {
      return `Insufficient token balance: need ${requiredAmount.toString()}, have ${balanceBn.toString()}`;
    }
    return null;
  } catch {
    // Non-fatal: log but don't reject the payment
    return null;
  }
}

/**
 * Check that the buyer has approved Permit2 to spend their tokens.
 *
 * @returns Error message if allowance is insufficient, or null if OK.
 */
async function checkPermit2Allowance(
  chainReader: ChainReader,
  tokenAddress: string,
  ownerAddress: string,
  requiredAmount: bigint,
): Promise<string | null> {
  try {
    const allowance = await chainReader.readContract(
      tokenAddress,
      erc20AllowanceAbi,
      "allowance",
      [ownerAddress, PERMIT2_ADDRESS],
    );
    const allowanceBn = BigInt(allowance as bigint);
    if (allowanceBn < requiredAmount) {
      return `Insufficient Permit2 allowance: need ${requiredAmount.toString()}, have ${allowanceBn.toString()}`;
    }
    return null;
  } catch {
    // Non-fatal: Permit2 might use signature-based nonces instead of allowances
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract the numeric chain ID from a CAIP-2 network string.
 *
 * @example extractChainId("eip155:8453") → 8453
 */
export function extractChainId(network: string): number {
  const parts = network.split(":");
  if (parts.length !== 2 || parts[0] !== "eip155") {
    throw new Error(`Unsupported network format: ${network}. Expected eip155:<chainId>`);
  }
  const chainId = parseInt(parts[1]!, 10);
  if (isNaN(chainId)) {
    throw new Error(`Invalid chain ID in network: ${network}`);
  }
  return chainId;
}

/**
 * Validate that the buyer's `accepted` requirements match the stored requirements.
 *
 * The buyer includes a copy of the `PaymentRequirements` in their payload
 * (the `accepted` field). We check that key fields match what we stored.
 */
export function validateRequirementsMatch(
  accepted: PaymentRequirementsRecord,
  stored: PaymentRequirementsRecord,
): string | null {
  if (accepted.scheme !== stored.scheme) {
    return `Scheme mismatch: expected ${stored.scheme}, got ${accepted.scheme}`;
  }
  if (accepted.network !== stored.network) {
    return `Network mismatch: expected ${stored.network}, got ${accepted.network}`;
  }
  if (accepted.asset.toLowerCase() !== stored.asset.toLowerCase()) {
    return `Asset mismatch: expected ${stored.asset}, got ${accepted.asset}`;
  }
  if (accepted.payTo.toLowerCase() !== stored.payTo.toLowerCase()) {
    return `PayTo mismatch: expected ${stored.payTo}, got ${accepted.payTo}`;
  }
  // Amount: buyer can pay more than required but not less
  if (BigInt(accepted.amount) < BigInt(stored.amount)) {
    return `Amount too low: need at least ${stored.amount}, got ${accepted.amount}`;
  }
  return null;
}

/**
 * Try to extract a signature from an EIP-3009 authorization when the
 * top-level `signature` field is not present.
 *
 * Some x402 clients put the signature directly on the authorization
 * object rather than at the top level. This is a fallback.
 *
 * Exported (not part of the public library barrel) so the settler can
 * reuse the same extraction logic without a duplicate definition.
 */
export function extractSignatureFromAuth(
  auth: ExactEIP3009Payload["authorization"],
): `0x${string}` | undefined {
  // Check if the authorization has a signature field (non-standard but possible)
  const authAny = auth as Record<string, unknown>;
  if (typeof authAny.signature === "string" && authAny.signature.startsWith("0x")) {
    return authAny.signature as `0x${string}`;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// ethers.js ChainReader adapter
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a {@link ChainReader} from an ethers.js `Provider`.
 *
 * This is the production adapter. For tests, create a mock ChainReader directly.
 */
export function createChainReader(provider: ethers.Provider): ChainReader {
  return {
    async readContract(
      address: string,
      abi: readonly unknown[],
      method: string,
      args: unknown[],
    ): Promise<unknown> {
      const contract = new ethers.Contract(
        address,
        abi as ethers.InterfaceAbi,
        provider,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const fn = contract.getFunction(method);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
      return fn(...args);
    },

    async getChainId(): Promise<number> {
      const network = await provider.getNetwork();
      return Number(network.chainId);
    },
  };
}
