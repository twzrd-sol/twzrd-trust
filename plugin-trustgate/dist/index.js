import { canSpendSafely } from "./gate.js";
import { trustGateProvider } from "./provider.js";
export const trustGatePlugin = {
    name: "twzrd-trustgate",
    description: "Buyer-side x402 trust gate. Scores a seller wallet via the free TWZRD preflight before the " +
        "agent signs a payment, refusing wash-flagged / block-rated merchants. Fail-open.",
    providers: [trustGateProvider],
};
export default trustGatePlugin;
export { createTrustGateProvider, trustGateProvider } from "./provider.js";
export { checkTrust, canSpendSafely } from "./gate.js";
/**
 * Convenience guard for agent payment actions.
 * Calls canSpendSafely(sellerWallet) and either throws (blocked) or calls fn().
 * Combines the provider awareness + enforcement primitive into a single call.
 *
 * @example
 * await withTwzrdGuard(payTo, () => signAndSendPayment(payTo, amount));
 */
export async function withTwzrdGuard(sellerWallet, fn, config) {
    if (!(await canSpendSafely(sellerWallet, config))) {
        throw new Error(`[twzrd] withTwzrdGuard blocked seller: ${sellerWallet}. Run a preflight to get the decision.`);
    }
    return fn();
}
