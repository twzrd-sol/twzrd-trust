import { AsyncLocalStorage } from "node:async_hooks";

import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { distinctOffers, MAX_DISTINCT_OFFERS, TOO_MANY_PAYMENT_OPTIONS } from "./all-offers.js";
import { wrapX402ClientEchoAttempt } from "./attempt-echo.js";
import { twzrdSentinelRefusal } from "./binding-plane.js";
import { TwzrdUnpricedAssetError, x402RequirementsToIntent } from "./intent-adapters.js";
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

type PendingOffer = { payTo: string; amount: string; decision: PaymentDecision };
/** One call's state: the offer it was cleared to pay and what that holds against the ceilings. */
type CallSlot = { pending?: PendingOffer; reserved?: Array<[scope: string, micro: bigint]> };

export function createTwzrdPolicyFetch(opts: CreateTwzrdPolicyFetchInput): typeof fetch {
  // One slot per call, carried on the call's async context. A single shared
  // slot let concurrent calls overwrite each other's offer: the first call to
  // finish booked the other's amount and cleared the slot, so the second paid
  // call was never booked, and a ceiling was read before either was.
  const calls = new AsyncLocalStorage<CallSlot>();
  // Used only if a payer invokes the gated fetch outside the call's async
  // context (a queue or an event callback); such calls share one slot.
  const detached: CallSlot = {};
  // Amounts cleared to pay but not yet booked, per ledger scope. Ceilings
  // read the ledger plus these, so a payment in flight counts.
  const inflight = new Map<string, bigint>();
  const release = (slot: CallSlot): void => {
    for (const [scope, micro] of slot.reserved ?? []) {
      const left = (inflight.get(scope) ?? 0n) - micro;
      if (left > 0n) inflight.set(scope, left);
      else inflight.delete(scope);
    }
    slot.reserved = undefined;
    slot.pending = undefined;
  };
  const base = opts.ledger;
  const ledgerView: SpendLedger | undefined = base && {
    ...base,
    spentMicro: (scope, windowMs, now) => base.spentMicro(scope, windowMs, now) + (inflight.get(scope) ?? 0n),
    record: (scope, micro, at) => base.record(scope, micro, at),
    firstSeen: (scope) => base.firstSeen(scope),
  };
  const scopesFor = (payTo: string): string[] => {
    const scopes = [`counterparty:${payTo}`];
    if (opts.policy?.dailyCeilingUsd !== undefined) scopes.push("policy:global");
    if (opts.mandate) scopes.push(`mandate:${opts.mandate.mandateId}`);
    return scopes;
  };
  // Clearing an offer awaits (one signed decision per offer). Calls take
  // turns through that step so each reads the reservations of those before it.
  let turn: Promise<void> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = turn.then(fn, fn);
    turn = run.then(() => undefined, () => undefined);
    return run;
  };
  const userWrap = opts.wrapPay;
  return createTwzrdPayingFetch({
    ...opts,
    wrapPay: (washed) => {
      // `washed` read the sentinels before it returned the 402, but this
      // wrapper awaits again (challenge parse, one signed decision per offer),
      // so the 402 goes to the payer only through this last read.
      const handOver = (resp: Response): Response => {
        const halted = twzrdSentinelRefusal(opts);
        if (halted !== undefined) throw new TwzrdWashAbortError(`[twzrd] ${halted}`);
        return resp;
      };
      const gated: typeof fetch = async (input, init) => {
        const resp = await washed(input, init);
        if (resp.status !== 402) return resp;
        let challenge: unknown;
        try { challenge = await paymentRequiredFromResponse(resp); }
        catch { return handOver(resp); }
        if (challenge == null) return handOver(resp);
        const accepts = (challenge as { accepts?: Array<Record<string, unknown>> }).accepts;
        const offers = distinctOffers(accepts);
        if (offers.length === 0 || offers.length > MAX_DISTINCT_OFFERS) {
          throw new TwzrdWashAbortError(offers.length === 0 ? "twzrd_unidentifiable_payment_recipient" : TOO_MANY_PAYMENT_OPTIONS);
        }
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const slot = calls.getStore() ?? detached;
        return inTurn(async () => {
          // A second 402 inside one call replaces what the first one held.
          release(slot);
          // Every entry the payer could choose must clear the policy (0.11.3), not just the preferred one.
          let intent; let decision;
          const preferred = pickRequirements(offers);
          for (const offer of offers) {
            let it;
            try { it = x402RequirementsToIntent(offer, { resourceUrl: url }); } catch (e) { throw new TwzrdWashAbortError(e instanceof TwzrdUnpricedAssetError ? "twzrd_non_usdc_asset" : "twzrd_unidentifiable_payment_recipient"); }
            const d = await evaluateIntent(it, {
              signer: opts.signer, policy: opts.policy, mandate: opts.mandate,
              ledger: ledgerView, recordSpend: false,
              stateDir: opts.stateDir, killFilePath: opts.killFilePath, pauseFilePath: opts.pauseFilePath,
            });
            if (d.decision === "block") {
              opts.onAudit?.(d);
              throw new TwzrdPolicyAbortError(d);
            }
            // The client may pay any entry (default selector: accepts[0]), so the ledger books the
            // costliest one rather than the preferred one; the daily ceiling cannot be undercounted.
            if (!intent || toMicroUsd(it.amount) > toMicroUsd(intent.amount) || (toMicroUsd(it.amount) === toMicroUsd(intent.amount) && offer === preferred)) { intent = it; decision = d; }
          }
          if (!intent || !decision) return handOver(resp);
          handOver(resp);
          const micro = toMicroUsd(intent.amount);
          slot.pending = { payTo: intent.payTo, amount: intent.amount, decision };
          slot.reserved = scopesFor(intent.payTo).map((scope) => [scope, micro]);
          for (const [scope] of slot.reserved) inflight.set(scope, (inflight.get(scope) ?? 0n) + micro);
          return resp;
        });
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
        const slot: CallSlot = {};
        const r = await calls.run(slot, () => pay!(input, init)).catch((err: unknown) => {
          release(slot);
          release(detached);
          throw err;
        });
        // A payer that left the call's context put its offer in the shared slot.
        const used = slot.pending ? slot : detached;
        const pending = used.pending;
        // Release before booking: the ledger takes over from the reservation.
        release(used);
        if (r.ok && pending) {
          const now = Date.now();
          const micro = toMicroUsd(pending.amount);
          // Mirrors evaluateIntent's recordSpend scopes — dailyCeilingUsd
          // reads policy:global, which this record-on-200 path must feed.
          for (const scope of scopesFor(pending.payTo)) opts.ledger?.record(scope, micro, now);
          opts.onAudit?.(pending.decision);
        }
        return r;
      };
    },
  });
}
