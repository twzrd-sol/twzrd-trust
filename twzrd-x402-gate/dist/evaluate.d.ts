import { type TwzrdTier } from "./quick.js";
import type { TwzrdDecision, TwzrdGateConfig, TwzrdReadinessCard, X402PaymentRequirements } from "./types.js";
export type EvaluateX402Options = TwzrdGateConfig & {
    /**
     * When true, automatically fetches the paid TWZRD trust receipt (via x402)
     * after a warn/allow decision. Requires x402Fetch to be provided.
     * Default: false.
     */
    autoReceipt?: boolean;
    /**
     * x402-capable fetch that can settle USDC payments. Used by autoReceipt (the
     * $0.05 receipt) and by escalateOnWarn (the $0.001 quick tier). The caller wires
     * in a Solana wallet + x402 payer.
     */
    x402Fetch?: typeof fetch;
    /**
     * Called immediately after a receipt is captured on-chain.
     * Provides the raw twzrd_receipt object and the settlement tx hash (if present).
     */
    onReceipt?: (receipt: unknown, tx: string | undefined) => void;
    /**
     * Autonomous risk-escalation. When the free preflight is inconclusive
     * (decision="warn" and otherwise proceeding), the gate autonomously settles the
     * cheap $0.001 quick tier and RE-DECIDES on the paid score: below `blockBelowScore`
     * (default: preflightMinScore) the payment is denied (approved=false); at/above it
     * proceeds. The paid call fires from the agent's own risk policy - no human - and
     * the paid signal actually gates the spend (unlike autoReceipt, which is upsell-only
     * and never changes the decision). Opt-in; requires x402Fetch. Fail-soft: if the
     * quick tier cannot answer, the base warn decision is preserved. Only tightens
     * (warn -> maybe block); never loosens a block or allow. Short-circuits the
     * autoReceipt path for the warn case (no double settle).
     */
    escalateOnWarn?: {
        /** Skip escalation when the resource price is below this - don't pay $0.001 to vet a sub-cent buy. Default 0. */
        minSpendUsdc?: number;
        /** Deny when the paid quick score is below this. Default: preflightMinScore (40). */
        blockBelowScore?: number;
    };
};
export type EvaluateX402Result = {
    decision: TwzrdDecision | "unknown";
    trustScore: number | null;
    approved: boolean;
    reason: string;
    card: TwzrdReadinessCard;
    /** true when the preflight was unreachable and fail-open allowed the resource */
    failOpen?: boolean;
    /** URL of the paid TWZRD trust endpoint for this seller (for manual upsell) */
    receiptUrl?: string;
    /** Present when autoReceipt=true and the x402 trust call succeeded */
    receipt?: unknown;
    /** On-chain settlement tx from the receipt payment */
    receiptTx?: string;
    /** true when a fee was captured on-chain */
    receiptFeeCaptured?: boolean;
    /** true when a `warn` triggered an autonomous paid quick-tier re-decision (escalateOnWarn) */
    escalated?: boolean;
    /** the paid quick-tier score that drove the escalated decision; null when the quick tier could not answer */
    escalatedScore?: number | null;
    /** the paid quick-tier label (Bronze/Silver/Gold/Platinum) from the escalation */
    escalatedTier?: TwzrdTier | null;
};
/**
 * Evaluate an x402 resource before the buyer pays:
 *   1. Run free TWZRD preflight on the seller (no auth, no cost).
 *   2. Return decision + trust score.
 *   3. If escalateOnWarn is set and decision=warn: autonomously settle the cheap
 *      $0.001 quick tier and re-decide on the paid score (the autonomous risk loop).
 *   4. Else if autoReceipt=true and decision !== block: auto-fetch the paid TWZRD
 *      trust receipt via x402Fetch (TWZRD earns the receipt fee on-chain).
 *
 * Defaults to gateOnCanSpend=false (decision-only) — the free-tier preflight
 * returns can_spend=false for most unknown sellers, which would block too eagerly
 * on platforms like Agentic.Market where sellers are not yet in the corpus.
 */
export declare function evaluate_x402_resource(resourceUrl: string, paymentRequirements: X402PaymentRequirements, opts?: EvaluateX402Options): Promise<EvaluateX402Result>;
//# sourceMappingURL=evaluate.d.ts.map