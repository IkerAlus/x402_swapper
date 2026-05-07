/**
 * Injectable dependency mocks for the settler module.
 *
 * Provides configurable stubs for BroadcastFn, DepositNotifyFn, and
 * StatusPollFn that return realistic values without on-chain or API calls.
 */

import type {
  BroadcastFn,
  BroadcastResult,
  DepositNotifyFn,
  DepositNotifyResult,
  StatusPollFn,
  StatusPollResult,
} from "../payment/settler.js";
import type { ExactEIP3009Payload, ExactPermit2Payload } from "@x402/evm";
import {
  mockDepositNotifyResponse,
  mockHappyPathStatusSequence,
} from "./mock-1cs-responses.js";

// ═══════════════════════════════════════════════════════════════════════
// Broadcast mock
// ═══════════════════════════════════════════════════════════════════════

/** A realistic transaction hash. */
export const MOCK_TX_HASH =
  "0xf1e2d3c4b5a697f8e9d0c1b2a3948576061728394a5b6c7d8e9f0a1b2c3d4e5f";

export interface MockBroadcastOptions {
  /** Transaction hash to return. */
  txHash?: string;
  /** Block number for the confirmed tx. */
  blockNumber?: number;
  /** Gas used by the tx. */
  gasUsed?: bigint;
  /** Facilitator's native token balance (wei). */
  facilitatorBalance?: bigint;
  /** Whether the EIP-3009 nonce is already used. */
  nonceAlreadyUsed?: boolean;
  /** If set, broadcastEIP3009 will throw this error. */
  eip3009Error?: Error;
  /** If set, broadcastPermit2 will throw this error. */
  permit2Error?: Error;
}

/**
 * Create a mock BroadcastFn with configurable behavior.
 *
 * By default, broadcasts succeed with a realistic tx hash and receipt.
 */
export function mockBroadcastFn(
  options: MockBroadcastOptions = {},
): BroadcastFn {
  const {
    txHash = MOCK_TX_HASH,
    blockNumber = 18_500_000,
    gasUsed = 65_000n,
    facilitatorBalance = 1_000_000_000_000_000_000n, // 1 ETH
    nonceAlreadyUsed = false,
    eip3009Error,
    permit2Error,
  } = options;

  const successResult: BroadcastResult = { txHash, blockNumber, gasUsed };

  return {
    async broadcastEIP3009(
      _tokenAddress: string,
      _auth: ExactEIP3009Payload["authorization"],
      _signature: string,
    ): Promise<BroadcastResult> {
      if (eip3009Error) throw eip3009Error;
      return successResult;
    },

    async broadcastPermit2(
      _permit2Auth: ExactPermit2Payload["permit2Authorization"],
      _signature: string,
    ): Promise<BroadcastResult> {
      if (permit2Error) throw permit2Error;
      return successResult;
    },

    async checkAuthorizationState(
      _tokenAddress: string,
      _authorizer: string,
      _nonce: string,
    ): Promise<boolean> {
      return nonceAlreadyUsed;
    },

    async getFacilitatorBalance(): Promise<bigint> {
      return facilitatorBalance;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Deposit notify mock
// ═══════════════════════════════════════════════════════════════════════

export interface MockDepositNotifyOptions {
  /** Custom response to return. */
  response?: DepositNotifyResult;
  /** If set, the notify function will throw this error. */
  error?: Error;
}

/**
 * Create a mock DepositNotifyFn.
 *
 * By default, returns a successful KNOWN_DEPOSIT_TX response.
 */
export function mockDepositNotifyFn(
  options: MockDepositNotifyOptions = {},
): DepositNotifyFn {
  return async (_txHash: string, _depositAddress: string) => {
    if (options.error) throw options.error;
    return options.response ?? mockDepositNotifyResponse();
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Status poll mock
// ═══════════════════════════════════════════════════════════════════════

export interface MockStatusPollOptions {
  /**
   * Sequence of status results to return on each poll call.
   * The last result is repeated for subsequent calls.
   * Default: the happy-path sequence (KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS).
   */
  sequence?: StatusPollResult[];
  /** If set, the poll function will throw this error on every call. */
  error?: Error;
}

/**
 * Create a mock StatusPollFn that returns results from a sequence.
 *
 * By default, uses the happy-path sequence ending in SUCCESS.
 */
export function mockStatusPollFn(
  options: MockStatusPollOptions = {},
): StatusPollFn {
  const sequence = options.sequence ?? mockHappyPathStatusSequence();
  let callIndex = 0;

  return async (_depositAddress: string) => {
    if (options.error) throw options.error;
    const result = sequence[Math.min(callIndex, sequence.length - 1)]!;
    callIndex++;
    return result;
  };
}
