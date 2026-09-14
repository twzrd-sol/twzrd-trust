/**
 * Single source of truth for "is this a Solana network id" inside this package.
 *
 * WHY THIS FILE EXISTS: `facilitator.ts` and `faremeter.ts` each carried a
 * byte-identical private copy of `/^solana([:-]|$)/i`, and that regex does NOT
 * match `"mainnet-beta"` — the exact string `@solana/web3.js` `clusterApiUrl()`
 * and the wallet adapters emit for Solana mainnet.
 *
 * The consequence was not cosmetic. `facilitator.ts` gates on it:
 *
 *   if (solanaOnly && network !== "" && !SOLANA_NETWORK_RE.test(network)) return;
 *
 * so a genuine Solana **mainnet** settlement labelled `"mainnet-beta"` skipped
 * trust scoring entirely and settled ungated. A gate that silently no-ops is
 * worse than no gate: the operator believes they are protected. Our own
 * canonical classifier (`twzrd-x402-gate/src/network.ts`) has always special-
 * cased `"mainnet-beta"` as Solana — the two packages had simply drifted.
 *
 * Kept deliberately as a small mirror rather than a cross-package import:
 * plugin-trustgate does not depend on twzrd-x402-gate, and adding that
 * dependency to fix a predicate would be a heavier change than the bug wants.
 * If you edit this, edit `twzrd-x402-gate/src/network.ts` in the same breath —
 * they are a matched pair, and the test suite pins the shared cases.
 */
/** Cluster monikers Solana tooling emits that carry no "solana" substring. */
const BARE_SOLANA_MONIKERS = new Set(["mainnet-beta", "mainnet", "devnet", "testnet", "localnet"]);
/** Solana mainnet CAIP-2 genesis prefix, as it appears in `solana:5eykt4...`. */
const MAINNET_GENESIS_PREFIX = "5eykt4";
/**
 * True for any Solana network id: CAIP-2 (`solana:5eykt4...`), plain form
 * (`solana`, `solana-devnet`), and the bare cluster monikers above.
 *
 * Intentionally permissive about cluster: callers that must distinguish
 * mainnet from devnet should check `isSolanaMainnet`, not this.
 */
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
/** True only for Solana MAINNET — the one cluster with a production corpus. */
export function isSolanaMainnet(network) {
    const n = String(network ?? "").trim().toLowerCase();
    if (!isSolanaNetwork(n))
        return false;
    if (n.includes("devnet") || n.includes("testnet") || n.includes("localnet"))
        return false;
    return true;
}
