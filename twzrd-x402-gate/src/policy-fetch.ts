import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { distinctOffers, MAX_DISTINCT_OFFERS, TOO_MANY_PAYMENT_OPTIONS } from "./all-offers.js";
import { wrapX402ClientEchoAttempt } from "./attempt-echo.js";
import { x402RequirementsToIntent } from "./intent-adapters.js";
import { toMicroUsd } from "./intent.js";
import { createTwzrdPayingFetch, TwzrdWashAbortError, type CreateTwzrdPayingFetchInput } from "./paying-fetch.js";
import { paymentRequiredFromResponse, pickRequirements } from "./payto.js";
import { evaluateIntent, type Mandate, type SpendLedger, type SpendPolicy } from "./policy-runtime.js";

/** Load the optional @x402/fetch peer with an install hint instead of a bare ERR_MODULE_NOT_FOUND (0.11.2). */
function x402FetchPeer(entry: string): Promise<typeof import("@x402/fetch")> {
  return import("@x402/fetch").catch((cause: unknown) => {
    throw new Error(
      `[twzrd-x402-gate] ${entry} needs @x402/fetch, an optional peer dependency. Install it: npm i @x402/fetch @x402/core`,
      { cause },
    );
  });
}

/** Budget/mandate abort; never treated as a dead origin. */
export class TwzrdPolicyAbortError extends Error {
  override name = "TwzrdPolicyAbortError";
  readonly decision: PaymentDecision;
  constructor(decision: PaymentDecision) {
    super(`[twzrd] ${decision.reasonCodes.join(",")}`);
    this.decision = decision;
  }
}

export type CreateTwzrdPolicyFetchInput = CreateTwzrdPayingFetchInput & {
  signer: DecisionSigner;
  policy?: SpendPolicy;
  mandate?: Mandate;
  ledger?: SpendLedger;
  onAudit?: (d: PaymentDecision) => void;
};

export function createTwzrdPolicyFetch(opts: CreateTwzrdPolicyFetchInput): typeof fetch {
  let pending: { payTo: string; amount: string; decision: PaymentDecision } | undefined;
  const userWrap = opts.wrapPay;
  return createTwzrdPayingFetch({
    ...opts,
    wrapPay: (washed) => {
      const gated: typeof fetch = async (input, init) => {
        const resp = await washed(input, init);
        if (resp.status !== 402) return resp;
        let challenge: unknown;
        try { challenge = await paymentRequiredFromResponse(resp); }
        catch { return resp; }
        if (challenge == null) return resp;
        const accepts = (challenge as { accepts?: Array<Record<string, unknown>> }).accepts;
        const offers = distinctOffers(accepts);
        if (offers.length === 0 || offers.length > MAX_DISTINCT_OFFERS) {
          throw new TwzrdWashAbortError(offers.length === 0 ? "twzrd_unidentifiable_payment_recipient" : TOO_MANY_PAYMENT_OPTIONS);
        }
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        // Every entry the payer could choose must clear the policy (0.11.3), not just the preferred one.
        let intent; let decision;
        const preferred = pickRequirements(offers);
        for (const offer of offers) {
          let it;
          try { it = x402RequirementsToIntent(offer, { resourceUrl: url }); } catch { throw new TwzrdWashAbortError("twzrd_unidentifiable_payment_recipient"); }
          const d = await evaluateIntent(it, {
            signer: opts.signer, policy: opts.policy, mandate: opts.mandate,
            ledger: opts.ledger, recordSpend: false,
          });
          if (d.decision === "block") {
            opts.onAudit?.(d);
            throw new TwzrdPolicyAbortError(d);
          }
          if (offer === preferred || !intent) { intent = it; decision = d; }
        }
        if (!intent || !decision) return resp;
        pending = { payTo: intent.payTo, amount: intent.amount, decision };
        return resp;
      };
      let pay = userWrap?.(gated);
      return async (input, init) => {
        if (!pay) {
          if (opts.wallet == null) throw new Error("[twzrd-x402-gate] createTwzrdPolicyFetch needs wallet or wrapPay");
          pay = (await x402FetchPeer("createTwzrdPolicyFetch")).wrapFetchWithPayment(
            gated,
            wrapX402ClientEchoAttempt(opts.wallet) as never,
          );
        }
        const r = await pay(input, init);
        if (r.ok && pending) {
          const now = Date.now();
          const micro = toMicroUsd(pending.amount);
          opts.ledger?.record(`counterparty:${pending.payTo}`, micro, now);
          // Mirrors evaluateIntent's recordSpend scopes — dailyCeilingUsd
          // reads policy:global, which this record-on-200 path must feed.
          if (opts.policy?.dailyCeilingUsd !== undefined) opts.ledger?.record("policy:global", micro, now);
          if (opts.mandate) opts.ledger?.record(`mandate:${opts.mandate.mandateId}`, micro, now);
          opts.onAudit?.(pending.decision);
        }
        pending = undefined;
        return r;
      };
    },
  });
}
