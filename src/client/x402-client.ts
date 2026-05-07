/**
 * x402 Client — orchestrates the full x402 payment protocol from the buyer's side.
 *
 * This module provides a high-level client that handles the complete workflow:
 *
 *   1. Request a protected resource → receive 402 + PAYMENT-REQUIRED
 *   2. Decode the payment requirements
 *   3. Sign a payment authorization (EIP-3009 or Permit2)
 *   4. Retry the request with PAYMENT-SIGNATURE → await settlement → receive 200
 *
 * The client is designed to be testable: HTTP calls go through an injectable
 * `fetch` function, and the signing step uses the `signer` module which
 * accepts any ethers.js Wallet.
 *
 * For swap-as-resource routes, pass the buyer's destination params via the
 * optional `query` option — the same query is sent on the initial 402 request
 * AND on the signed retry, so the URL is stable across the round-trip.
 *
 * @module client/x402-client
 *
 * @example
 * ```ts
 * import { X402Client } from "./client/index.js";
 * import { ethers } from "ethers";
 *
 * const wallet = new ethers.Wallet("0xPrivateKey");
 * const client = new X402Client({ gatewayUrl: "http://localhost:3402" });
 *
 * const result = await client.payAndFetch(wallet, "/api/swap", {
 *   query: {
 *     destinationChain: "near",
 *     destinationAsset: "nep141:...",
 *     destinationAddress: "alice.near",
 *     amountIn: "10000000",
 *   },
 * });
 * if (result.success) {
 *   // The body is `{}` — the swap receipt is in the PAYMENT-RESPONSE header:
 *   const receipt = result.paymentResponse?.extensions?.crossChain;
 *   console.log("Settlement tx:", result.paymentResponse?.transaction);
 *   console.log("Destination tx:", receipt?.destinationTxHashes?.[0]?.hash);
 * }
 * ```
 */

import type { ethers } from "ethers";
import {
  encodePaymentSignatureHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { signPayment } from "./signer.js";
import type {
  X402ClientConfig,
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  PaymentResponse,
  ResourceRequestResult,
  PaymentResult,
  PayAndFetchResult,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Client class
// ═══════════════════════════════════════════════════════════════════════

/**
 * An x402-compliant client that can pay for protected HTTP resources.
 *
 * The client is stateless — each call to `payAndFetch` is independent.
 * Configuration (gateway URL, custom fetch) is set once at construction.
 */
export class X402Client {
  private readonly gatewayUrl: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(config: X402ClientConfig) {
    // Strip trailing slash from gateway URL
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, "");
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  // ── Step 1: Request the resource ──────────────────────────────────

  /**
   * Request a protected resource without any payment header.
   *
   * Returns the 402 payment requirements if payment is needed,
   * or the resource body if the endpoint doesn't require payment.
   *
   * @param path    The resource path (e.g. `"/api/swap"`).
   * @param options Optional `query` — buyer-supplied parameters for swap-as-
   *                resource routes. Auto URL-encoded. Pass the same values
   *                to {@link submitPayment} on retry so the URL is stable.
   */
  async requestResource(
    path: string,
    options?: { query?: Record<string, string> },
  ): Promise<ResourceRequestResult> {
    const url = this.buildUrl(path, options?.query);

    const res = await this._fetch(url);

    if (res.status === 402) {
      const header = res.headers.get("payment-required");
      if (!header) {
        return {
          kind: "error",
          status: 402,
          error: "402 response missing PAYMENT-REQUIRED header",
        };
      }

      try {
        const paymentRequired = decodePaymentRequiredHeader(header) as PaymentRequired;
        return { kind: "payment-required", status: 402, paymentRequired };
      } catch (err) {
        return {
          kind: "error",
          status: 402,
          error: `Failed to decode PAYMENT-REQUIRED header: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    if (res.status === 200) {
      const body = await res.json();
      const responseHeader = res.headers.get("payment-response");
      const paymentResponse = responseHeader
        ? decodePaymentResponseHeader(responseHeader) as PaymentResponse
        : undefined;

      return { kind: "success", status: 200, body, paymentResponse };
    }

    // Unexpected status — read as text first, then try JSON parse
    const rawBody = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
    return {
      kind: "error",
      status: res.status,
      error: `Unexpected HTTP status: ${res.status}`,
      body,
    };
  }

  // ── Step 2: Select payment option ─────────────────────────────────

  /**
   * Select a payment option from the 402 response.
   *
   * Currently picks the first entry from `accepts`. Future versions
   * could implement preference logic (preferred network, method, etc.).
   *
   * @throws If no suitable payment option is found.
   */
  selectPaymentOption(
    paymentRequired: PaymentRequired,
  ): PaymentRequirements {
    if (!paymentRequired.accepts || paymentRequired.accepts.length === 0) {
      throw new Error("No payment options available in 402 response");
    }

    // For v1, pick the first option
    return paymentRequired.accepts[0]!;
  }

  // ── Step 3: Sign the payment ──────────────────────────────────────

  /**
   * Sign a payment authorization for the selected requirements.
   *
   * Uses the buyer's wallet to produce an EIP-712 signature
   * (EIP-3009 or Permit2 depending on the requirements).
   *
   * @param wallet       The buyer's ethers.js Wallet.
   * @param requirements The selected payment option from step 2.
   * @param resourceUrl  The resource URL (optional, included in the payload).
   * @returns The signed PaymentPayload ready for submission.
   */
  async signPayment(
    wallet: ethers.Wallet,
    requirements: PaymentRequirements,
    resourceUrl?: string,
  ): Promise<PaymentPayload> {
    return signPayment(wallet, requirements, resourceUrl);
  }

  // ── Step 4: Submit the signed payment ─────────────────────────────

  /**
   * Submit a signed payment to the gateway.
   *
   * Encodes the payload as a base64 `PAYMENT-SIGNATURE` header and
   * retries the original resource request. Blocks until the gateway
   * completes settlement (typically 30-60 seconds for cross-chain swaps).
   *
   * @param path    The resource path (e.g. `"/api/swap"`).
   * @param payload The signed PaymentPayload from step 3.
   * @param options Optional `query` — must match what was sent in the initial
   *                {@link requestResource} call so the URL is stable across
   *                the round-trip. (The server looks up state by deposit
   *                address from the signature, but a stable URL keeps logs,
   *                proxies, and caches happy.)
   * @returns PaymentResult with the resource body and settlement receipt.
   */
  async submitPayment(
    path: string,
    payload: PaymentPayload,
    options?: { query?: Record<string, string> },
  ): Promise<PaymentResult> {
    const url = this.buildUrl(path, options?.query);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const encoded = encodePaymentSignatureHeader(payload as any);

    const res = await this._fetch(url, {
      headers: { "PAYMENT-SIGNATURE": encoded },
    });

    // Decode PAYMENT-RESPONSE header if present
    const responseHeader = res.headers.get("payment-response");
    let paymentResponse: PaymentResponse | undefined;
    if (responseHeader) {
      try {
        paymentResponse = decodePaymentResponseHeader(responseHeader) as PaymentResponse;
      } catch {
        // Non-fatal — continue processing
      }
    }

    if (res.status === 200) {
      const body = await res.json();
      return {
        success: true,
        status: 200,
        body,
        paymentResponse: paymentResponse!,
      };
    }

    // Payment failed — check PAYMENT-REQUIRED header for structured errors
    let errorMessage: string | undefined;

    const prHeader = res.headers.get("payment-required");
    if (prHeader) {
      try {
        const pr = decodePaymentRequiredHeader(prHeader) as { error?: string };
        if (pr.error) errorMessage = pr.error;
      } catch {
        // Non-fatal
      }
    }

    if (!errorMessage) {
      try {
        const rawBody = await res.text();
        try {
          const errorBody = JSON.parse(rawBody) as Record<string, unknown>;
          errorMessage =
            (errorBody.message as string) ??
            (errorBody.error as string) ??
            undefined;
        } catch {
          // not JSON
        }
      } catch {
        // body already consumed or unreadable
      }
    }

    errorMessage ??= `HTTP ${res.status}`;

    return {
      success: false,
      status: res.status,
      error: errorMessage,
      paymentResponse,
    };
  }

  // ── Complete flow: pay and fetch ──────────────────────────────────

  /**
   * Execute the full x402 payment flow in one call.
   *
   * 1. Requests the resource (expects 402)
   * 2. Selects a payment option
   * 3. Signs the payment with the buyer's wallet
   * 4. Submits the signed payment and awaits settlement
   *
   * This is the primary entry point for most use cases.
   *
   * @param wallet  The buyer's ethers.js Wallet.
   * @param path    The resource path (e.g. `"/api/swap"`).
   * @param options Optional `query` — buyer-supplied parameters for swap-as-
   *                resource routes. Sent on both the initial 402 request and
   *                the signed retry.
   * @returns The resource body and settlement receipt on success.
   */
  async payAndFetch(
    wallet: ethers.Wallet,
    path: string,
    options?: { query?: Record<string, string> },
  ): Promise<PayAndFetchResult> {
    // Step 1: Request the resource
    const resourceResult = await this.requestResource(path, options);

    // If the resource is free, return it directly
    if (resourceResult.kind === "success") {
      return {
        success: true,
        body: resourceResult.body,
        paymentResponse: resourceResult.paymentResponse,
        paymentRequired: { x402Version: 2, resource: { url: path }, accepts: [] },
      };
    }

    // If it's not a payment-required, it's an error
    if (resourceResult.kind === "error") {
      return {
        success: false,
        error: resourceResult.error,
        status: resourceResult.status,
      };
    }

    const paymentRequired = resourceResult.paymentRequired;

    // Check for an error in the 402 (e.g. previous payment rejected)
    if (paymentRequired.error) {
      return {
        success: false,
        error: `Payment rejected: ${paymentRequired.error}`,
        status: 402,
        paymentRequired,
      };
    }

    // Step 2: Select payment option
    let requirements: PaymentRequirements;
    try {
      requirements = this.selectPaymentOption(paymentRequired);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        status: 402,
        paymentRequired,
      };
    }

    // Step 3: Sign the payment
    let payload: PaymentPayload;
    try {
      payload = await this.signPayment(
        wallet,
        requirements,
        paymentRequired.resource?.url,
      );
    } catch (err) {
      return {
        success: false,
        error: `Signing failed: ${err instanceof Error ? err.message : String(err)}`,
        status: 402,
        paymentRequired,
      };
    }

    // Step 4: Submit and await settlement (pass the same query so the URL
    // is stable across the round-trip).
    const paymentResult = await this.submitPayment(path, payload, options);

    if (paymentResult.success) {
      return {
        success: true,
        body: paymentResult.body,
        paymentResponse: paymentResult.paymentResponse,
        paymentRequired,
      };
    }

    return {
      success: false,
      error: paymentResult.error,
      status: paymentResult.status,
      paymentRequired,
      paymentResponse: paymentResult.paymentResponse,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  /**
   * Build a URL from the gateway base, the resource path, and an optional
   * query record. Auto URL-encodes via `URLSearchParams`.
   */
  private buildUrl(path: string, query?: Record<string, string>): string {
    const base = `${this.gatewayUrl}${path}`;
    if (!query || Object.keys(query).length === 0) return base;
    const qs = new URLSearchParams(query).toString();
    return `${base}${path.includes("?") ? "&" : "?"}${qs}`;
  }
}
