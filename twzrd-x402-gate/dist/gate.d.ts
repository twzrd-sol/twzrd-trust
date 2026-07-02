import { type ResolvedTwzrdGateConfig } from "./config.js";
import { buildPreflightInput, evaluateReadinessCard, twzrdApprovePayment, twzrdPreflight } from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
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
export declare function createTwzrdGate(overrides?: TwzrdGateConfig): TwzrdGate;
/** Default gate using process.env / global fetch */
export declare const defaultGate: TwzrdGate;
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
export declare function withTwzrdGuard<TArgs extends unknown[], TReturn>(fn: (sellerWallet: string, ...args: TArgs) => Promise<TReturn>, config?: TwzrdGateConfig): (sellerWallet: string, ...args: TArgs) => Promise<TReturn>;
//# sourceMappingURL=gate.d.ts.map