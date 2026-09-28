import type { ResolvedTwzrdGateConfig } from "./config.js";
import {
  offerObjects,
  priceUsdcFromAmountMicro,
  requirementAsset,
  resolveRequirementFields,
} from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";

/**
 * A fetch wrapper or MCP hook sees the whole 402 but not which accepts[] entry
 * the paying client will choose: @x402/core takes the first entry its schemes
 * can pay, x402-solana the first Solana entry, a fee-payer preference another.
 * So every distinct entry must pass before the payer gets the 402. Scoring one
 * entry let a seller list a clean wallet next to a refused one and be paid on
 * the refused one (0.11.2).
 */
export const MAX_DISTINCT_OFFERS = 8;
export const TOO_MANY_PAYMENT_OPTIONS = "too_many_payment_options";

function offerKey(e: Record<string, unknown>): string {
  const f = resolveRequirementFields(e);
  return [
    f.payTo ?? String(e.payTo ?? e.pay_to ?? ""),
    f.amount ?? String(e.amount ?? e.maxAmountRequired ?? ""),
    String(e.asset ?? ""),
    String(e.network ?? "").toLowerCase(),
    f.conflict ?? "",
  ].join("|");
}

/** The distinct offer objects in a seller-supplied accepts value. */
export function distinctOffers(accepts: unknown): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const e of offerObjects(accepts)) {
    const k = offerKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function sameOffer(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return offerKey(a) === offerKey(b);
}

/**
 * Free approval of every offer except `skip` (already evaluated by the caller).
 * Returns the first refusal, or undefined when all pass. No paid hops.
 */
export async function firstRefusedOffer(
  offers: Array<Record<string, unknown>>,
  opts: {
    config?: ResolvedTwzrdGateConfig;
    resourceUrl?: string;
    agentIntent: string;
    skip?: Record<string, unknown>;
  },
): Promise<{ offer: Record<string, unknown>; payTo?: string; reason: string } | undefined> {
  if (offers.length > MAX_DISTINCT_OFFERS) {
    return { offer: offers[0] ?? {}, reason: TOO_MANY_PAYMENT_OPTIONS };
  }
  for (const offer of offers) {
    if (opts.skip && sameOffer(offer, opts.skip)) continue;
    const f = resolveRequirementFields(offer);
    if (f.conflict) return { offer, payTo: f.payTo, reason: f.conflict };
    const approval = await twzrdApprovePayment(
      {
        resourceUrl: (offer.resource as string | undefined) ?? opts.resourceUrl,
        payTo: f.payTo,
        priceUsdc: priceUsdcFromAmountMicro(f.amount, offer),
        agentIntent: opts.agentIntent,
        chain: offer.network as string | undefined,
        asset: requirementAsset(offer),
      },
      opts.config,
    );
    if (!approval.approved) return { offer, payTo: f.payTo, reason: approval.reason };
  }
  return undefined;
}
