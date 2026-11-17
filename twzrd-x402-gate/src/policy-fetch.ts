import { AsyncLocalStorage } from "node:async_hooks";

import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { distinctOffers, MAX_DISTINCT_OFFERS, TOO_MANY_PAYMENT_OPTIONS } from "./all-offers.js";
import { wrapX402ClientEchoAttempt } from "./attempt-echo.js";
import { twzrdSentinelRefusal } from "./binding-plane.js";
import { TwzrdUnpricedAssetError, x402RequirementsToIntent } from "./intent-adapters.js";
import { toMicroUsd } from "./intent.js";
import {
  approvedRequirementOf, paymentBindingRefusal, paymentHeadersOf, paymentNamesRequirement, requestHeadersOf,
  PAYMENT_DIFFERS_FROM_APPROVAL, type ApprovedRequirement,
} from "./payment-binding.js";
import {
  createTwzrdPayingFetch, PAYMENT_REQUIRED_UNREADABLE, TwzrdWashAbortError, type CreateTwzrdPayingFetchInput,
} from "./paying-fetch.js";
import { paymentRequiredFromResponse } from "./payto.js";
import { counterpartyScope, evaluateIntent, type Mandate, type SpendLedger, type SpendPolicy } from "./policy-runtime.js";

/** Load the optional @x402/fetch peer with an install hint instead of a bare ERR_MODULE_NOT_FOUND (0.11.2). */
function x402FetchPeer(entry: string): Promise<typeof import("@x402/fetch")> {
  return import("@x402/fetch").catch((cause: unknown) => {
    throw new Error(
      `[twzrd-x402-gate] ${entry} needs @x402/fetch, an optional peer dependency. Install it: npm i @x402/fetch @x402/core`,
      { cause },
    );
  });
}

/** The spend ledger could not record a payment, so the payment is not sent. */
export const SPEND_LEDGER_UNAVAILABLE = "spend_ledger_unavailable";

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

/** One offer the policy cleared, as the payment that pays it must name it. */
type ClearedOffer = { payTo: string; micro: bigint; decision: PaymentDecision; approved: ApprovedRequirement };
/**
 * One call's state: the offers it was cleared to pay and what they hold
 * against the ceilings. `seen` marks a slot the gated fetch ran under.
 */
type CallSlot = { cleared?: ClearedOffer[]; reserved?: Array<[scope: string, micro: bigint]>; seen?: boolean };

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
    slot.cleared = undefined;
  };
  const base = opts.ledger;
  const ledgerView: SpendLedger | undefined = base && {
    ...base,
    spentMicro: (scope, windowMs, now) => base.spentMicro(scope, windowMs, now) + (inflight.get(scope) ?? 0n),
    record: (scope, micro, at) => base.record(scope, micro, at),
    firstSeen: (scope) => base.firstSeen(scope),
  };
  /**
   * What a set of offers holds or books: each recipient at its own costliest
   * offer, and the cumulative scopes once, at the costliest offer of all. A
   * payer signs one entry; which one is not known until its payment is read.
   */
  const amountsFor = (offers: ClearedOffer[]): Array<[scope: string, micro: bigint]> => {
    const byScope = new Map<string, bigint>();
    let top = 0n;
    for (const o of offers) {
      const scope = counterpartyScope(o.payTo);
      if (o.micro > (byScope.get(scope) ?? -1n)) byScope.set(scope, o.micro);
      if (o.micro > top) top = o.micro;
    }
    const out = [...byScope];
    if (opts.policy?.dailyCeilingUsd !== undefined) out.push(["policy:global", top]);
    if (opts.mandate) out.push([`mandate:${opts.mandate.mandateId}`, top]);
    return out;
  };
  /** Move offers from held to the ledger. A ledger that cannot record throws, and the caller sends nothing. */
  const book = (slot: CallSlot, offers: ClearedOffer[]): void => {
    // Release before booking: the ledger takes over from the reservation.
    release(slot);
    const now = Date.now();
    try {
      for (const [scope, micro] of amountsFor(offers)) opts.ledger?.record(scope, micro, now);
    } catch (cause) {
      // An abort, not a dead origin: the paying fetch must not go on to pay its fallback route.
      throw new TwzrdWashAbortError(SPEND_LEDGER_UNAVAILABLE, { cause });
    }
    const costliest = offers.reduce((a, b) => (b.micro > a.micro ? b : a));
    opts.onAudit?.(costliest.decision);
  };
  /**
   * A request that carries a payment is about to leave. Book it now: once it
   * is sent the seller can settle it and answer anything (an error, another
   * 402, a dropped connection), so the answer says nothing about the spend.
   *
   * A v2 payment names the requirement it pays; that offer is booked, and a
   * payment naming an offer this call did not clear is refused before it is
   * sent. A v1 payment names only scheme and network, and some payers send a
   * header in their own format: then every cleared offer it could be paying
   * is booked.
   */
  const bookSent = (slot: CallSlot, headers: string[]): void => {
    const cleared = slot.cleared;
    if (!cleared || cleared.length === 0) return; // not cleared by this call: nothing here priced it
    const paying = new Set<ClearedOffer>();
    for (const header of headers) {
      const named = cleared.filter((o) => paymentBindingRefusal(o.approved, header) === undefined);
      if (named.length === 0 && paymentNamesRequirement(header)) throw new TwzrdWashAbortError(PAYMENT_DIFFERS_FROM_APPROVAL);
      for (const o of named.length > 0 ? named : cleared) paying.add(o);
    }
    book(slot, [...paying]);
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
        const own = calls.getStore();
        if (own) own.seen = true;
        const sent = paymentHeadersOf(requestHeadersOf(input, init));
        if (sent.length > 0) bookSent(own ?? detached, sent);
        const resp = await washed(input, init);
        if (resp.status !== 402) return resp;
        let challenge: unknown;
        try { challenge = await paymentRequiredFromResponse(resp); }
        catch { throw new TwzrdWashAbortError(PAYMENT_REQUIRED_UNREADABLE); }
        if (challenge == null) return handOver(resp);
        const accepts = (challenge as { accepts?: Array<Record<string, unknown>> }).accepts;
        const offers = distinctOffers(accepts);
        if (offers.length === 0 || offers.length > MAX_DISTINCT_OFFERS) {
          throw new TwzrdWashAbortError(offers.length === 0 ? "twzrd_unidentifiable_payment_recipient" : TOO_MANY_PAYMENT_OPTIONS);
        }
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const slot = own ?? detached;
        return inTurn(async () => {
          // A second 402 inside one call replaces what the first one held.
          release(slot);
          // Every entry the payer could choose must clear the policy (0.11.3), not just the preferred one.
          const cleared: ClearedOffer[] = [];
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
            cleared.push({ payTo: it.payTo, micro: toMicroUsd(it.amount), decision: d, approved: approvedRequirementOf(offer) });
          }
          handOver(resp);
          // The client may pay any entry (default selector: accepts[0]). Until its payment
          // names one, every recipient is held at its own price and the cumulative scopes at
          // the costliest, so no ceiling is undercounted while the payment is in flight.
          slot.cleared = cleared;
          slot.reserved = amountsFor(cleared);
          for (const [scope, micro] of slot.reserved) inflight.set(scope, (inflight.get(scope) ?? 0n) + micro);
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
        // A payer that left the call's context put its offers in the shared slot.
        const used = slot.seen ? slot : detached;
        // Offers still held here were cleared, and no request carrying a payment
        // for them went through the gated fetch. A payer that sends its payment
        // some other way is booked on the paid answer; an answer that is not 2xx
        // then leaves nothing to read, so such a payer must send through `gated`.
        const unpaid = used.cleared;
        if (r.ok && unpaid && unpaid.length > 0) book(used, unpaid);
        else release(used);
        return r;
      };
    },
  });
}
