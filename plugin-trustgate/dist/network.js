/**
 * Single source of truth for "is this a Solana network id" inside this package.
 *
 * WHY THIS FILE EXISTS: `facilitator.ts` and `faremeter.ts` each carried a
 * byte-identical private copy of `/^solana([:-]|$)/i`, and that regex does NOT
 * match `"mainnet-beta"` — the exact string `@solana/web3.js` `clusterApiUrl()`
 * and the wallet adapters emit for Solana mainnet.
 */
/** Cluster monikers Solana tooling emits that carry no "solana" substring. */
const BARE_SOLANA_MONIKERS = new Set(["mainnet-beta", "mainnet", "devnet", "testnet", "localnet"]);
/** Solana mainnet CAIP-2 genesis prefix, as it appears in `solana:5eykt4...`. */
const MAINNET_GENESIS_PREFIX = "5eykt4";
/** True for CAIP-2, plain-form, and bare Solana cluster identifiers. */
export function isSolanaNetwork(network) {
    const n = String(network ?? "").trim().toLowerCase();
    if (!n)
        return false;
    return (n.startsWith("solana:") ||
        n === "solana" ||
        n.startsWith("solana-") ||
        n.includes(MAINNET_GENESIS_PREFIX) ||
        BARE_SOLANA_MONIKERS.has(n));
}
/** True only for Solana mainnet. */
export function isSolanaMainnet(network) {
    const n = String(network ?? "").trim().toLowerCase();
    if (!isSolanaNetwork(n))
        return false;
    if (n.includes("devnet") || n.includes("testnet") || n.includes("localnet"))
        return false;
    return true;
}
