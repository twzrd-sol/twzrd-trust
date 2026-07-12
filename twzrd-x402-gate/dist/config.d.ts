import type { TwzrdGateConfig, TwzrdUpsellContext } from "./types.js";
export type ResolvedTwzrdGateConfig = {
    intelBase: string;
    preflightMinScore: number;
    blockDecisions: Set<string>;
    failOpen: boolean;
    gateOnCanSpend: boolean;
    /** Default true: refuse when free merchant_card.wash_flagged */
    refuseWashFlagged: boolean;
    /** Soft cap USDC when wash_flagged; null = hard refuse */
    washMaxUsdc: number | null;
    /**
     * Unscored-network policy (Base/EVM/…). Default observe.
     * @see UnsupportedNetworkMode in network.ts
     */
    unsupportedNetworkMode: "observe" | "strict";
    fetch: typeof fetch;
    onWarnUpsell?: (ctx: TwzrdUpsellContext) => void | Promise<void>;
    /** Opt-in preflight run attribution (see TwzrdGateConfig.attribution). */
    attribution?: {
        integration: string;
        runId: string;
    };
};
export declare function resolveConfig(overrides?: TwzrdGateConfig): ResolvedTwzrdGateConfig;
//# sourceMappingURL=config.d.ts.map