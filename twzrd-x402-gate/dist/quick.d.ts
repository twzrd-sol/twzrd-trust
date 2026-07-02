/**
 * twzrd quick tier — the $0.001 cheap paid qualify rung.
 *
 * The reputation ladder has three rungs:
 *   free   POST /v1/intel/preflight          -> allow/warn/block (the gate)
 *   $0.001 GET  /v1/intel/quick/{seller}      -> tier + score, NO receipt  <-- this file
 *   $0.05  GET  /v1/intel/trust/{seller}      -> full intel + signed V6 receipt (autoReceipt)
 *
 * Use `quickCheck` when the free preflight is inconclusive (warn / unknown seller)
 * and you want a cheap PAID confirmation of tier+score before committing — without
 * paying 50x for the full portable receipt. It settles $0.001 USDC to TWZRD via the
 * caller-supplied x402Fetch (same BYO-wallet seam as autoReceipt; @x402/svm etc.).
 *
 * FAIL-SOFT: this is an enrichment, not a gate — it NEVER throws. Any gap (no
 * x402Fetch, unreachable, non-200, settle failure) returns available=false with the
 * raw reason, so a quick-tier hiccup can't break the caller's flow. (The hard
 * allow/warn/block decision is the free preflight's job; see gate.ts.)
 */
import type { TwzrdGateConfig } from "./types.js";
export type TwzrdTier = "Bronze" | "Silver" | "Gold" | "Platinum";
/** Server price for the quick tier (AMOUNT_TEASER = "1000" micro = $0.001). */
export declare const QUICK_PRICE_USDC = 0.001;
export interface QuickCheckResult {
    sellerWallet: string;
    /** Bronze <40, Silver >=40, Gold >=100, Platinum >=180 (server thresholds). */
    tier: TwzrdTier | null;
    score: number | null;
    payments: number | null;
    lastSeen: string | null;
    /** true when the $0.001 settle landed and data came back. */
    paid: boolean;
    chargedUsdc: number | null;
    /** false when the quick endpoint could not produce an answer (fail-soft path). */
    available: boolean;
    reason: string;
}
export type QuickCheckOptions = Pick<TwzrdGateConfig, "intelBase" | "fetch"> & {
    /** x402-capable fetch that settles the $0.001 quick charge. Without it: available=false. */
    x402Fetch?: typeof fetch;
    /** ms before the quick call gives up. Default 5000. */
    timeoutMs?: number;
};
/**
 * $0.001 paid tier+score check for a seller wallet. Never throws (fail-soft).
 * Requires an x402-capable `x402Fetch` to settle the charge.
 */
export declare function quickCheck(sellerWallet: string, opts?: QuickCheckOptions): Promise<QuickCheckResult>;
//# sourceMappingURL=quick.d.ts.map