import type { ResolvedTwzrdGateConfig } from "./config.js";
import type { X402McpPaymentRequest } from "./types.js";
/**
 * x402 MCP client hook. Wire as `onPaymentRequested` on createX402MCPClient.
 * Returns false to deny the payment, true to allow.
 */
export declare function twzrdOnPaymentRequested(req: X402McpPaymentRequest, config?: ResolvedTwzrdGateConfig): Promise<boolean>;
//# sourceMappingURL=mcp-hook.d.ts.map