/**
 * Chain-neutral network classification for Path E.
 *
 * Reputation scoring is Solana-deep today. Other networks are *recognized*
 * (we parse them) but not *scored*. Never invent a Base reputation from
 * Solana history or catalog metadata.
 */
/**
 * Classify an x402 `accepts[].network` value (optional payTo heuristic).
 *
 * Scored today: Solana mainnet (and generic "solana" / mainnet markers).
 * Recognized but unscored: eip155:* (Base, Polygon, Arbitrum, …).
 *
 * When `network` is omitted (legacy integrators), default to Solana scoring
 * unless `payTo` is a 0x EVM address — never invent Base reputation.
 */
export function classifyNetwork(network, payTo) {
    const raw = network == null ? undefined : String(network).trim();
    if (!raw) {
        const pt = payTo == null ? "" : String(payTo).trim();
        // Explicit EVM payTo without network → unscored EVM
        if (/^0x[a-fA-F0-9]{40}$/.test(pt)) {
            return {
                network: undefined,
                kind: "evm",
                reputationScored: false,
                networkSupported: true,
                reason: "network_not_scored",
            };
        }
        // Legacy default: Solana product surface scores base58 / missing-network payments
        return {
            network: undefined,
            kind: "solana",
            reputationScored: true,
            networkSupported: true,
            reason: "solana_scored",
        };
    }
    const n = raw.toLowerCase();
    // Solana mainnet CAIP-2 genesis, bare "solana", or mainnet keyword.
    const isSolana = n.includes("solana") ||
        n.includes("5eykt4") || // mainnet genesis prefix in CAIP-2
        n === "solana:mainnet" ||
        n === "mainnet-beta";
    if (isSolana) {
        // Devnet/testnet: recognized, not scored (no production corpus).
        if (n.includes("devnet") || n.includes("testnet") || n.includes("localnet")) {
            return {
                network: raw,
                kind: "solana",
                reputationScored: false,
                networkSupported: true,
                reason: "network_not_scored",
            };
        }
        return {
            network: raw,
            kind: "solana",
            reputationScored: true,
            networkSupported: true,
            reason: "solana_scored",
        };
    }
    // EVM CAIP-2 and common aliases (Base, Polygon, Arbitrum, …).
    if (n.startsWith("eip155:") ||
        n === "base" ||
        n.includes("base-mainnet") ||
        n.includes("base-sepolia") ||
        n.includes("polygon") ||
        n.includes("arbitrum") ||
        n.includes("ethereum")) {
        return {
            network: raw,
            kind: "evm",
            reputationScored: false,
            networkSupported: true,
            reason: "network_not_scored",
        };
    }
    return {
        network: raw,
        kind: "other",
        reputationScored: false,
        networkSupported: true,
        reason: "network_not_scored",
    };
}
export function decideUnsupportedNetwork(cls, mode) {
    const policyAction = mode === "strict" ? "block" : "allow";
    return {
        decision: "unknown",
        reason: cls.reason === "network_missing" ? "network_missing" : "network_not_scored",
        policyAction,
        approved: policyAction === "allow",
        network: cls.network,
        networkSupported: cls.networkSupported,
        reputationScored: false,
        kind: cls.kind,
    };
}
/** Telemetry-safe log line (no secrets). */
export function logUnsupportedNetwork(event) {
    try {
        console.info("[twzrd-x402-gate] unsupported_network_seen", JSON.stringify({
            event: "unsupported_network_seen",
            network: event.network ?? null,
            payTo_prefix: event.payTo ? String(event.payTo).slice(0, 8) : null,
            amount_bucket: event.amountBucket ?? null,
            policy_mode: event.policyMode,
            policy_action: event.policyAction,
            adapter: event.adapter ?? null,
        }));
    }
    catch {
        // never throw from telemetry
    }
}
export function amountBucket(amountMicro) {
    if (amountMicro == null || amountMicro === "")
        return "unknown";
    const n = Number(amountMicro);
    if (!Number.isFinite(n))
        return "unknown";
    if (n <= 0)
        return "0";
    if (n < 1000)
        return "<0.001";
    if (n < 10_000)
        return "0.001-0.01";
    if (n < 50_000)
        return "0.01-0.05";
    if (n < 100_000)
        return "0.05-0.10";
    return ">=0.10";
}
//# sourceMappingURL=network.js.map