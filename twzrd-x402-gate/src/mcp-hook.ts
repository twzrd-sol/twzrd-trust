import type { ResolvedTwzrdGateConfig } from "./config.js";
import { payToFromRequirements, priceUsdcFromAmountMicro, pickRequirements } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import type {
  X402McpPaymentRequest,
  X402McpPaymentRequestedContext,
  X402PaymentRequirements,
} from "./types.js";

/**
 * x402 MCP client hook. Wire as `onPaymentRequested` on the @x402/mcp client
 * (`new x402MCPClient(mcp, paymentClient, { onPaymentRequested })` or
 * `createx402MCPClient({ ..., onPaymentRequested })`).
 * Returns false to deny the payment, true to allow.
 *
 * Accepts BOTH context shapes:
 * - the real @x402/mcp v2 PaymentRequestedContext:
 *   `{ toolName, arguments, paymentRequired: { accepts } }` — accepts[] is
 *   nested under paymentRequired (verified against @x402/mcp@2.17.0);
 * - the legacy flat shape `{ accepts, context }` this package documented
 *   before this fix.
 *
 * Before this fix only the flat shape was read: wired into the real runtime,
 * `req.accepts` was undefined, so every payment hit the unidentifiable-recipient
 * fail-closed path — safe, but a 100% false-block. The nested shape is now
 * detected first.
 *
 * For official @x402/core clients (not MCP), prefer `installTwzrdX402ClientHook`,
 * which registers on the client's own `onBeforePaymentCreation` lifecycle hook.
 *
 * @see https://docs.x402.org/advanced-concepts/lifecycle-hooks
 */
export async function twzrdOnPaymentRequested(
  req: X402McpPaymentRequest | X402McpPaymentRequestedContext,
  config?: ResolvedTwzrdGateConfig,
): Promise<boolean> {
  const real = req as X402McpPaymentRequestedContext;
  const legacy = req as X402McpPaymentRequest;
  const accepts = (real.paymentRequired?.accepts ?? legacy.accepts) as
    | Array<Record<string, unknown>>
    | undefined;
  const toolName = real.toolName ?? legacy.context?.toolName;

  const first: X402PaymentRequirements = pickRequirements(accepts);
  const { payTo, amountMicro, resource } = payToFromRequirements(first);
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

  const chain = first.network ?? undefined;
  try {
    const { approved, card, reason } = await twzrdApprovePayment(
      {
        resourceUrl: legacy.context?.resource ?? resource,
        resourceName: toolName,
        sellerWallet: legacy.context?.sellerWallet,
        payTo,
        priceUsdc,
        buyerWallet: legacy.context?.buyerWallet,
        agentIntent: "x402_mcp_onPaymentRequested",
        chain,
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
  } catch {
    if (!config?.failOpen) return false;
    return true; // fail-open fallback
  }
}
