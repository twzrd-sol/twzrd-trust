/**
 * Free merchant card client — wash refuse default for buyer agents.
 *
 * GET /v1/intel/merchant_card/{wallet} is free, no auth. Fail-open: network /
 * non-2xx / invalid JSON → null (do not invent wash_flagged).
 */
export type TwzrdMerchantCard = {
    merchant?: string;
    wash_flagged?: boolean;
    wash_label?: string | null;
    provider_reputation_tier?: string | null;
    in_corpus?: boolean;
    catalog_enriched?: boolean;
    [key: string]: unknown;
};
export declare function fetchMerchantCard(wallet: string, opts: {
    intelBase: string;
    fetch: typeof fetch;
}): Promise<TwzrdMerchantCard | null>;
export type WashPolicyInput = {
    /** Prior approval from readiness / preflight policy */
    approved: boolean;
    reason: string;
    /** From free merchant_card.wash_flagged; null/undefined = signal unavailable */
    washFlagged: boolean | null | undefined;
    /** Resource price in USDC when known */
    priceUsdc?: number | null;
    /**
     * When true (default), refuse payment if washFlagged === true.
     * When false, ignore the wash signal.
     */
    refuseWashFlagged: boolean;
    /**
     * Soft alternative to hard refuse: if wash_flagged and priceUsdc <= washMaxUsdc,
     * allow with reason twzrd_wash_capped. If wash_flagged and price above cap (or
     * price unknown), refuse. Only applies when refuseWashFlagged is true and
     * washMaxUsdc is a finite number >= 0.
     */
    washMaxUsdc?: number | null;
};
export type WashPolicyResult = {
    approved: boolean;
    reason: string;
    washFlagged: boolean | null;
    washCapped?: boolean;
};
/**
 * Pure wash policy. Only tightens: never turns a prior deny into allow.
 * Fail-open on missing wash signal (null/undefined) — no invent.
 */
export declare function applyWashFlaggedPolicy(input: WashPolicyInput): WashPolicyResult;
//# sourceMappingURL=merchant-card.d.ts.map