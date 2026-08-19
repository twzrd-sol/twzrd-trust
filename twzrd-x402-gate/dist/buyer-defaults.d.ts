/**
 * Buyer-seat Path A defaults.
 *
 * Facilitator onBeforeSettle stays free (abort on block only). These defaults
 * apply only on the *buyer* install, and only when a paying `x402Fetch` is
 * already wired — refuse-only seats stay free.
 *
 * Ladder (when x402Fetch is present and flags are unset):
 *   block                         → free refuse
 *   warn + price >= $2.50         → $0.05 V6 (requireReceipt)
 *   warn + price <  $2.50         → $0.001 quick re-decide (escalateOnWarn)
 *   allow + price >= $2.50        → $0.05 V6
 *   allow + price <  $2.50        → free proceed
 *
 * Opt out: `requireReceipt: false` and/or `escalateOnWarn: false`.
 */
import type { RequireReceiptPolicy } from "./receipt-policy.js";
/** ROI break-even from productization (0.05 lookup vs ~2% bad rate). */
export declare const DEFAULT_BUYER_MATERIAL_USDC = 2.5;
export declare const DEFAULT_BUYER_REQUIRE_RECEIPT: RequireReceiptPolicy;
export declare const DEFAULT_BUYER_ESCALATE_ON_WARN: {
    minSpendUsdc: number;
};
export type BuyerEscalateOnWarn = false | {
    minSpendUsdc?: number;
    blockBelowScore?: number;
};
export type BuyerPathAFlags = {
    x402Fetch?: typeof fetch;
    requireReceipt?: boolean | RequireReceiptPolicy;
    escalateOnWarn?: BuyerEscalateOnWarn;
};
/**
 * Apply buyer Path A defaults when a paying fetch is present and the caller
 * did not set the flags. No-op without x402Fetch (refuse-only stays free).
 */
export declare function resolveBuyerPathADefaults(opts: BuyerPathAFlags): BuyerPathAFlags;
//# sourceMappingURL=buyer-defaults.d.ts.map