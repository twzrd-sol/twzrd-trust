import { resolveConfig } from "./config.js";
import { twzrdOnPaymentRequested } from "./mcp-hook.js";
import { buildPreflightInput, evaluateReadinessCard, twzrdApprovePayment, twzrdPreflight, } from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { wrapFetchWithTwzrdGate } from "./wrap-fetch.js";
export function createTwzrdGate(overrides) {
    const config = resolveConfig(overrides);
    return {
        config,
        preflight: (input) => twzrdPreflight(input, config),
        approvePayment: (ctx) => twzrdApprovePayment(ctx, config),
        onPaymentRequested: (req) => twzrdOnPaymentRequested(req, config),
        wrapFetch: (inner) => wrapFetchWithTwzrdGate(inner, config),
        evaluateReadinessCard,
        buildPreflightInput,
        payToFromRequirements,
        priceUsdcFromAmountMicro,
    };
}
/** Default gate using process.env / global fetch */
export const defaultGate = createTwzrdGate();
/**
 * Decorator-style guard for agent payment flows.
 * Runs TWZRD preflight on the seller before invoking `fn`.
 * Throws if policy denies; passes through on allow/warn.
 *
 * @example
 * const safePay = withTwzrdGuard(
 *   (seller) => agentcashFetch(`https://api.seller.xyz/paid`),
 *   { preflightMinScore: 50 }
 * );
 * const result = await safePay("SELLER_WALLET_BASE58");
 */
export function withTwzrdGuard(fn, config) {
    const cfg = resolveConfig(config);
    return async (sellerWallet, ...args) => {
        const { approved, verdict, score, reason } = await twzrdApprovePayment({ sellerWallet, agentIntent: "withTwzrdGuard" }, cfg);
        if (!approved) {
            throw new Error(`[twzrd] withTwzrdGuard blocked: ${reason} (verdict=${verdict}, score=${score})`);
        }
        return fn(sellerWallet, ...args);
    };
}
//# sourceMappingURL=gate.js.map