/**
 * Hold approved spend until the payment is actually let through.
 *
 * evaluateIntent() checks the ledger caps and records the spend in one
 * synchronous step, which is what stops two concurrent offers from both
 * clearing one ceiling. A seat that still has gates to run after that
 * decision (a paid clearance, a required receipt, a last halt read) must not
 * leave the record behind when one of them refuses. A payment that was never
 * signed would then count against the daily ceiling, the mandate and the
 * new-counterparty cap, so anyone able to make the agent fetch a paid URL
 * could use up the budget without a payment being made.
 *
 * createSpendReservation(ledger) returns a view of the ledger to evaluate
 * against. Reads see recorded spend plus every reservation in flight on that
 * ledger in this process, so concurrent evaluations still see each other.
 * Records are held as a reservation: commit() writes them to the ledger,
 * release() drops whatever was not committed.
 *
 * Process-local, keyed on the ledger instance, like the reservations in
 * spend-control.ts.
 */
import type { SpendLedger } from "./policy-runtime.js";

const inFlight = new WeakMap<SpendLedger, Map<string, bigint>>();

export type SpendReservation = {
  /** Evaluate against this, not the ledger itself. */
  ledger: SpendLedger;
  /** Write the held records to the ledger. Call when the payment is let through. */
  commit(): void;
  /** Drop what was not committed. Idempotent; a no-op after commit(). */
  release(): void;
};

export function createSpendReservation(ledger: SpendLedger): SpendReservation {
  let reserved = inFlight.get(ledger);
  if (!reserved) inFlight.set(ledger, (reserved = new Map()));
  const pending = reserved;
  const held: Array<{ scopeKey: string; micro: bigint; at: number }> = [];

  const drop = (): Array<{ scopeKey: string; micro: bigint; at: number }> => {
    const dropped = held.splice(0);
    for (const h of dropped) {
      const left = (pending.get(h.scopeKey) ?? 0n) - h.micro;
      if (left > 0n) pending.set(h.scopeKey, left);
      else pending.delete(h.scopeKey);
    }
    return dropped;
  };

  return {
    ledger: {
      spentMicro: (scopeKey, windowMs, now) =>
        ledger.spentMicro(scopeKey, windowMs, now) + (pending.get(scopeKey) ?? 0n),
      record(scopeKey, amountMicro, at) {
        pending.set(scopeKey, (pending.get(scopeKey) ?? 0n) + amountMicro);
        held.push({ scopeKey, micro: amountMicro, at });
      },
      firstSeen: (scopeKey) => ledger.firstSeen(scopeKey),
    },
    commit() {
      // Synchronous from the drop to the last record: no evaluation can read
      // the ledger between the reservation leaving and the spend arriving.
      for (const h of drop()) ledger.record(h.scopeKey, h.micro, h.at);
    },
    release() {
      drop();
    },
  };
}
