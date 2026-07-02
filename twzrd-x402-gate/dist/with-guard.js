import { resolveConfig } from "./config.js";
import { evaluate_x402_resource } from "./evaluate.js";
import { payToFromRequirements, pickRequirements } from "./payto.js";
function requestUrl(input) {
    if (typeof input === "string")
        return input;
    if (input instanceof URL)
        return input.href;
    return input.url;
}
/**
 * Wraps a fetch implementation with TWZRD gate logic.
 *
 * On every 402 response, the guard:
 *   1. Runs free TWZRD preflight on the seller (via evaluate_x402_resource).
 *   2. If decision=block: throws before the caller can sign a payment.
 *   3. If decision=warn + autoReceipt=true: auto-fetches the paid TWZRD
 *      trust receipt via x402Fetch (TWZRD earns the receipt fee on-chain),
 *      then returns the original 402 for the caller to pay the resource.
 *   4. If decision=allow: returns the original 402 for the caller to pay.
 *
 * Non-402 responses pass through unchanged.
 *
 * Usage:
 *   const safeFetch = withTwzrdGuard(fetch, { autoReceipt: true, x402Fetch: walletFetch });
 *   const resp = await safeFetch("https://example.com/paid-resource"); // 402 handled
 *   // caller attaches payment and retries (or uses an x402 wrapper around safeFetch)
 */
export function withTwzrdGuard(innerFetch, opts) {
    // Resolve once at construction time so config errors surface early.
    const config = resolveConfig({
        intelBase: opts?.intelBase,
        preflightMinScore: opts?.preflightMinScore,
        blockDecisions: opts?.blockDecisions,
        failOpen: opts?.failOpen,
        gateOnCanSpend: opts?.gateOnCanSpend,
        fetch: opts?.fetch ?? innerFetch,
    });
    return async (input, init) => {
        const resp = await innerFetch(input, init);
        if (resp.status !== 402)
            return resp;
        let body = {};
        try {
            body = (await resp.clone().json());
        }
        catch {
            // 402 without a parseable x402 body — nothing to gate on.
            return resp;
        }
        const first = pickRequirements(body.accepts);
        const url = requestUrl(input);
        const result = await evaluate_x402_resource(url, first, {
            intelBase: config.intelBase,
            preflightMinScore: config.preflightMinScore,
            blockDecisions: config.blockDecisions,
            failOpen: config.failOpen,
            gateOnCanSpend: config.gateOnCanSpend,
            fetch: config.fetch,
            autoReceipt: opts?.autoReceipt,
            x402Fetch: opts?.x402Fetch,
            onReceipt: opts?.onReceipt,
            escalateOnWarn: opts?.escalateOnWarn,
        });
        if (!result.approved) {
            const { payTo } = payToFromRequirements(first);
            throw new Error(`[twzrd-guard] payment blocked: ${result.reason} payTo=${payTo ?? "unknown"} url=${url}`);
        }
        return resp;
    };
}
//# sourceMappingURL=with-guard.js.map