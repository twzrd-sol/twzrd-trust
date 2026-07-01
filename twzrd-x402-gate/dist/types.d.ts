export type TwzrdDecision = "allow" | "warn" | "block";
export type TwzrdReadinessCard = {
    decision?: TwzrdDecision;
    trust_score?: number;
    can_spend?: boolean;
    proof?: unknown;
    caveats?: string[];
    resource_name?: string;
    seller_wallet?: string;
    /** Live server price for the paid trust receipt (0.05 on current server). */
    full_report_price_usdc?: number;
    /** Paid endpoint path to get a full trust receipt, e.g. /v1/intel/trust/{wallet}. */
    paid_trust_endpoint?: string;
    /**
     * Server-issued preflight id (top-level `preflight_id` in the preflight response,
     * surfaced onto the card by twzrdPreflight). Echoed as `x-twzrd-preflight-id` on the
     * paid /v1/intel/trust call for verify->act funnel attribution.
     */
    preflight_id?: number;
};
export type TwzrdPreflightInput = {
    resource_name: string;
    seller_wallet?: string;
    resource_url?: string;
    price_usdc?: number;
    buyer_wallet?: string;
    agent_intent?: string;
    /** Chain context for the payment. Pass-through for server-side context ("solana", "base", etc.). */
    chain?: string;
};
export type TwzrdGateConfig = {
    /** Base URL without trailing slash. Default: TWZRD_INTEL_BASE or https://intel.twzrd.xyz */
    intelBase?: string;
    /** Block when trust_score is below this. Default: 40 */
    preflightMinScore?: number;
    /** decision values that deny payment. Default: ["block"] */
    blockDecisions?: Iterable<string>;
    /** On preflight HTTP/network failure, approve payment. Default: true */
    failOpen?: boolean;
    /**
     * Deny when the card reports can_spend=false. Default: true.
     * Free-tier preflight returns can_spend=false for most sellers (including
     * well-known ones), so set false to follow the "gate only on decision=block"
     * policy documented for ClawRouter/BlockRun in the twzrd-clawrouter skill.
     */
    gateOnCanSpend?: boolean;
    /** Custom fetch (for tests or non-Node runtimes). Default: global fetch */
    fetch?: typeof fetch;
    /**
     * Called when decision="warn" or score_basis="default_no_data" (unknown seller).
     * Use to trigger the paid receipt fetch (0.05 USDC via /v1/intel/trust).
     * Return value is ignored — this is fire-and-forget for upsell/logging.
     * Example: (ctx) => paidFetch(`https://intel.twzrd.xyz${ctx.upsellUrl}`)
     */
    onWarnUpsell?: (ctx: TwzrdUpsellContext) => void | Promise<void>;
};
export type TwzrdApproveContext = {
    resourceUrl?: string;
    resourceName?: string;
    sellerWallet?: string;
    payTo?: string;
    priceUsdc?: number;
    buyerWallet?: string;
    agentIntent?: string;
    /** Chain context for the payment ("solana", "base", etc.). Pass-through to preflight. */
    chain?: string;
};
export type TwzrdUpsellContext = {
    sellerWallet: string | undefined;
    trustScore: number | null;
    /** Relative path to the paid trust endpoint, e.g. /v1/intel/trust/{wallet} */
    upsellUrl: string;
    /** Actual price read from the server card (0.05 default) */
    priceUsdc: number;
};
export type TwzrdApprovalResult = {
    approved: boolean;
    /** Exact card decision: allow | warn | block. Prefer this over inspecting `approved` for warn. */
    verdict: TwzrdDecision;
    /** card.trust_score or null when unavailable (fail-open path). */
    score: number | null;
    card: TwzrdReadinessCard;
    reason: string;
    /** true when fail-open allowed payment after preflight error */
    failOpen?: boolean;
    /** Server-issued preflight id, threaded from the preflight for verify->act funnel attribution. */
    preflightId?: number;
};
export type X402PaymentRequirements = {
    payTo?: string;
    pay_to?: string;
    maxAmountRequired?: string;
    amount?: string;
    resource?: string;
    description?: string;
    /** x402 wire field for chain context ("solana", "base-sepolia", "base-mainnet", etc.) */
    network?: string;
};
export type X402PaymentRequiredBody = {
    accepts?: Array<Record<string, unknown>>;
    x402Version?: number;
};
export type X402McpPaymentRequest = {
    accepts?: Array<Record<string, unknown>>;
    context?: {
        resource?: string;
        toolName?: string;
        counterparty?: string;
        sellerWallet?: string;
        buyerWallet?: string;
    };
};
//# sourceMappingURL=types.d.ts.map