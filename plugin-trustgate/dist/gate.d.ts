/**
 * twzrd trust-gate core - dependency-free.
 *
 * Buyer-side x402 spend guard for autonomous agents. Before signing a payment to
 * a seller, call the FREE TWZRD preflight (no auth, no cost) and refuse when the
 * decision is "block" (e.g. a wash-flagged / captive-payer merchant).
 *
 * Fail-closed by default: a preflight outage blocks and logs loudly so the agent
 * is never silently approved by an intel hiccup. Set failOpen=true to opt into
 * legacy fail-open behavior (allow on outage) when liveness > security.
 *
 * No @elizaos/core or @solana/web3.js dependency - usable from any JS runtime.
 */
export type TwzrdDecision = "allow" | "warn" | "block";
export interface TrustGateConfig {
    /** Free preflight host. Default https://intel.twzrd.xyz */
    intelBase?: string;
    /**
     * Also block when trust_score < this, even if decision !== "block". Default 0 (decision-only).
     * Sharp edge: unknown sellers score 45 (default_no_data), so minScore > 45 blocks every
     * not-yet-seen merchant. Use deliberately.
     */
    minScore?: number;
    /** Injectable fetch (tests / non-global-fetch runtimes). Default globalThis.fetch. */
    fetchImpl?: typeof fetch;
    /** ms before the gate gives up on the preflight. Default 4000. */
    timeoutMs?: number;
    /**
     * On a preflight outage: false (default) = block and log loudly (fail-closed).
     * Set to true to opt into legacy fail-open behavior (allow on outage).
     */
    failOpen?: boolean;
}
export interface TrustVerdict {
    sellerWallet: string;
    decision: TwzrdDecision;
    trustScore: number | null;
    canSpend: boolean;
    /** true => DO NOT sign/spend. */
    blocked: boolean;
    reason: string;
    /** false when the preflight was unreachable (the verdict came from the fail-open/closed path). */
    gateAvailable: boolean;
    /** On warn verdict: path to the paid trust receipt endpoint, e.g. /v1/intel/trust/{wallet}. */
    paidDeepDive?: string;
}
/**
 * Score a seller wallet via the free TWZRD preflight. Never throws.
 */
export declare function checkTrust(sellerWallet: string, config?: TrustGateConfig): Promise<TrustVerdict>;
/**
 * Convenience guard: true => safe to sign/spend, false => abort the payment.
 * Respects config.failOpen (default false => block on a preflight outage).
 */
export declare function canSpendSafely(sellerWallet: string, config?: TrustGateConfig): Promise<boolean>;
