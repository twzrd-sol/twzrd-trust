/**
 * @wzrd_sol/plugin-trustgate - buyer-side x402 spend guard for elizaOS agents.
 *
 * Two pieces, NOT a magic interceptor:
 *   - the provider INJECTS the seller's trust verdict ("BLOCK - do not pay") into the
 *     agent's context, so the model won't choose to pay a wash-flagged merchant.
 *   - canSpendSafely(payTo) is the ENFORCEMENT primitive your payment action calls
 *     before signing (returns false to abort). The plugin does not auto-intercept
 *     signatures - you wire the guard into your spend path.
 *
 * Scores via the FREE TWZRD preflight (corpus-backed wash/sybil reputation). No auth,
 * no cost, no Solana dep in the gate. Fail-open by default (failOpen:false = strict).
 *
 *   import { trustGatePlugin, canSpendSafely } from "@wzrd_sol/plugin-trustgate";
 *   // register trustGatePlugin so the agent SEES trust in context, then gate the spend:
 *   if (!(await canSpendSafely(payTo))) return; // do not sign
 */
import type { Plugin } from "@elizaos/core";
import { type TrustGateConfig } from "./gate.js";
export declare const trustGatePlugin: Plugin;
export default trustGatePlugin;
export { createTrustGateProvider, trustGateProvider } from "./provider.js";
export { checkTrust, canSpendSafely } from "./gate.js";
export type { TrustGateConfig, TrustVerdict, TwzrdDecision } from "./gate.js";
/**
 * Convenience guard for agent payment actions.
 * Calls canSpendSafely(sellerWallet) and either throws (blocked) or calls fn().
 * Combines the provider awareness + enforcement primitive into a single call.
 *
 * @example
 * await withTwzrdGuard(payTo, () => signAndSendPayment(payTo, amount));
 */
export declare function withTwzrdGuard(sellerWallet: string, fn: () => Promise<void>, config?: TrustGateConfig): Promise<void>;
