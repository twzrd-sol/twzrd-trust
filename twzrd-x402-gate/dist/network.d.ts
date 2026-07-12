/**
 * Chain-neutral network classification for Path E.
 *
 * Reputation scoring is Solana-deep today. Other networks are *recognized*
 * (we parse them) but not *scored*. Never invent a Base reputation from
 * Solana history or catalog metadata.
 */
export type NetworkKind = "solana" | "evm" | "other" | "unknown";
export type NetworkClass = {
    /** Raw network string from the payment requirement */
    network: string | undefined;
    kind: NetworkKind;
    /** True when TWZRD has behavioral reputation for this network */
    reputationScored: boolean;
    /** True when we recognize the CAIP-2 / x402 network identifier shape */
    networkSupported: boolean;
    reason: string;
};
/**
 * Classify an x402 `accepts[].network` value (optional payTo heuristic).
 *
 * Scored today: Solana mainnet (and generic "solana" / mainnet markers).
 * Recognized but unscored: eip155:* (Base, Polygon, Arbitrum, …).
 *
 * When `network` is omitted (legacy integrators), default to Solana scoring
 * unless `payTo` is a 0x EVM address — never invent Base reputation.
 */
export declare function classifyNetwork(network: string | undefined | null, payTo?: string | null): NetworkClass;
/**
 * Policy action for an unscored (or unsupported) network.
 * - observe (default): allow payment but never claim reputation approval
 * - strict: block before signing
 */
export type UnsupportedNetworkMode = "observe" | "strict";
export type UnsupportedNetworkDecision = {
    /** Never "allow" from intelligence — only policy */
    decision: "unknown";
    reason: string;
    policyAction: "allow" | "block";
    approved: boolean;
    network: string | undefined;
    networkSupported: boolean;
    reputationScored: false;
    kind: NetworkKind;
};
export declare function decideUnsupportedNetwork(cls: NetworkClass, mode: UnsupportedNetworkMode): UnsupportedNetworkDecision;
/** Telemetry-safe log line (no secrets). */
export declare function logUnsupportedNetwork(event: {
    network?: string;
    payTo?: string;
    amountBucket?: string;
    policyMode: UnsupportedNetworkMode;
    policyAction: "allow" | "block";
    adapter?: string;
}): void;
export declare function amountBucket(amountMicro: string | undefined): string;
//# sourceMappingURL=network.d.ts.map