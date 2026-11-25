import { applyWashFlaggedPolicy, fetchMerchantCard, } from "twzrd-x402-gate";
import { leftoverWashOracle, WASH_REFUSE_REASON } from "./leftover-wash-oracle.js";
export const WASH_UNKNOWN_REASON = "twzrd_wash_unknown";
export async function refuseWashBeforePay(req, options = {}) {
    const payTo = typeof req.payTo === "string"
        ? req.payTo
        : typeof req.pay_to === "string"
            ? req.pay_to
            : undefined;
    if (!payTo?.trim())
        throw new Error(`[twzrd] recipient_missing: no payTo to wash-check`);
    const timeoutMs = options.timeoutMs ?? (Number(process.env.TWZRD_WASH_TIMEOUT_MS ?? "3000") || 3000);
    const transport = options.fetch ?? globalThis.fetch;
    const fetchWithTimeout = (input, init = {}) => transport(input, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const card = await fetchMerchantCard(payTo, {
        intelBase: options.intelBase ?? process.env.TWZRD_INTEL_BASE ?? "https://intel.twzrd.xyz",
        fetch: fetchWithTimeout,
    });
    const washFlagged = card?.wash_flagged;
    const decision = applyWashFlaggedPolicy({
        approved: true,
        reason: "twzrd_wash_ok",
        washFlagged,
        refuseWashFlagged: true,
    });
    if (!decision.approved) {
        const wash = leftoverWashOracle({ wash_flagged: true });
        throw new Error(`[twzrd] ${decision.reason || wash.reason || WASH_REFUSE_REASON} payTo=${payTo}`);
    }
    if (washFlagged !== false) {
        throw new Error(`[twzrd] ${WASH_UNKNOWN_REASON} payTo=${payTo}`);
    }
}
