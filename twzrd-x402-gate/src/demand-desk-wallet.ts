import { createHash } from "node:crypto";
import { verifyDemandDeskAuthorization, type DemandDeskAuthorizationExpectation } from "./demand-desk-authorization.js";
import type { AttemptState, OutcomeLedger } from "./outcome-ledger.js";

export type DemandDeskWalletContext = { authorization: unknown; messageHash: string };

/**
 * Optional replay guard backed by the buyer-side outcome ledger (#274).
 * `intentHash` must return the same key the caller passed to `ledger.begin`.
 */
export type DemandDeskReplayGuard<T> = {
  ledger: Pick<OutcomeLedger, "get" | "markSigning">;
  intentHash(tx: T, context: DemandDeskWalletContext): string;
};

export type DemandDeskWalletAdapter<T> = {
  /** These callbacks must decode the transaction itself, not caller metadata. */
  messageBytes(tx: T): Uint8Array;
  expectation(tx: T): DemandDeskAuthorizationExpectation;
  signTransaction(tx: T): Promise<T>;
  sendTransaction(tx: T): Promise<string>;
  /** Authenticated local mandate/revocation check, immediately before signing. */
  isActive(): boolean;
  /** When set, a second vault spend on an intent the ledger already holds is refused before signing. */
  replayGuard?: DemandDeskReplayGuard<T>;
};

/** Refusal reason code for a replayed vault spend. */
export const DEMAND_DESK_REPLAY_REASON = "vault_spend_replay" as const;

/**
 * Ledger states that refuse another vault spend on the same intent hash.
 * `signing` / `unknown`: the signer ran or may have run and settlement is not
 * known, so a second spend could double-pay. `completed` / `paid_incomplete`:
 * settlement is confirmed, so a second spend is a double payment.
 * `refused`, `expired`, `not_settled` never moved money and allow a new spend.
 * `approved` is the normal pre-sign state: the facade moves it to `signing`
 * itself, synchronously, immediately before invoking the signer.
 */
export const DEMAND_DESK_REPLAY_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>([
  "signing",
  "unknown",
  "completed",
  "paid_incomplete",
]);

export class DemandDeskReplayError extends Error {
  override name = "DemandDeskReplayError";
  readonly code = DEMAND_DESK_REPLAY_REASON;
  constructor(
    public readonly intentHash: string,
    public readonly state: AttemptState | "duplicate_in_batch",
  ) {
    super(DEMAND_DESK_REPLAY_REASON);
  }
}

export function demandDeskMessageHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Exclusive capability facade for SVM and ElizaOS wallet providers. The raw
 * signer is retained only in this closure. Verification and signer invocation
 * have no asynchronous gap; batch calls validate every item before signing any.
 * Without `replayGuard` the facade is stateless and one-use enforcement belongs
 * to the Desk. With it, the outcome ledger is consulted (and `approved` moved
 * to `signing`) in the same synchronous step as the signer call.
 */
export function createDemandDeskWallet<T>(adapter: DemandDeskWalletAdapter<T>) {
  function verify(tx: T, context: DemandDeskWalletContext): void {
    if (!adapter.isActive()) throw new Error("mandate_inactive");
    if (!context || demandDeskMessageHash(adapter.messageBytes(tx)) !== context.messageHash) {
      throw new Error("transaction_message_mismatch");
    }
    const result = verifyDemandDeskAuthorization(context.authorization, adapter.expectation(tx));
    if (!result.ok) throw new Error(`demand_desk_${result.code}`);
  }
  /** Returns the intent hash to mark, or null when no guard is configured. */
  function checkReplay(tx: T, context: DemandDeskWalletContext): string | null {
    const guard = adapter.replayGuard;
    if (!guard) return null;
    const hash = guard.intentHash(tx, context);
    if (typeof hash !== "string" || !hash) throw new Error("replay_guard_intent_hash_missing");
    const record = guard.ledger.get(hash);
    if (record && DEMAND_DESK_REPLAY_STATES.has(record.state)) throw new DemandDeskReplayError(hash, record.state);
    return hash;
  }
  function markSigning(hash: string | null): void {
    if (hash === null) return;
    const ledger = adapter.replayGuard!.ledger;
    // Re-read right before signing; markSigning throws on expiry or a state change.
    const record = ledger.get(hash);
    if (record && DEMAND_DESK_REPLAY_STATES.has(record.state)) throw new DemandDeskReplayError(hash, record.state);
    if (record?.state === "approved") ledger.markSigning(hash);
  }
  function signChecked(tx: T, hash: string | null): Promise<T> {
    markSigning(hash);
    return adapter.signTransaction(tx);
  }
  async function signTransaction(tx: T, context: DemandDeskWalletContext): Promise<T> {
    verify(tx, context);
    return signChecked(tx, checkReplay(tx, context));
  }
  return Object.freeze({
    signTransaction,
    async signAllTransactions(items: readonly { transaction: T; context: DemandDeskWalletContext }[]): Promise<T[]> {
      const hashes: (string | null)[] = [];
      const seen = new Set<string>();
      for (const item of items) {
        verify(item.transaction, item.context);
        const hash = checkReplay(item.transaction, item.context);
        if (hash !== null) {
          if (seen.has(hash)) throw new DemandDeskReplayError(hash, "duplicate_in_batch");
          seen.add(hash);
        }
        hashes.push(hash);
      }
      const signed: T[] = [];
      for (let i = 0; i < items.length; i++) signed.push(await signChecked(items[i]!.transaction, hashes[i]!));
      return signed;
    },
    async signAndSendTransaction(tx: T, context: DemandDeskWalletContext): Promise<string> {
      const signed = await signTransaction(tx, context);
      verify(signed, context);
      return adapter.sendTransaction(signed);
    },
  });
}
