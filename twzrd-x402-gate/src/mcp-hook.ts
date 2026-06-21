import type { ResolvedTwzrdGateConfig } from "./config.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import type { X402McpPaymentRequest, X402PaymentRequirements } from "./types.js";

/**
 * x402 MCP client hook. Wire as `onPaymentRequested` on createX402MCPClient.
 * Returns false to deny the payment, true to allow.
 */
export async function twzrdOnPaymentRequested(
  req: X402McpPaymentRequest,
  config?: ResolvedTwzrdGateConfig,
): Promise<boolean> {
  const first = (req.accepts?.[0] ?? {}) as X402PaymentRequirements;
  const { payTo, amountMicro, resource } = payToFromRequirements(first);
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

  const { approved, card, reason } = await twzrdApprovePayment(
    {
      resourceUrl: req.context?.resource ?? resource,
      resourceName: req.context?.toolName,
      sellerWallet: req.context?.sellerWallet,
      payTo,
      priceUsdc,
      buyerWallet: req.context?.buyerWallet,
      agentIntent: "x402_mcp_onPaymentRequested",
    },
    config,
  );

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
