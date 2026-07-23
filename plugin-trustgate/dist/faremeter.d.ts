/**
 * Faremeter / Corbits buyer-side attach: `payerChooser` pre-sign guard.
 *
 * Faremeter's fetch wrap (`@faremeter/fetch`) exposes:
 *   ProcessPaymentRequiredResponseOpts.payerChooser?:
 *     (execer: PaymentExecer[]) => Promise<PaymentExecer>
 *
 * Each PaymentExecer carries `requirements.payTo` **before** `exec()` signs.
 * Plug `createTwzrdPayerChooser()` as that option to preflight every candidate
 * seller and throw on block — pure config, zero fork of Faremeter.
 *
 * Structural types only (no `@faremeter/*` dependency). Compatible with any
 * object that has `{ requirements: { payTo?, network? }, exec() }`.
 *
 *   import { wrap as wrapFetch } from "@faremeter/fetch"; // or their phase-2 wrap
 *   import { createTwzrdPayerChooser } from "@wzrd_sol/plugin-trustgate/faremeter";
 *
 *   const fetch = wrapFetch(globalThis.fetch, {
 *     handlers: [...],
 *     payerChooser: createTwzrdPayerChooser(),
 *   });
 *
 * Distinct from `./facilitator` (daydreamsai `onBeforeSettle` hook shape).
 * Distinct from twzrd-x402-gate's `installTwzrdX402ClientHook` (official x402
 * client hooks). This is the Faremeter-native composition point.
 */
import { type TrustGateConfig, type TrustVerdict } from "./gate.js";
/** Minimal Faremeter PaymentExecer surface (structural). */
export type FaremeterPaymentExecer = {
    requirements: {
        payTo?: string;
        network?: string;
        amount?: string;
        [k: string]: unknown;
    };
    exec(): Promise<{
        payload: object;
    }>;
};
/** Faremeter payerChooser signature (async allowed; sync also works). */
export type FaremeterPayerChooser = (execers: FaremeterPaymentExecer[]) => Promise<FaremeterPaymentExecer>;
export interface FaremeterChooserConfig extends TrustGateConfig {
    /**
     * Only screen Solana (CAIP-2 `solana:*` or bare `solana`). Non-Solana
     * candidates pass unscored. Default true — TWZRD corpus is Solana-only.
     */
    solanaOnly?: boolean;
    /**
     * When no candidate has a scoreable Solana payTo (all missing payTo or
     * non-Solana), throw instead of falling through to first-available.
     * Default false: empty/missing-payTo lists still pick first (Faremeter
     * default posture for unscoreable options).
     */
    requireScored?: boolean;
    /** Observability: every candidate verdict (incl. allow / skip). */
    onVerdict?: (verdict: TrustVerdict | {
        skipped: true;
        reason: string;
        payTo?: string;
    }) => void;
}
export declare class TwzrdPayerChooserBlockedError extends Error {
    readonly name = "TwzrdPayerChooserBlockedError";
    readonly blocked: Array<{
        payTo: string;
        reason: string;
    }>;
    constructor(blocked: Array<{
        payTo: string;
        reason: string;
    }>);
}
/**
 * Build a Faremeter `payerChooser` that screens each execer's `requirements.payTo`
 * via free TWZRD preflight **before** any `exec()` (sign) runs.
 *
 * Default policy matches plugin-trustgate elsewhere: hard-block only on
 * `decision === "block"` (and optional `minScore`). `warn` / `can_spend=false`
 * alone does **not** reject — free preflight is conservative on unknown sellers.
 *
 * Fail-closed on preflight outage unless `failOpen: true`.
 */
export declare function createTwzrdPayerChooser(config?: FaremeterChooserConfig): FaremeterPayerChooser;
export { checkTrust, canSpendSafely } from "./gate.js";
export type { TrustGateConfig, TrustVerdict } from "./gate.js";
