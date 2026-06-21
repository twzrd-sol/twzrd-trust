import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import { twzrdOnPaymentRequested } from "./mcp-hook.js";
import {
  buildPreflightInput,
  evaluateReadinessCard,
  twzrdApprovePayment,
  twzrdPreflight,
} from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { wrapFetchWithTwzrdGate } from "./wrap-fetch.js";
import type { TwzrdApproveContext, TwzrdGateConfig, TwzrdPreflightInput, X402McpPaymentRequest } from "./types.js";

export type TwzrdGate = {
  readonly config: ResolvedTwzrdGateConfig;
  preflight: (input: TwzrdPreflightInput) => ReturnType<typeof twzrdPreflight>;
  approvePayment: (ctx: TwzrdApproveContext) => ReturnType<typeof twzrdApprovePayment>;
  onPaymentRequested: (req: X402McpPaymentRequest) => Promise<boolean>;
  wrapFetch: (innerFetch: typeof fetch) => typeof fetch;
  evaluateReadinessCard: typeof evaluateReadinessCard;
  buildPreflightInput: typeof buildPreflightInput;
  payToFromRequirements: typeof payToFromRequirements;
  priceUsdcFromAmountMicro: typeof priceUsdcFromAmountMicro;
};

export function createTwzrdGate(overrides?: TwzrdGateConfig): TwzrdGate {
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
export const defaultGate: TwzrdGate = createTwzrdGate();
