/**
 * Shared NEP-141 chain-prefix constants and helpers.
 *
 * Used by `config.ts` (startup recipient-format validation), `quote-engine.ts`
 * (runtime diagnosis of 1CS rejections) and `settler.ts` (mapping an OMFT
 * deposit back to its destination chain). Living in their own leaf module
 * keeps every call-site in sync and avoids import cycles.
 *
 * @see https://docs.near-intents.org/resources/asset-support
 */

/**
 * Single source of truth for known NEP-141 OMFT bridge prefixes and the
 * canonical chain identifier they map to.
 *
 * EVM chains map to CAIP-2 `eip155:<chainId>`; non-EVM chains map to a
 * descriptive `<chain>:<network>` identifier used by the settler when
 * building the `destinationChain` field of the x402 settlement extras.
 *
 * Adding a new chain? Just add one entry here — the derived arrays below
 * and every consumer (`config`, `quote-engine`, `settler`) pick it up
 * automatically.
 */
export const NEP141_CHAIN_MAP: Readonly<Record<string, string>> = Object.freeze({
  // EVM chains (values must begin with "eip155:" for the partition below to pick them up)
  eth: "eip155:1",
  base: "eip155:8453",
  arb: "eip155:42161",
  op: "eip155:10",
  polygon: "eip155:137",
  avax: "eip155:43114",
  bsc: "eip155:56",
  turbochain: "eip155:7897",
  gnosis: "eip155:100",
  scroll: "eip155:534352",
  xlayer: "eip155:196",
  berachain: "eip155:80094",
  monad: "eip155:143",
  plasma: "eip155:27",
  // Non-EVM chains
  solana: "solana:mainnet",
  bitcoin: "bitcoin:mainnet",
  litecoin: "litecoin:mainnet",
  dogecoin: "dogecoin:mainnet",
  stellar: "stellar:pubnet",
  xrp: "xrp:mainnet",
  ton: "ton:mainnet",
  tron: "tron:mainnet",
  aptos: "aptos:mainnet",
  sui: "sui:mainnet",
  starknet: "starknet:mainnet",
  aleo: "aleo:mainnet",
  cardano: "cardano:mainnet",
  dash: "dash:mainnet",
  zcash: "zcash:mainnet",
  bch: "bch:mainnet",
});

/**
 * Known NEP-141 chain prefixes that map to EVM chains. Derived from
 * {@link NEP141_CHAIN_MAP} — do not edit directly.
 *
 * When the destination asset uses one of these, the recipient should be
 * a 0x-prefixed EVM address (40 hex chars).
 */
export const EVM_CHAIN_PREFIXES: readonly string[] = Object.freeze(
  Object.entries(NEP141_CHAIN_MAP)
    .filter(([, caip]) => caip.startsWith("eip155:"))
    .map(([prefix]) => prefix),
);

/**
 * Known NEP-141 chain prefixes for non-EVM chains. Derived from
 * {@link NEP141_CHAIN_MAP} — do not edit directly.
 *
 * Recipient format varies per chain (Stellar G…, Solana pubkey, etc.).
 */
export const NON_EVM_CHAIN_PREFIXES: readonly string[] = Object.freeze(
  Object.entries(NEP141_CHAIN_MAP)
    .filter(([, caip]) => !caip.startsWith("eip155:"))
    .map(([prefix]) => prefix),
);

/**
 * Extract the OMFT bridge chain prefix from a NEP-141 asset ID.
 *
 * OMFT-bridged assets always have the shape `<chain>-<address>.omft.near`.
 * Non-OMFT assets (NEAR-native tokens like `usdt.tether-token.near` or
 * `17208628...e36133a1`) have no chain prefix and return `null`.
 *
 * @example
 *   extractChainPrefix("nep141:arb-0xaf88...omft.near")     // "arb"
 *   extractChainPrefix("nep141:stellar-GA5Z...omft.near")   // "stellar"
 *   extractChainPrefix("nep141:usdt.tether-token.near")     // null  (NEAR-native)
 *   extractChainPrefix("nep141:17208628...e36133a1")        // null  (NEAR implicit)
 */
export function extractChainPrefix(asset: string): string | null {
  const body = asset.startsWith("nep141:") ? asset.substring(7) : asset;
  // Only OMFT-bridged assets carry a chain prefix.
  if (!body.endsWith(".omft.near")) return null;
  const hyphenIndex = body.indexOf("-");
  if (hyphenIndex <= 0) return null;
  return body.substring(0, hyphenIndex);
}

/**
 * Heuristic check for a valid NEAR account ID.
 *
 * Accepts two shapes:
 *   - Implicit account: exactly 64 lowercase hex chars
 *   - Named account:    length 2-64, chars `[a-z0-9._-]`, no consecutive or
 *                       leading/trailing separators, ending in `.near` or `.tg`
 *
 * Cannot tell if the account actually exists on-chain — that would require an
 * RPC call. Catches the common typo cases (wrong TLA, spaces, uppercase).
 *
 * @see https://docs.near.org/concepts/protocol/account-id
 */
export function isValidNearAccount(id: string): boolean {
  // Implicit accounts: 64 lowercase hex chars exactly.
  if (/^[a-f0-9]{64}$/.test(id)) return true;

  // Named accounts: 2-64 chars, lowercase alnum + `._-`, no leading/trailing
  // separators, no consecutive separators, must end in a known TLA.
  if (id.length < 2 || id.length > 64) return false;
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(id)) return false;
  if (/[._-]{2,}/.test(id)) return false;
  return /\.(near|tg)$/.test(id);
}

/**
 * True if the asset ID refers to a NEAR-native token — i.e. not an OMFT bridge.
 * This covers:
 *   - Named NEAR contracts: `nep141:usdt.tether-token.near`, `nep141:wrap.near`
 *   - Implicit NEAR accounts: `nep141:17208628...e36133a1`
 */
export function isNearNativeAsset(asset: string): boolean {
  if (extractChainPrefix(asset) !== null) return false; // OMFT → not NEAR-native
  const body = asset.startsWith("nep141:") ? asset.substring(7) : asset;
  // Named token ending in .near OR a 64-char hex implicit account.
  return body.endsWith(".near") || /^[a-f0-9]{64}$/.test(body);
}
