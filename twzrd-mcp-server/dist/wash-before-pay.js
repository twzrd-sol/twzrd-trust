import { applyWashFlaggedPolicy, fetchMerchantCard, } from "twzrd-x402-gate";
import { leftoverWashOracle, WASH_REFUSE_REASON } from "./leftover-wash-oracle.js";
export async function refuseWashBeforePay(req) {
    const payTo = typeof req.payTo === "string"
        ? req.payTo
        : typeof req.pay_to === "string"
            ? req.pay_to
            : undefined;
    if (!payTo?.trim())
        return;
    const timeoutMs = Number(process.env.TWZRD_WASH_TIMEOUT_MS ?? "3000") || 3000;
    const fetchWithTimeout = (input, init = {}) => globalThis.fetch(input, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const card = await fetchMerchantCard(payTo, {
        intelBase: process.env.TWZRD_INTEL_BASE ?? "https://intel.twzrd.xyz",
        fetch: fetchWithTimeout,
    });
    const decision = applyWashFlaggedPolicy({
        approved: true,
        reason: "twzrd_wash_ok",
        washFlagged: card?.wash_flagged,
        refuseWashFlagged: true,
    });
    if (!decision.approved) {
        const wash = leftoverWashOracle({ wash_flagged: true });
        throw new Error(`[twzrd] ${decision.reason || wash.reason || WASH_REFUSE_REASON} payTo=${payTo}`);
    }
}
