/**
 * TWZRD Payment Control — the live TWZRD preflight as an IntelligenceProvider.
 *
 * The x402 client hook feeds its own preflight into evaluateIntent inline;
 * this module gives every OTHER core consumer (AP2/UCP adapters, direct
 * evaluateIntent callers, future protocol surfaces) the same live pipeline
 * (network classify -> free preflight -> readiness policy -> merchant_card
 * wash refuse) as an injectable intelligence provider, without duplicating
 * its behavior.
 */
import type { PaymentIntent } from "./intent.js";
import type { CounterpartyIntelligence, IntelligenceProvider } from "./policy-runtime.js";
import type { TwzrdApprovalResult, TwzrdGateConfig } from "./types.js";
/**
 * Is this counterparty KNOWN to us — did the score rest on observed evidence
 * about this specific wallet?
 *
 * Deliberately NOT `reputationScored`. That flag only says TWZRD ran Solana
 * behavioral scoring on the payment path; it is true even for a wallet we have
 * never seen — precisely the case a caller most needs flagged. Reading it as
 * "known" marks every scored Solana recipient known:true and silently disables
 * the unknownCounterparty policy, which fires only on `known === false`.
 *
 * Ground truth is `trust_score_basis`, published in `card.caveats[]`:
 *   corpus_teaser_v1:provider_reputation_v1     -> evidence  -> true
 *   corpus_teaser_v1:insufficient_free_evidence -> none      -> false
 *   absent / unrecognized                       -> ambiguous -> undefined
 *
 * `undefined` ("we cannot say") must never collapse into `false` ("we looked,
 * and there is nothing"). Only `false` may drive a policy.
 */
export declare function counterpartyKnownFromApproval(approval: TwzrdApprovalResult): boolean | undefined;
/**
 * Intent amounts are canonical decimal strings, and the deterministic money
 * policy already runs on bigint micro-units. This Number() conversion exists
 * only to price the preflight call — so guard the boundary rather than letting
 * NaN or Infinity reach the network.
 */
export declare function intentAmountToPriceUsd(amount: string): number;
/** Map a gate approval onto the core intelligence shape. Pure. */
export declare function approvalToIntelligence(approval: TwzrdApprovalResult): CounterpartyIntelligence;
export type TwzrdIntelligenceOptions = TwzrdGateConfig & {
    /** Observe the full approval (telemetry / audit). Never throws into evaluation. */
    onApproval?: (approval: TwzrdApprovalResult, intent: PaymentIntent) => void;
};
/**
 * Wrap the existing preflight path as an IntelligenceProvider for
 * `evaluateIntent`. `intent.amount` is the canonical decimal asset string.
 */
export declare function createTwzrdIntelligenceProvider(options?: TwzrdIntelligenceOptions): IntelligenceProvider;
//# sourceMappingURL=intelligence.d.ts.map