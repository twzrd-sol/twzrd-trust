import { type EvaluateX402Options } from "./evaluate.js";
import type { TwzrdGateConfig } from "./types.js";
export type TwzrdGuardOptions = TwzrdGateConfig & Pick<EvaluateX402Options, "autoReceipt" | "x402Fetch" | "onReceipt" | "escalateOnWarn" | "requireReceipt">;
/**
 * Wraps a fetch implementation with TWZRD gate logic.
 *
 * On every 402 response, the guard:
 *   1. Runs free TWZRD preflight on the seller (via evaluate_x402_resource).
 *   2. If decision=block: throws before the caller can sign a payment.
 *   3. If decision=warn + autoReceipt=true: auto-fetches the paid TWZRD
 *      trust receipt via x402Fetch (TWZRD earns the receipt fee on-chain),
 *      then returns the original 402 for the caller to pay the resource.
 *   4. If decision=allow: returns the original 402 for the caller to pay.
 *
 * Non-402 responses pass through unchanged.
 *
 * Usage:
 *   const safeFetch = withTwzrdGuard(fetch, { autoReceipt: true, x402Fetch: walletFetch });
 *   const resp = await safeFetch("https://example.com/paid-resource"); // 402 handled
 *   // caller attaches payment and retries (or uses an x402 wrapper around safeFetch)
 */
export declare function withTwzrdGuard(innerFetch: typeof fetch, opts?: TwzrdGuardOptions): typeof fetch;
//# sourceMappingURL=with-guard.d.ts.map