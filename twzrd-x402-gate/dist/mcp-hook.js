import { payToFromRequirements, priceUsdcFromAmountMicro, pickRequirements } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
/**
 * x402 MCP client hook. Wire as `onPaymentRequested` on createX402MCPClient.
 * Returns false to deny the payment, true to allow.
 */
export async function twzrdOnPaymentRequested(req, config) {
    const first = pickRequirements(req.accepts);
    const { payTo, amountMicro, resource } = payToFromRequirements(first);
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
    const chain = first.network ?? undefined;
    try {
        const { approved, card, reason } = await twzrdApprovePayment({
            resourceUrl: req.context?.resource ?? resource,
            resourceName: req.context?.toolName,
            sellerWallet: req.context?.sellerWallet,
            payTo,
            priceUsdc,
            buyerWallet: req.context?.buyerWallet,
            agentIntent: "x402_mcp_onPaymentRequested",
            chain,
        }, config);
        if (!approved) {
            console.warn("[twzrd] blocked x402 payment:", reason, {
                payTo,
                resource,
                decision: card.decision,
                trust_score: card.trust_score,
            });
        }
        return approved;
    }
    catch {
        if (!config?.failOpen)
            return false;
        return true; // fail-open fallback
    }
}
//# sourceMappingURL=mcp-hook.js.map