/**
 * Configurable ChainReader mock for verifier tests.
 *
 * Allows fine-grained control over on-chain read results (balances,
 * allowances, authorization state) without real RPC calls.
 */

import type { ChainReader } from "../payment/verifier.js";
import { CHAIN_ID } from "./mock-config.js";
import { PERMIT2_ADDRESS } from "@x402/evm";

/**
 * Options for configuring the mock chain reader's behavior.
 */
export interface MockChainReaderOptions {
  /** Chain ID to return from getChainId(). Default: 8453 (Base). */
  chainId?: number;

  /** Token balance for balanceOf() calls. Default: very large (passes all checks). */
  tokenBalance?: bigint;

  /** Permit2 allowance for allowance() calls. Default: very large. */
  permit2Allowance?: bigint;

  /** Whether authorizationState returns true (nonce used). Default: false. */
  authorizationNonceUsed?: boolean;

  /** If set, readContract will throw this error. */
  readContractError?: Error;
}

/**
 * Create a mock ChainReader with configurable return values.
 *
 * By default, all checks pass (large balance, large allowance, unused nonce).
 * Override specific options to test failure paths.
 */
export function mockChainReader(
  options: MockChainReaderOptions = {},
): ChainReader {
  const {
    chainId = CHAIN_ID,
    tokenBalance = 100_000_000_000n,       // 100,000 USDC
    permit2Allowance = 100_000_000_000n,   // 100,000 USDC allowance
    authorizationNonceUsed = false,
    readContractError,
  } = options;

  return {
    async readContract(
      _address: string,
      _abi: readonly unknown[],
      method: string,
      args: unknown[],
    ): Promise<unknown> {
      if (readContractError) {
        throw readContractError;
      }

      // Route based on method name
      switch (method) {
        case "balanceOf":
          return tokenBalance;

        case "allowance": {
          // Check if this is a Permit2 allowance check
          const spender = args[1] as string;
          if (spender?.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
            return permit2Allowance;
          }
          return tokenBalance; // Generic allowance
        }

        case "authorizationState":
          return authorizationNonceUsed;

        default:
          return 0n;
      }
    },

    async getChainId(): Promise<number> {
      return chainId;
    },
  };
}

// Convenience wrappers (failingChainReader / zeroBalanceChainReader /
// zeroAllowanceChainReader) used to live here. They were one-liners
// around `mockChainReader({...})` and never imported by any test, so
// they were removed to keep the mock surface honest. Tests that want
// those scenarios can construct them inline — e.g.
//   mockChainReader({ readContractError: new Error("RPC unreachable") })
//   mockChainReader({ tokenBalance: 0n })
//   mockChainReader({ permit2Allowance: 0n })
