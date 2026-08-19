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
/** ROI break-even from productization (0.05 lookup vs ~2% bad rate). */
export const DEFAULT_BUYER_MATERIAL_USDC = 2.5;
export const DEFAULT_BUYER_REQUIRE_RECEIPT = {
    minSpendUsdc: DEFAULT_BUYER_MATERIAL_USDC,
    onWarn: true,
    hard: true,
    materialWarnOnly: true,
};
export const DEFAULT_BUYER_ESCALATE_ON_WARN = {
    minSpendUsdc: 0,
};
/**
 * Apply buyer Path A defaults when a paying fetch is present and the caller
 * did not set the flags. No-op without x402Fetch (refuse-only stays free).
 */
export function resolveBuyerPathADefaults(opts) {
    if (typeof opts.x402Fetch !== "function")
        return opts;
    const next = { ...opts };
    if (opts.requireReceipt === undefined) {
        next.requireReceipt = { ...DEFAULT_BUYER_REQUIRE_RECEIPT };
    }
    if (opts.escalateOnWarn === undefined) {
        next.escalateOnWarn = { ...DEFAULT_BUYER_ESCALATE_ON_WARN };
    }
    return next;
}
//# sourceMappingURL=buyer-defaults.js.map