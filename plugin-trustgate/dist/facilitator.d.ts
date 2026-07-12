/**
 * twzrd trust-gate - facilitator-side `onBeforeSettle` hook.
 *
 * "Be in the settle path": register this hook on a self-hostable x402 facilitator
 * so EVERY settlement it brokers is screened against the free TWZRD preflight
 * before the on-chain transfer fires. Agents walking that facilitator's settle
 * path get trust by default - they never have to discover the TWZRD endpoint.
 *
 * Matches the `daydreamsai/facilitator` (@x402/core) hook contract:
 *   onBeforeSettle(ctx) => void            // allow the settle
 *   onBeforeSettle(ctx) => { abort, reason} // abort the settle
 *
 * The context type is declared STRUCTURALLY (only the fields we read) so this
 * stays dependency-free - no @x402/core / @daydreamsai/* import, nothing to drift
 * if the facilitator bumps its internal types.
 *
 * Two correctness rules baked in:
 *   1. Solana-only: the TWZRD corpus is Solana. Only gate settles whose CAIP-2
 *      network is `solana:*`; allow EVM / other chains through unscored (scoring a
 *      Solana-format wallet against an EVM payTo is meaningless noise).
 *   2. Fail-closed by default: even in the settle hot path a preflight outage now
 *      blocks and logs loudly. Default 500ms timeout, failOpen=false.
 *      Set failOpen=true to opt in to legacy fail-open behavior (allow on outage).
 *
 * Imports ONLY ./gate.js (dep-free) - never the elizaOS provider - so facilitator
 * operators don't drag in @elizaos/core.
 *
 *   import { createFacilitator } from "@daydreamsai/facilitator";
 *   import { createOnBeforeSettleHook } from "@wzrd_sol/plugin-trustgate/facilitator";
 *   const facilitator = createFacilitator({
 *     svmSigners: [...],
 *     hooks: { onBeforeSettle: createOnBeforeSettleHook() },
 *   });
 */
import { type TrustGateConfig, type TrustVerdict } from "./gate.js";
/**
 * The settle-context fields this hook reads, declared structurally to avoid a
 * dependency on the facilitator's own types. The real `daydreamsai/facilitator`
 * context carries more (`paymentPayload`, etc.); we only need the requirements.
 */
export interface FacilitatorSettleContext {
    requirements?: {
        /** Seller / recipient wallet - the address being scored. */
        payTo?: string;
        /** CAIP-2 network id, e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
        network?: string;
        asset?: string;
        /** Settle amount in native units (string). */
        amount?: string;
        [k: string]: unknown;
    };
    /** Present in the real context; fallback source for payTo. */
    paymentPayload?: {
        accepted?: {
            payTo?: string;
            network?: string;
            [k: string]: unknown;
        };
        [k: string]: unknown;
    };
    [k: string]: unknown;
}
/** Return shape that aborts a settlement (daydreams/@x402-core contract). */
export interface FacilitatorAbort {
    abort: true;
    reason: string;
}
/** `void` (allow) | `{abort,reason}` (block) - the hook's return contract. */
export type OnBeforeSettleHook = (ctx: FacilitatorSettleContext) => Promise<void | FacilitatorAbort>;
export interface FacilitatorGateConfig extends TrustGateConfig {
    /**
     * Only gate settles on Solana (CAIP-2 `solana:*`); allow other chains through
     * unscored. Default true - the TWZRD corpus is Solana-only.
     */
    solanaOnly?: boolean;
    /** Observability: called with every verdict (including allows / fail-open). */
    onVerdict?: (verdict: TrustVerdict, ctx: FacilitatorSettleContext) => void;
}
/**
 * Build an `onBeforeSettle` hook that screens the seller wallet through the free
 * TWZRD preflight and aborts the settlement when the verdict is a hard block.
 *
 * Defaults tuned for a settle hot path: 500ms timeout, fail-closed, Solana-only.
 */
export declare function createOnBeforeSettleHook(config?: FacilitatorGateConfig): OnBeforeSettleHook;
export { checkTrust, canSpendSafely } from "./gate.js";
export type { TrustGateConfig, TrustVerdict, TwzrdDecision } from "./gate.js";
