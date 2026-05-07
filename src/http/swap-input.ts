/**
 * Buyer-supplied swap input — Zod runtime validator + JSON Schema mirror.
 *
 * The validator parses raw `req.query` (all values arrive as strings)
 * into a typed {@link SwapRequestInput}. The JSON Schema mirror is what
 * the 402 envelope and `/openapi.json` advertise to discovery clients;
 * keep the two in sync — tests in `swap-input.test.ts` enforce this.
 *
 * @module swap-input
 */

import { z } from "zod";
import type { SwapRequestInput } from "../types.js";

/**
 * Zod validator for the swap-route query string.
 *
 * Format rules deliberately mirror what `diagnoseQuoteRequest` would
 * later catch (digit-only `amountIn`, `0x` for EVM refund addresses,
 * `nep141:` prefix for asset IDs). Catching them here gives the buyer
 * a clean 400 with a per-field path, instead of a 503 that surfaces
 * via the 1CS SDK's error path.
 */
export const SwapRequestInputSchema: z.ZodType<SwapRequestInput> = z.object({
  destinationChain: z
    .string()
    .min(1, "destinationChain is required")
    .regex(/^[a-z0-9-]+$/, "destinationChain must be a chain prefix (lowercase, hyphens allowed)"),
  destinationAsset: z
    .string()
    .min(1, "destinationAsset is required")
    .regex(/^nep141:/, "destinationAsset must be a NEP-141 asset ID (start with 'nep141:')"),
  destinationAddress: z.string().min(1, "destinationAddress is required"),
  amountIn: z
    .string()
    .regex(/^[1-9]\d*$/, "amountIn must be a positive integer in the origin asset's smallest unit"),
  refundAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "refundAddress must be a valid EVM address (0x + 40 hex chars)")
    .optional(),
});

/**
 * JSON Schema mirror — used in OpenAPI's per-operation `parameters` array
 * (one query parameter per top-level property) and in the 402 envelope's
 * `extensions.bazaar.info.inputSchema` for x402scan invocability.
 *
 * Kept flat (no nested objects) so it serialises cleanly as query params.
 * Kept hand-written (rather than auto-generated from the Zod schema) for
 * readability — the swap input is small and unlikely to change often.
 */
export const SwapRequestInputJsonSchema: Record<string, unknown> = {
  type: "object",
  required: ["destinationChain", "destinationAsset", "destinationAddress", "amountIn"],
  additionalProperties: false,
  properties: {
    destinationChain: {
      type: "string",
      pattern: "^[a-z0-9-]+$",
      description: "Chain prefix the buyer wants to receive on (e.g. 'near', 'arbitrum', 'solana').",
    },
    destinationAsset: {
      type: "string",
      pattern: "^nep141:",
      description: "1CS NEP-141 asset ID the buyer wants to receive (e.g. 'nep141:...').",
    },
    destinationAddress: {
      type: "string",
      description: "Buyer's recipient on the destination chain. Format depends on chain.",
    },
    amountIn: {
      type: "string",
      pattern: "^[1-9]\\d*$",
      description: "Origin amount the buyer is paying, in the smallest unit (digit-only string).",
    },
    refundAddress: {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description:
        "Optional EVM refund address. When omitted, refunds fall back to the gateway's wallet and the operator forwards manually.",
    },
  },
};
