import { payToFromRequirements, pickRequirements } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
function requestUrl(input) {
    if (typeof input === "string")
        return input;
    if (input instanceof URL)
        return input.href;
    return input.url;
}
/**
 * Wrap fetch: on HTTP 402, run TWZRD preflight on payTo before caller retries with payment.
 * Throws if policy denies; returns original 402 if approved (caller attaches payment).
 */
export function wrapFetchWithTwzrdGate(innerFetch, config) {
    return async (input, init) => {
        const resp = await innerFetch(input, init);
        if (resp.status !== 402)
            return resp;
        let body = {};
        try {
            body = (await resp.clone().json());
        }
        catch {
            // 402 without a parseable x402 body — nothing to gate on; pass through
            return resp;
        }
        const first = pickRequirements(body.accepts);
        const { payTo, resource } = payToFromRequirements(first);
        const url = requestUrl(input);
        const { approved, reason } = await twzrdApprovePayment({
            resourceUrl: resource ?? url,
            payTo,
            agentIntent: "wrapFetch_402_gate",
        }, config);
        if (!approved) {
            throw new Error(`[twzrd] payment blocked: ${reason} payTo=${payTo} url=${url}`);
        }
        return resp;
    };
}
//# sourceMappingURL=wrap-fetch.js.map