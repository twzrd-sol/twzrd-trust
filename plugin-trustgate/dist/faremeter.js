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
import { checkTrust } from "./gate.js";
const SOLANA_NETWORK_RE = /^solana([:-]|$)/i;
export class TwzrdPayerChooserBlockedError extends Error {
    name = "TwzrdPayerChooserBlockedError";
    blocked;
    constructor(blocked) {
        const detail = blocked
            .map((b) => `${b.payTo.slice(0, 8)}…: ${b.reason}`)
            .join("; ");
        super(`[twzrd] payerChooser blocked all candidates (${blocked.length}): ${detail}. ` +
            `No payment signed. Wire a different seller or raise failOpen/minScore only deliberately.`);
        this.blocked = blocked;
    }
}
function payToOf(e) {
    return String(e?.requirements?.payTo ?? "").trim();
}
function networkOf(e) {
    return String(e?.requirements?.network ?? "").trim();
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
export function createTwzrdPayerChooser(config = {}) {
    const { solanaOnly = true, requireScored = false, onVerdict, ...gateRest } = config;
    const gateConfig = { ...gateRest };
    return async (execers) => {
        if (!Array.isArray(execers) || execers.length < 1) {
            throw new Error("[twzrd] payerChooser: no applicable payers found");
        }
        const blocked = [];
        let sawScoreable = false;
        for (const execer of execers) {
            const payTo = payToOf(execer);
            const network = networkOf(execer);
            // Confirmed non-Solana → pass through unscored (corpus is Solana).
            if (solanaOnly && network !== "" && !SOLANA_NETWORK_RE.test(network)) {
                onVerdict?.({ skipped: true, reason: "non_solana_network", payTo: payTo || undefined });
                return execer;
            }
            if (!payTo) {
                onVerdict?.({ skipped: true, reason: "missing_payTo" });
                // Nothing to score — keep scanning; if all lack payTo, fall through below.
                continue;
            }
            sawScoreable = true;
            const verdict = await checkTrust(payTo, gateConfig);
            onVerdict?.(verdict);
            if (verdict.blocked) {
                blocked.push({ payTo, reason: verdict.reason });
                continue;
            }
            // First non-blocked scoreable candidate wins (Faremeter chooseFirstAvailable shape).
            return execer;
        }
        if (blocked.length > 0 && (requireScored || sawScoreable)) {
            // All scoreable Solana candidates were blocked (or only blocked ones existed).
            throw new TwzrdPayerChooserBlockedError(blocked);
        }
        // No scoreable payTo (all missing) and requireScored=false → Faremeter-compatible
        // first-available fallback so we never brick multi-accept lists without payTo.
        const first = execers[0];
        if (first === undefined) {
            throw new Error("[twzrd] payerChooser: undefined payer found");
        }
        if (requireScored) {
            throw new Error("[twzrd] payerChooser: requireScored=true but no scoreable Solana payTo in candidates");
        }
        return first;
    };
}
export { checkTrust, canSpendSafely } from "./gate.js";
