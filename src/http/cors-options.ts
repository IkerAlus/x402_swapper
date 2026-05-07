import type { CorsOptions } from "cors";
import type { GatewayConfig } from "../infra/config.js";

/**
 * Build CORS options for the gateway.
 *
 * - `origin: cfg.allowedOrigins ?? true` — if an allowlist is provided, restrict to it;
 *   otherwise reflect the caller's origin (`true` is safer than `"*"` because it
 *   works with credentials).
 * - `exposedHeaders` is mandatory: without it browsers silently hide the x402
 *   `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` headers from client JS, breaking the protocol.
 * - `allowedHeaders` declares that preflight must accept `PAYMENT-SIGNATURE`
 *   (the custom request header carrying the EIP-712 signature).
 */
export function buildCorsOptions(cfg: Pick<GatewayConfig, "allowedOrigins">): CorsOptions {
  return {
    origin: cfg.allowedOrigins ?? true,
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE"],
    methods: ["GET", "POST", "OPTIONS"],
  };
}
