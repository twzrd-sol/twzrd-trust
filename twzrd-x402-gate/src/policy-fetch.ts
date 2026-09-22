import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { wrapX402ClientEchoAttempt } from "./attempt-echo.js";
import { x402RequirementsToIntent } from "./intent-adapters.js";
import { toMicroUsd } from "./intent.js";
import { createTwzrdPayingFetch, type CreateTwzrdPayingFetchInput } from "./paying-fetch.js";
import { paymentRequiredFromResponse, pickRequirements } from "./payto.js";
import { evaluateIntent, type Mandate, type SpendLedger, type SpendPolicy } from "./policy-runtime.js";

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
        let intent;
        try {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          intent = x402RequirementsToIntent(pickRequirements(accepts), { resourceUrl: url });
        } catch { return resp; }
        const decision = await evaluateIntent(intent, {
          signer: opts.signer, policy: opts.policy, mandate: opts.mandate,
          ledger: opts.ledger, recordSpend: false,
        });
        if (decision.decision === "block") {
          opts.onAudit?.(decision);
          throw new TwzrdPolicyAbortError(decision);
        }
        pending = { payTo: intent.payTo, amount: intent.amount, decision };
        return resp;
      };
      let pay = userWrap?.(gated);
      return async (input, init) => {
        if (!pay) {
          if (opts.wallet == null) throw new Error("[twzrd-x402-gate] createTwzrdPolicyFetch needs wallet or wrapPay");
          pay = (await import("@x402/fetch")).wrapFetchWithPayment(
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
