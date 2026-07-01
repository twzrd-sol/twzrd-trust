import { type ResolvedTwzrdGateConfig } from "./config.js";
import type { TwzrdApprovalResult, TwzrdApproveContext, TwzrdPreflightInput, TwzrdReadinessCard } from "./types.js";
export type PolicyEvaluateInput = {
    card: TwzrdReadinessCard;
    preflightMinScore: number;
    blockDecisions: Set<string>;
    /** Deny on can_spend=false. Default FALSE when omitted (decision-only gating). */
    gateOnCanSpend?: boolean;
};
/**
 * Pure policy — no network. Mirrors scripts/twzrd_gate_agentcash_fetch.sh semantics.
 */
export declare function evaluateReadinessCard(input: PolicyEvaluateInput): TwzrdApprovalResult;
export declare function buildPreflightInput(context: TwzrdApproveContext): TwzrdPreflightInput;
export declare function twzrdPreflight(input: TwzrdPreflightInput, config?: ResolvedTwzrdGateConfig): Promise<TwzrdReadinessCard>;
export declare function twzrdApprovePayment(context: TwzrdApproveContext, config?: ResolvedTwzrdGateConfig): Promise<TwzrdApprovalResult>;
//# sourceMappingURL=policy.d.ts.map