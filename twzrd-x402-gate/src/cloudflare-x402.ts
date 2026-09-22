/**
 * Cloudflare Agents x402 approval adapter.
 *
 * Cloudflare's `withX402Client(...).callTool(onPaymentRequired, ...)` asks the
 * caller to approve a payment before it constructs and submits the payment
 * payload. This adapter turns that callback into the same TWZRD decision used
 * by the generic MCP hook.
 *
 * This is an approval boundary, not a claim that Base has TWZRD behavioral
 * reputation. Base/EVM stays `decision=unknown`: observe permits it and strict
 * refuses it before the Cloudflare client pays.
 */

import { resolveConfig } from "./config.js";
import { twzrdOnPaymentRequested } from "./mcp-hook.js";
import type { TwzrdGateConfig, X402PaymentRequiredBody } from "./types.js";

/** Dependency-free structural shape passed to Cloudflare's callback. */
export type CloudflareX402PaymentRequirements = X402PaymentRequiredBody & {
  resource?: string;
  description?: string;
};

/**
 * Build a Cloudflare `onPaymentRequired` callback.
 *
 * @example
 * const approvePayment = createTwzrdCloudflareX402Approval({
 *   unsupportedNetworkMode: "strict",
 * });
 * await client.callTool(approvePayment, { name: "paid_tool", arguments: {} });
 */
export function createTwzrdCloudflareX402Approval(
  options?: TwzrdGateConfig,
): (paymentRequirements: CloudflareX402PaymentRequirements) => Promise<boolean> {
  const config = resolveConfig(options);
  return async (paymentRequirements) =>
    twzrdOnPaymentRequested(
      {
        paymentRequired: paymentRequirements,
        context: { resource: paymentRequirements.resource },
      },
      config,
    );
}
