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
import { checkTrust } from "./gate.js";
/** Match CAIP-2 (`solana:5eykt4...`) and plain-form (`solana`, `solana-devnet`) network ids. */
const SOLANA_NETWORK_RE = /^solana([:-]|$)/i;
function resolveSeller(ctx) {
    return ctx?.requirements?.payTo ?? ctx?.paymentPayload?.accepted?.payTo;
}
function resolveNetwork(ctx) {
    return String(ctx?.requirements?.network ?? ctx?.paymentPayload?.accepted?.network ?? "");
}
/**
 * Build an `onBeforeSettle` hook that screens the seller wallet through the free
 * TWZRD preflight and aborts the settlement when the verdict is a hard block.
 *
 * Defaults tuned for a settle hot path: 500ms timeout, fail-closed, Solana-only.
 */
export function createOnBeforeSettleHook(config = {}) {
    const { solanaOnly = true, onVerdict, timeoutMs = 500, ...gateRest } = config;
    const gateConfig = { timeoutMs, ...gateRest };
    return async (ctx) => {
        const network = resolveNetwork(ctx);
        // Only score Solana settles; everything else passes through unscored.
        // An empty/unknown network is treated as "possibly Solana" (fail-closed on ambiguity):
        // skip the early-return only when we have a confirmed non-Solana network identifier.
        if (solanaOnly && network !== "" && !SOLANA_NETWORK_RE.test(network))
            return;
        const seller = resolveSeller(ctx);
        if (!seller)
            return; // nothing to score -> allow (fail-open posture)
        const verdict = await checkTrust(seller, gateConfig);
        onVerdict?.(verdict, ctx);
        if (verdict.blocked) {
            return {
                abort: true,
                reason: verdict.reason || `TWZRD trust gate blocked seller ${seller}`,
            };
        }
        return; // allow the settle
    };
}
export { checkTrust, canSpendSafely } from "./gate.js";
