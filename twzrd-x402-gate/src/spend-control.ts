/**
 * Product `twzrd.safeFetch` — challenge-bound spend control.
 * Not the AgentCash CLI adapter (`./safe-fetch`, advisory_precheck).
 * maxSpend is both the per-call cap and the cumulative budget checked
 * against agent, merchant, and mandate keys (same number).
 * Durable spend uses `sharedFileSpendLedger` (hash-chained
 * JSONL) via `ledger`, `ledgerFile`, or TWZRD_SPEND_LEDGER_FILE — not a
 * second ledger type. The default is one process-scoped in-memory ledger;
 * use `ledgerFile` for restart-safe cumulative enforcement.
 *
 * With a Track 6 WAL (`svmWal` / `svmWalFile`) the WAL is the only counter for
 * the payments it tracks: held while the intent is unresolved, spent once it
 * is confirmed, nothing once it failed. Those payments are not also written
 * to the spend ledger, so a restart cannot count one twice or drop it. The
 * ledger keeps counting payments made without a WAL, and the cap is the sum.
 */
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  isFatalGateRefusal,
  readSentinelState,
  sentinelPathSetting,
  writePauseSentinel,
} from "./binding-plane.js";
import { toMicroUsd } from "./intent.js";
import { classifyNetwork } from "./network.js";
import {
  payToFromRequirements,
  pickRequirements,
  priceUsdcFromAmountMicro,
  paymentRequiredFromResponse,
} from "./payto.js";
import {
  createMemorySpendLedger,
  type SpendLedger,
} from "./policy-runtime.js";
import { sharedFileSpendLedger } from "./spend-ledger-file.js";
import {
  rememberRawInvoice,
  resourceBindLeafHash,
  resourceBindLeafHashV2,
  resourceBindMemo,
  stampResourceBind,
  type ResourceBindReq,
  type ResourceBindSchema,
} from "./resource-bind.js";
import { evaluateResourceBindLegsFromSvmTx } from "./resource-bind-tx.js";
import {
  isWellFormedTxSignature,
  sharedFileSvmWal,
  type SvmWal,
  type SvmWalConfirmationStatus,
} from "./svm-wal.js";
import { resourceUrlFromPaymentRequired } from "./x402-client-hook.js";
import type { X402PaymentRequiredBody } from "./types.js";

/**
 * What the payer reports back. With a WAL, the payment is recorded as
 * confirmed only when this carries a well-formed `txSignature` and either
 * terminal chain evidence (`slot` plus a `confirmationStatus` of `confirmed`
 * or `finalized`) or a facilitator settlement the payer verified itself.
 * Anything less leaves the intent unresolved: the amount stays held and new
 * payments are refused until `recoverUnresolvedIntents` settles it.
 */
export type SpendControlPayResult = {
  transactionBase64?: string;
  response?: Response;
  txSignature?: string;
  /** Slot (or block number) the transaction landed in. */
  slot?: number;
  /** Commitment the payer observed. `processed` is not terminal. */
  confirmationStatus?: "processed" | SvmWalConfirmationStatus;
  /**
   * Set `verified: true` only after checking the facilitator's settlement
   * response for this payment; `facilitator` names who settled it.
   */
  facilitatorSettlement?: { verified: boolean; facilitator: string };
};

type SettlementEvidence = {
  txSignature: string;
  slot: number | null;
  confirmationStatus?: SvmWalConfirmationStatus;
  facilitator?: string;
};

/** The evidence in a payer result, or null when it does not prove a settled payment. */
function settlementEvidence(paid: SpendControlPayResult | null | undefined): SettlementEvidence | null {
  if (!paid || typeof paid !== "object") return null;
  const txSignature = typeof paid.txSignature === "string" ? paid.txSignature.trim() : "";
  if (!isWellFormedTxSignature(txSignature)) return null;
  const slot =
    typeof paid.slot === "number" && Number.isInteger(paid.slot) && paid.slot > 0 ? paid.slot : null;
  const status = paid.confirmationStatus;
  if (slot !== null && (status === "confirmed" || status === "finalized")) {
    return { txSignature, slot, confirmationStatus: status };
  }
  const settlement = paid.facilitatorSettlement;
  if (
    settlement &&
    settlement.verified === true &&
    typeof settlement.facilitator === "string" &&
    settlement.facilitator.trim().length > 0
  ) {
    return { txSignature, slot, facilitator: settlement.facilitator.trim() };
  }
  return null;
}

/**
 * When a rolling budget window has room for `amount` again. `spentAt(t)` is
 * the spend still inside the window at time `t`. Returns `now` if it already
 * fits (the cap was tripped by in-flight amounts, not by settled spend).
 */
function budgetWindowFreesAt(
  spentAt: (t: number) => bigint,
  amount: bigint,
  cap: bigint,
  now: number,
  windowMs: number,
): number {
  const fits = (t: number): boolean => spentAt(t) + amount <= cap;
  if (fits(now)) return now;
  let lo = now; // does not fit
  let hi = now + windowMs + 1; // everything recorded up to `now` has aged out
  if (!fits(hi)) return hi; // spend dated in the future: hold for the whole window
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export type SpendControlOptions = {
  maxSpend?: string;
  allowNetworks?: string[];
  requireOfferBinding?: boolean;
  /**
   * Opt-in. Fail closed (signerInvocations=0, pay() not called) when no
   * decision_id is available. Default off so existing offer-only binds stay v1.
   */
  requireDecisionBind?: boolean;
  /** Gate DecisionToken.decisionId. Also accepted on the preflight card. */
  decisionId?: string;
  /** Server-issued preflight_id. Also accepted on the preflight card. */
  preflightId?: number;
  fetch?: typeof fetch;
  pay?: (args: {
    url: string;
    paymentRequired: unknown;
    selected: Record<string, unknown>;
    /** Present after a hard bind-v1 verify on the compose path. */
    transactionBase64?: string;
  }) => Promise<SpendControlPayResult>;
  /**
   * Build, but do not sign or submit, the bound SVM transaction. Required
   * with `requireOfferBinding`; the gate verifies these exact bytes before it
   * calls `pay()`.
   */
  composeBoundTransaction?: (args: {
    url: string;
    paymentRequired: unknown;
    selected: Record<string, unknown>;
    leafHash: string;
    memo: string;
  }) => Promise<{ transactionBase64?: string }>;
  preflight?: (payTo: string, priceUsdc: number) => Promise<{
    decision?: string;
    preflight_id?: number;
    decisionId?: string;
  }>;
  ledger?: SpendLedger;
  /** Path for the hash-chained file ledger when `ledger` is omitted. */
  ledgerFile?: string;
  agentId?: string;
  mandateId?: string;
  /** Optional Track 5 binding-plane sentinel directory. */
  stateDir?: string;
  /** Explicit `.kill` sentinel path override. */
  killFilePath?: string;
  /** Explicit `.pause` sentinel path override. */
  pauseFilePath?: string;
  /**
   * Opt-in, default off. TTL (ms) for a `.pause` written when a payment is
   * refused for a fatal reason (see `isFatalGateRefusal`). A cumulative-cap
   * trip does not use this: it always pauses until the budget window has room.
   */
  tripPauseOnBlockMs?: number;
  /** Optional Track 6 SVM write-ahead log (WAL) instance. */
  svmWal?: SvmWal;
  /** Path for the Track 6 SVM write-ahead log JSONL file when `svmWal` is omitted. */
  svmWalFile?: string;
};

export type SpendControlResult = {
  verdict: "allow" | "warn" | "block";
  reason?: string;
  response?: Response;
  receipt?: { strength: string; leaf_hash: string | null; fact_type: "resource_bound" };
  signerInvocations: number;
  /**
   * Settled or replayed transaction signature when recorded in SvmWal. On a
   * `wal_unconfirmed_payment` refusal it is whatever the payer reported,
   * unverified, so the caller can hand it to recovery.
   */
  txSignature?: string;
};

export type OfferBindingCheck = {
  verdict: "allow" | "block";
  reason?: string;
  receipt: { strength: string; leaf_hash: string | null; fact_type: "resource_bound" };
};

/** Shared shape for a bind-v1 check that never reached verification. */
function refuseBindReceipt(leaf_hash: string | null): OfferBindingCheck["receipt"] {
  return { strength: "refuse", leaf_hash, fact_type: "resource_bound" };
}

/**
 * Bind-v1 check on the composed, not-yet-submitted transaction. Despite the
 * name (kept for compat with the 0.9.2 call site), `spendControlSafeFetch`
 * calls this BEFORE `pay()`: compose, then verify these exact bytes, then pay.
 */
export async function verifyOfferBindingAfterPay(args: {
  transactionBase64?: string;
  leafHash: string | null;
  payTo: string;
  asset: string;
  amountRaw: string;
  scheme?: string;
}): Promise<OfferBindingCheck> {
  const leaf_hash = args.leafHash ?? null;
  if (!args.transactionBase64) {
    return {
      verdict: "block",
      reason: "bind_required_no_settlement",
      receipt: refuseBindReceipt(leaf_hash),
    };
  }
  if (!leaf_hash) {
    // Distinct from "no settlement": a caller invoking this exported check
    // directly with no expected leaf hash cannot get a "hard" result — make
    // that an explicit refusal instead of silently verifying against "".
    return {
      verdict: "block",
      reason: "bind_required_no_leaf_hash",
      receipt: refuseBindReceipt(leaf_hash),
    };
  }
  const d = await evaluateResourceBindLegsFromSvmTx(args.transactionBase64, {
    leaf_hash,
    pay_to: args.payTo,
    asset: args.asset,
    amount_raw: args.amountRaw,
    scheme: String(args.scheme ?? ""),
  });
  const receipt: OfferBindingCheck["receipt"] = {
    strength: d.strength,
    leaf_hash: d.leaf_hash,
    fact_type: "resource_bound",
  };
  if (d.strength !== "hard") {
    return { verdict: "block", reason: "bind_mismatch", receipt };
  }
  return { verdict: "allow", receipt };
}

/**
 * Default cumulative enforcement must outlive an individual safeFetch call.
 * It is process-scoped only; callers that need restart safety must provide
 * `ledger` or `ledgerFile`. A file ledger is shared per resolved path within
 * this process (so concurrent calls append to one hash chain); it is not
 * multi-process safe — serialize across processes externally.
 */
const defaultMemoryLedger = createMemorySpendLedger();

/**
 * In-flight reservations per ledger, so concurrent calls in this process see
 * each other inside the check → pay → record window. Without this the
 * cumulative cap is a TOCTOU: two parallel calls both read spent=0, both
 * pass, both pay (W-2026-0902 #1).
 *
 * A reservation is taken SYNCHRONOUSLY in the same tick as the check (so no
 * other call can interleave between them) and released in `finally`. It is
 * keyed on the ledger INSTANCE, which is why `sharedFileSpendLedger` matters:
 * a per-call ledger object would give every call its own empty reservation map
 * and this would silently do nothing.
 *
 * Process-local by construction. Two processes sharing one ledger file still
 * race — see sharedFileSpendLedger's note.
 */
const pendingByLedger = new WeakMap<SpendLedger, Map<string, bigint>>();

function pendingFor(ledger: SpendLedger): Map<string, bigint> {
  let pending = pendingByLedger.get(ledger);
  if (!pending) pendingByLedger.set(ledger, (pending = new Map()));
  return pending;
}

/** Reserve `micro` under each key; returns the (idempotent) release. */
function reserveSpend(pending: Map<string, bigint>, keys: string[], micro: bigint): () => void {
  for (const key of keys) pending.set(key, (pending.get(key) ?? 0n) + micro);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const left = (pending.get(key) ?? 0n) - micro;
      if (left > 0n) pending.set(key, left);
      else pending.delete(key);
    }
  };
}

function netOk(network: string | undefined, payTo: string | undefined, allow?: string[]): boolean {
  if (!allow?.length) return true;
  const c = classifyNetwork(network, payTo);
  const n = (network ?? "").toLowerCase();
  return allow.some((a) => {
    const x = a.toLowerCase();
    if (x === "solana") return c.kind === "solana";
    if (x === "base") return n.includes("base") || n.includes("8453") || (c.kind === "evm" && n.includes("8453"));
    return n.includes(x) || c.kind === x;
  });
}

export async function spendControlSafeFetch(
  url: string,
  opts: SpendControlOptions = {},
): Promise<SpendControlResult> {
  // A set-but-empty setting is unset: it must not win over the fallback path.
  const stateDir = sentinelPathSetting(opts.stateDir, process.env.TWZRD_STATE_DIR);
  const killFilePath = sentinelPathSetting(opts.killFilePath, process.env.KILLSWITCH_KILL_FILE);
  const pauseFilePath = sentinelPathSetting(opts.pauseFilePath, process.env.KILLSWITCH_PAUSE_FILE);
  const rawTripPause = opts.tripPauseOnBlockMs ?? process.env.TWZRD_TRIP_PAUSE_ON_BLOCK_MS;
  const tripPauseNum =
    typeof rawTripPause === "number"
      ? rawTripPause
      : rawTripPause == null || rawTripPause === ""
        ? NaN
        : Number(rawTripPause);
  // Opt-in: unset, empty, zero, or unparsable all mean off.
  const tripPauseOnBlockMs =
    Number.isFinite(tripPauseNum) && tripPauseNum > 0 ? Math.floor(tripPauseNum) : 0;

  /** The refusal a `.kill` or an in-force `.pause` calls for right now, if any. */
  const sentinelRefusal = (): SpendControlResult | undefined => {
    const sentinel = readSentinelState({
      stateDir: stateDir ?? "./data",
      killFilePath,
      pauseFilePath,
    });
    if (!sentinel.active) return undefined;
    const reason =
      sentinel.mode === "kill"
        ? "twzrd_kill_switch"
        : sentinel.mode === "corrupt_pause"
          ? "twzrd_pause_corrupt"
          : "twzrd_payment_paused";
    return { verdict: "block", reason, signerInvocations: 0 };
  };
  const haltedOnEntry = sentinelRefusal();
  if (haltedOnEntry) return haltedOnEntry;

  const file = opts.ledgerFile ?? process.env.TWZRD_SPEND_LEDGER_FILE;
  const walFile = opts.svmWalFile ?? process.env.TWZRD_SVM_WAL_FILE;
  // Only a configured sentinel location is written: the file this gate (and
  // the compute plane) reads, never a guess next to the ledger or the WAL.
  const pauseTarget = pauseFilePath ?? (stateDir ? path.join(stateDir, ".pause") : undefined);

  const tripPause = (blockReason: string | undefined, decisionId?: string) => {
    if (tripPauseOnBlockMs > 0 && pauseTarget && isFatalGateRefusal(blockReason)) {
      try {
        writePauseSentinel(pauseTarget, {
          ttlMs: tripPauseOnBlockMs,
          reason: blockReason!,
          decisionId: decisionId ?? opts.decisionId ?? randomUUID(),
        });
      } catch {
        /* best-effort backpressure file write */
      }
    }
  };
  const blockResult = (res: SpendControlResult, decisionId?: string): SpendControlResult => {
    tripPause(res.reason, decisionId);
    return res;
  };

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // One shared instance per path: a per-call ledger corrupts the hash chain
  // under concurrency and gives the reservation below no stable identity.
  const ledger = opts.ledger ?? (file ? sharedFileSpendLedger(file) : defaultMemoryLedger);
  const wal = opts.svmWal ?? (walFile ? sharedFileSvmWal(walFile) : undefined);
  const res = await fetchImpl(url);
  if (res.status !== 402) return { verdict: "allow", response: res, signerInvocations: 0 };
  // AUDIT FIX: read PAYMENT-REQUIRED (base64 JSON, x402 v2) BEFORE the body —
  // the same precedence @x402/core's client uses to decide what to pay. Reading
  // only the body let a header-carried challenge reach the payer unscored.
  // The parser throws on an undecodable header (fail closed); safeFetch has
  // always answered with a verdict rather than an exception, so keep that.
  let body: X402PaymentRequiredBody | null;
  try {
    body = await paymentRequiredFromResponse(res);
  } catch {
    return blockResult({ verdict: "block", reason: "unparseable_402", signerInvocations: 0 });
  }
  if (body === null) {
    return blockResult({ verdict: "block", reason: "unparseable_402", signerInvocations: 0 });
  }
  rememberRawInvoice(body, url);
  const list = (body.accepts ?? []) as Array<Record<string, unknown>>;
  const filtered = opts.allowNetworks?.length
    ? list.filter((e) => netOk(String(e.network ?? ""), String(e.payTo ?? e.pay_to ?? ""), opts.allowNetworks))
    : list;
  if (opts.allowNetworks?.length && list.length > 0 && filtered.length === 0) {
    return blockResult({ verdict: "block", reason: "network_not_allowed", signerInvocations: 0 });
  }
  const selected = pickRequirements(filtered.length ? filtered : []) as Record<string, unknown>;
  if (!selected.resource) {
    const envUrl = resourceUrlFromPaymentRequired(body);
    if (envUrl) selected.resource = envUrl;
  }
  const { payTo, amountMicro, resource, conflict } = payToFromRequirements(selected as never);
  const network = selected.network as string | undefined;
  if (conflict) {
    // safeFetch has always reported a bad amount as malformed_amount; keep it.
    const reason = conflict === "amount_malformed" ? "malformed_amount" : conflict;
    return blockResult({ verdict: "block", reason, signerInvocations: 0 });
  }
  if (!payTo || amountMicro == null) {
    return blockResult({ verdict: "block", reason: "no_payable_requirement", signerInvocations: 0 });
  }
  // AUDIT FIX: "-100" / "0.5" / "1e6" previously slid under the cap or threw.
  if (!/^\d+$/.test(String(amountMicro))) {
    return blockResult({ verdict: "block", reason: "malformed_amount", signerInvocations: 0 });
  }
  // The budget counts `amount` as micro-USDC. Any other named asset is in its own
  // base units, so an 8-decimal mint would be counted ~100x low (0.11.1).
  if (priceUsdcFromAmountMicro(String(amountMicro), selected) === undefined) {
    return blockResult({ verdict: "block", reason: "non_usdc_asset", signerInvocations: 0 });
  }
  const spendMicro = BigInt(String(amountMicro));
  const maxMicro = opts.maxSpend != null ? toMicroUsd(opts.maxSpend) : undefined;
  if (maxMicro != null && spendMicro > maxMicro) {
    return blockResult({ verdict: "block", reason: "over_max_spend", signerInvocations: 0 });
  }
  const now = Date.now();
  const WIN = 365 * 24 * 3600 * 1000;
  const agentKey = `agent:${opts.agentId ?? "default"}`;
  const merchantKey = `merchant:${payTo}`;
  const mandateKey = `mandate:${opts.mandateId ?? "default"}`;
  // Idempotent: the success paths record before returning, and the finally
  // block records again for an ambiguous failure; the ledger must see one entry.
  // Never called for a payment the WAL tracks: that one is counted from its
  // WAL row alone.
  let recorded = false;
  const recordSpend = () => {
    if (recorded) return;
    recorded = true;
    ledger.record(agentKey, spendMicro, now);
    ledger.record(merchantKey, spendMicro, now);
    ledger.record(mandateKey, spendMicro, now);
  };
  // Set immediately before the payer runs. From then on the money may have moved,
  // so a throw from pay() is ambiguous and must be counted, never released.
  let signed = false;
  // Set once the WAL holds this payment's intent: from then on the WAL row is
  // its only counter and the spend ledger is not written.
  let walTracked = false;
  const keys = [agentKey, merchantKey, mandateKey];
  let release = (): void => {};
  // Spend still inside the budget window at time `at`: ledger rows plus what
  // the WAL holds or has confirmed for this key. Each payment is in one of them.
  const windowSpentMicro = (key: string, at: number): bigint =>
    ledger.spentMicro(key, WIN, at) +
    (wal
      ? wal.spentMicro({
          scope: key,
          payTo: key === merchantKey ? payTo : undefined,
          windowMs: WIN,
          now: at,
        })
      : 0n);
  /**
   * The cumulative cap is tripped. Refuse, and when a sentinel location is
   * configured write `.pause` until the budget window has room for this amount
   * again, so the compute plane stops re-reasoning about a payment that cannot
   * succeed. Never `.kill`: the halt ends with the window.
   */
  const capTrip = (decisionId?: string): SpendControlResult => {
    if (pauseTarget && maxMicro != null) {
      const at = Date.now();
      let until = at;
      for (const key of keys) {
        const freesAt = budgetWindowFreesAt((t) => windowSpentMicro(key, t), spendMicro, maxMicro, at, WIN);
        if (freesAt > until) until = freesAt;
      }
      if (until > at) {
        try {
          writePauseSentinel(pauseTarget, {
            ttlMs: until - at,
            now: at,
            reason: "over_cumulative_spend",
            decisionId: decisionId ?? opts.decisionId ?? randomUUID(),
          });
        } catch {
          /* best-effort backpressure file write; the refusal stands either way */
        }
      }
    }
    return { verdict: "block", reason: "over_cumulative_spend", signerInvocations: 0 };
  };
  let overCap = false;
  if (maxMicro != null) {
    const pending = pendingFor(ledger);
    overCap = keys.some(
      (key) => windowSpentMicro(key, now) + (pending.get(key) ?? 0n) + spendMicro > maxMicro,
    );
    // With a WAL the refusal waits for the WAL lookup below: a retry of an
    // already-settled challenge returns its receipt, and an unresolved intent
    // is reported as the freeze it is, before either is called a cap trip.
    if (overCap && !wal) return capTrip();
    // No await between the check above and this reservation: that is what
    // makes check+reserve atomic for concurrent calls on this event loop.
    if (!overCap) release = reserveSpend(pending, keys, spendMicro);
  }
  // The payer only ever sees the offer the gate approved. Handing it the whole
  // accepts[] lets a client that ignores `selected` pick an unvetted sibling.
  const offer = { ...body, accepts: [selected] };
  try {
    let verdict: "allow" | "warn" | "block" = "allow";
    const price = priceUsdcFromAmountMicro(amountMicro, selected) ?? 0;
    let decisionId = typeof opts.decisionId === "string" && opts.decisionId.length > 0
      ? opts.decisionId : undefined;
    let preflightId = typeof opts.preflightId === "number" ? opts.preflightId : undefined;
    if (opts.preflight) {
      const card = await opts.preflight(payTo, price);
      if (typeof card.decisionId === "string" && card.decisionId.length > 0) {
        decisionId = card.decisionId;
      }
      if (typeof card.preflight_id === "number") preflightId = card.preflight_id;
      if (card.decision === "block") {
        return blockResult({ verdict: "block", reason: "intel_block", signerInvocations: 0 }, decisionId);
      }
      if (card.decision === "warn") verdict = "warn";
    }
    if (opts.requireDecisionBind && !decisionId) {
      return blockResult({ verdict: "block", reason: "decision_bind_required", signerInvocations: 0 }, decisionId);
    }
    let stamped = null as ReturnType<typeof stampResourceBind> | null;
    if (opts.requireOfferBinding) {
      stamped = stampResourceBind(
        selected as ResourceBindReq,
        body,
        decisionId ? { decision_id: decisionId, preflight_id: preflightId } : undefined,
      );
    }
    const bindReq: ResourceBindReq = {
      payTo,
      amount: String(amountMicro),
      asset: String(selected.asset ?? ""),
      network: String(selected.network ?? ""),
      resource: String(resource ?? url),
      scheme: String(selected.scheme ?? "exact"),
    };
    const walChallengeHash =
      stamped?.leaf_hash ??
      (decisionId
        ? resourceBindLeafHashV2(bindReq, { decision_id: decisionId, preflight_id: preflightId })
        : resourceBindLeafHash(bindReq));

    if (wal) {
      const existing = wal.lookupChallenge(walChallengeHash);
      if (existing.state === "confirmed") {
        return {
          verdict,
          response: res,
          signerInvocations: 0,
          ...(existing.receipt.tx_signature ? { txSignature: existing.receipt.tx_signature } : {}),
        };
      }
      if (wal.hasUnresolvedIntent()) {
        return blockResult(
          { verdict: "block", reason: "wal_unresolved_intent", signerInvocations: 0 },
          decisionId,
        );
      }
      if (overCap) return capTrip(decisionId);
    }

    let response = res;
    let txb64: string | undefined;
    let signerInvocations = 0;
    let settledTxSig: string | undefined;
    /**
     * Last look. The entry check ran before the 402 fetch, the preflight, and
     * the compose were awaited; a `.kill` or `.pause` can land during any of
     * them. Read again at the moment of the go-ahead: nothing is awaited
     * between this read and the payer call, and it runs before the WAL intent
     * is written, so a refused payment leaves no row and holds no budget.
     */
    const lastLook = (receipt: SpendControlResult["receipt"]): SpendControlResult | undefined => {
      const halted = sentinelRefusal();
      return halted ? { ...halted, ...(receipt ? { receipt } : {}) } : undefined;
    };
    /**
     * Run the payer. With a WAL: write and fsync the intent first, hand the
     * in-process reservation over to that row, then record `confirmed` only on
     * evidence. Returns a refusal, or undefined when the payment went through.
     */
    const runPayer = async (
      receipt: SpendControlResult["receipt"],
      transactionBase64?: string,
    ): Promise<SpendControlResult | undefined> => {
      const halted = lastLook(receipt);
      if (halted) return halted;
      let walIntentId: string | undefined;
      if (wal) {
        try {
          walIntentId = wal.appendIntent({
            challengeHash: walChallengeHash,
            paymentDecisionId: decisionId ?? "unbound",
            payTo,
            amountMicro: String(amountMicro),
            network: String(network ?? "solana"),
            spendScopes: keys,
          }).intent_id;
        } catch {
          return blockResult(
            {
              verdict: "block",
              reason: "wal_intent_write_failed",
              ...(receipt ? { receipt } : {}),
              signerInvocations: 0,
            },
            decisionId,
          );
        }
        // The durable intent row now holds the amount. Dropping the reservation
        // in the same tick keeps the in-flight payment counted exactly once.
        walTracked = true;
        release();
      }
      signerInvocations = 1;
      signed = true;
      const paid = await opts.pay!({
        url,
        paymentRequired: offer,
        selected,
        ...(transactionBase64 !== undefined ? { transactionBase64 } : {}),
      });
      if (paid?.response) response = paid.response;
      settledTxSig = typeof paid?.txSignature === "string" ? paid.txSignature : undefined;
      if (!wal || !walIntentId) {
        recordSpend();
        return undefined;
      }
      const evidence = settlementEvidence(paid);
      if (!evidence) {
        // The signer ran and nothing proves the outcome. No receipt is written:
        // the intent stays unresolved, its amount stays held, and new payments
        // are refused until recovery settles it one way or the other.
        return blockResult(
          {
            verdict: "block",
            reason: "wal_unconfirmed_payment",
            ...(paid?.response ? { response: paid.response } : {}),
            ...(receipt ? { receipt } : {}),
            signerInvocations,
            ...(settledTxSig ? { txSignature: settledTxSig } : {}),
          },
          decisionId,
        );
      }
      wal.appendReceipt({
        intentId: walIntentId,
        status: "confirmed",
        txSignature: evidence.txSignature,
        slot: evidence.slot,
        confirmationStatus: evidence.confirmationStatus ?? null,
        facilitator: evidence.facilitator ?? null,
      });
      settledTxSig = evidence.txSignature;
      return undefined;
    };
    if (opts.requireOfferBinding) {
      const leaf_hash = stamped?.leaf_hash ?? null;
      const refuseNoCompose = (): SpendControlResult =>
        blockResult({
          verdict: "block",
          reason: "bind_required_no_compose",
          signerInvocations: 0,
          receipt: refuseBindReceipt(leaf_hash),
        }, decisionId);
      if (!leaf_hash || !opts.composeBoundTransaction) {
        return refuseNoCompose();
      }
      const schema: ResourceBindSchema = decisionId ? 2 : 1;
      const composed = await opts.composeBoundTransaction({
        url, paymentRequired: offer, selected, leafHash: leaf_hash,
        memo: resourceBindMemo(leaf_hash, schema),
      });
      txb64 = composed.transactionBase64;
      if (!txb64) {
        return refuseNoCompose();
      }
      const checked = await verifyOfferBindingAfterPay({
        transactionBase64: txb64,
        leafHash: leaf_hash,
        payTo,
        asset: String(selected.asset ?? ""),
        amountRaw: String(amountMicro),
        scheme: String(selected.scheme ?? ""),
      });
      const receipt = checked.receipt;
      if (checked.verdict === "block") {
        return blockResult(
          { verdict: "block", reason: checked.reason ?? "bind_mismatch", receipt, signerInvocations: 0 },
          decisionId,
        );
      }
      // Without a payer the caller signs on this verdict: same last look.
      const refusal = opts.pay ? await runPayer(receipt, txb64) : lastLook(receipt);
      if (refusal) return refusal;
      return {
        verdict,
        response,
        receipt,
        signerInvocations,
        ...(settledTxSig ? { txSignature: settledTxSig } : {}),
      };
    }
    // Without a payer the caller signs on this verdict: same last look.
    const refusal = opts.pay ? await runPayer(undefined) : lastLook(undefined);
    if (refusal) return refusal;
    let receipt: SpendControlResult["receipt"];
    return {
      verdict,
      response,
      receipt,
      signerInvocations,
      ...(settledTxSig ? { txSignature: settledTxSig } : {}),
    };
  } finally {
    // Runs after recordSpend() on the success paths (both synchronous), so
    // there is no instant where neither the record nor the reservation counts.
    // If pay() threw after the signer ran without a WAL, the outcome is unknown:
    // commit the spend (conservative) before dropping the reservation. A payment
    // the WAL tracks is never written here: its unresolved payment_intent row
    // holds the budget until recoverUnresolvedIntents resolves it, and its
    // confirmed receipt is what counts afterwards.
    if (signed && !walTracked) recordSpend();
    release();
  }
}

export const twzrd = { safeFetch: spendControlSafeFetch };
