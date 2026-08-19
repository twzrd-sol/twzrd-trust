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

import { resolveConfig } from "./config.js";
import { twzrdApprovePayment } from "./policy.js";
import type { PaymentIntent } from "./intent.js";
import type {
  CounterpartyIntelligence,
  IntelligenceProvider,
} from "./policy-runtime.js";
import type { TwzrdApprovalResult, TwzrdGateConfig } from "./types.js";

/** Prefix of the readiness-card caveat that carries the scoring basis. */
const BASIS_PREFIX = "trust_score_basis:";

/**
 * Basis markers meaning "we hold no real evidence on this wallet". The server
 * states this explicitly rather than leaving it to be inferred from a low score.
 */
const NO_EVIDENCE = ["insufficient_free_evidence", "default_no_data"];

/** Basis markers meaning "this verdict rests on observed behavior". */
const HAS_EVIDENCE = ["provider_reputation"];

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
export function counterpartyKnownFromApproval(
  approval: TwzrdApprovalResult,
): boolean | undefined {
  // Unscored network (Base/EVM, Stripe deposit addresses): no reputation ran at
  // all, so we know nothing about the recipient. Never imply otherwise.
  if (approval.reputationScored !== true) return undefined;

  const caveats = approval.card?.caveats;
  if (!Array.isArray(caveats)) return undefined;

  const basis = caveats
    .filter((c): c is string => typeof c === "string")
    .find((c) => c.trim().toLowerCase().startsWith(BASIS_PREFIX));
  if (!basis) return undefined;

  const b = basis.toLowerCase();
  if (NO_EVIDENCE.some((m) => b.includes(m))) return false;
  if (HAS_EVIDENCE.some((m) => b.includes(m))) return true;
  return undefined; // an unrecognized basis is ambiguous, not evidence
}

/**
 * Intent amounts are canonical decimal strings, and the deterministic money
 * policy already runs on bigint micro-units. This Number() conversion exists
 * only to price the preflight call — so guard the boundary rather than letting
 * NaN or Infinity reach the network.
 */
export function intentAmountToPriceUsd(amount: string): number {
  // Number("") and Number("   ") are 0, not NaN — an empty amount would price
  // the call as free instead of being rejected. Reject before coercing.
  if (typeof amount !== "string" || amount.trim() === "") {
    throw new Error(
      `[twzrd] intent.amount is not a finite, non-negative decimal: ${JSON.stringify(amount)}`,
    );
  }
  const price = Number(amount);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(
      `[twzrd] intent.amount is not a finite, non-negative decimal: ${JSON.stringify(amount)}`,
    );
  }
  return price;
}

/** Map a gate approval onto the core intelligence shape. Pure. */
export function approvalToIntelligence(
  approval: TwzrdApprovalResult,
): CounterpartyIntelligence {
  return {
    known: counterpartyKnownFromApproval(approval),
    washFlagged: approval.washFlagged ?? undefined,
    // Any gate DENIAL is a block for the runtime, even when the card verdict
    // was "warn" (can_spend gate, score floor, wash refuse). The verdict only
    // grades approved outcomes.
    decision: !approval.approved
      ? "block"
      : approval.verdict === "warn"
        ? "warn"
        : approval.verdict === "allow"
          ? "allow"
          : undefined,
    trustScore: approval.score ?? undefined,
  };
}

export type TwzrdIntelligenceOptions = TwzrdGateConfig & {
  /** Observe the full approval (telemetry / audit). Never throws into evaluation. */
  onApproval?: (approval: TwzrdApprovalResult, intent: PaymentIntent) => void;
};

/**
 * Wrap the existing preflight path as an IntelligenceProvider for
 * `evaluateIntent`. `intent.amount` is the canonical decimal asset string.
 */
export function createTwzrdIntelligenceProvider(
  options?: TwzrdIntelligenceOptions,
): IntelligenceProvider {
  const cfg = resolveConfig(options);
  return async (intent) => {
    const approval = await twzrdApprovePayment(
      {
        resourceUrl: intent.resource?.url,
        payTo: intent.payTo,
        priceUsdc: intentAmountToPriceUsd(intent.amount),
        agentIntent: `${intent.protocol}_payment_control`,
        chain: intent.network,
      },
      cfg,
    );
    try {
      options?.onApproval?.(approval, intent);
    } catch {
      // observation must never alter the decision path
    }
    return approvalToIntelligence(approval);
  };
}
