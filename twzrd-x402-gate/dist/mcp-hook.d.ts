import type { ResolvedTwzrdGateConfig } from "./config.js";
import type { X402McpPaymentRequest, X402McpPaymentRequestedContext } from "./types.js";
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
export declare function twzrdOnPaymentRequested(req: X402McpPaymentRequest | X402McpPaymentRequestedContext, config?: ResolvedTwzrdGateConfig): Promise<boolean>;
//# sourceMappingURL=mcp-hook.d.ts.map