import type { TwzrdGateConfig, TwzrdUpsellContext } from "./types.js";
export type ResolvedTwzrdGateConfig = {
    intelBase: string;
    preflightMinScore: number;
    blockDecisions: Set<string>;
    failOpen: boolean;
    gateOnCanSpend: boolean;
    fetch: typeof fetch;
    onWarnUpsell?: (ctx: TwzrdUpsellContext) => void | Promise<void>;
};
export declare function resolveConfig(overrides?: TwzrdGateConfig): ResolvedTwzrdGateConfig;
//# sourceMappingURL=config.d.ts.map