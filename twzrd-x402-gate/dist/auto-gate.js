import { withTwzrdGuard } from "./with-guard.js";
/**
 * Default-on composition helper: guards the RAW fetch with the free TWZRD preflight,
 * THEN hands the guarded fetch to your payment wrapper. This is the one-liner form of
 * the two-step pattern documented in the README:
 *
 *   const raw = globalThis.fetch;
 *   const gated = withTwzrdGuard(raw);
 *   const paying = payWrap(gated);
 *
 * Composing it this way by construction rules out the common mis-wiring of guarding
 * an already-paying fetch (which returns 200 and never gives the guard a 402 to act on).
 *
 * Default ON — a blocked seller throws before payWrap's client ever signs. Opt out with
 * TWZRD_AUTO_GATE=0 (env) or { disabled: true } (per-call), e.g. for a local dev harness
 * that intentionally wants the unguarded fetch.
 *
 * @example
 *   import { installTwzrdAutoGate } from "twzrd-x402-gate";
 *   import { wrapFetchWithPayment } from "@x402/svm";
 *
 *   const payingFetch = installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));
 *   await payingFetch("https://api.exa.ai/search"); // blocked sellers throw before signing
 */
export function installTwzrdAutoGate(payWrap, options) {
    const raw = options?.rawFetch ?? globalThis.fetch;
    const envDisabled = process.env.TWZRD_AUTO_GATE === "0" || process.env.TWZRD_AUTO_GATE === "false";
    const disabled = options?.disabled ?? envDisabled;
    if (disabled)
        return payWrap(raw);
    const guarded = withTwzrdGuard(raw, options);
    return payWrap(guarded);
}
//# sourceMappingURL=auto-gate.js.map