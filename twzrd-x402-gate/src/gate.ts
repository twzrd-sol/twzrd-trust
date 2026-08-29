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
export function withTwzrdGuard<TArgs extends unknown[], TReturn>(
  fn: (sellerWallet: string, ...args: TArgs) => Promise<TReturn>,
  config?: TwzrdGateConfig,
): (sellerWallet: string, ...args: TArgs) => Promise<TReturn> {
  const cfg = resolveConfig(config);
  return async (sellerWallet: string, ...args: TArgs): Promise<TReturn> => {
    const { approved, verdict, score, reason } = await twzrdApprovePayment(
      { sellerWallet, agentIntent: "withTwzrdGuard" },
      cfg,
    );
    if (!approved) {
      throw new Error(
        `[twzrd] withTwzrdGuard blocked: ${reason} (verdict=${verdict}, score=${score})`,
      );
    }
    return fn(sellerWallet, ...args);
  };
}
