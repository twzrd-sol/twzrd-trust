/**
 * Buyer-side outcome ledger: one durable record per approved payment attempt,
 * keyed on the intent hash, with the "about to sign" row written to disk
 * BEFORE the signer is invoked.
 *
 * Why this exists (docs/OUTCOME_CONTRACT.md has the full walkthrough):
 *
 *   - The V1 outcome attestation (outcome-attestation.ts) can say settled,
 *     blocked_never_signed or expired_unused. It cannot say "we signed and do
 *     not know what happened". spend-control.ts handles that case only as a
 *     conservative cap debit and then rethrows a bare error. Nothing stops the
 *     next attempt on the same intent except budget arithmetic.
 *   - A fresh approval must not bypass an unresolved payment. That rule needs
 *     a state that survives the process, because the common way to lose track
 *     of a signed payment is for the process to die while waiting.
 *
 * States
 *   approved         approval bound and recorded; signer not yet invoked
 *   refused          terminal: a check failed before signing (never signed)
 *   expired          terminal: approval expired before the signer ran
 *   signing          the signer is about to be / is being invoked. A record
 *                    found in this state after a restart IS an unknown outcome.
 *   unknown          signed (or may have signed) and settlement is not known
 *   completed        terminal: settlement confirmed, spend within cap,
 *                    result passed the bound validation rule
 *   paid_incomplete  terminal: settlement confirmed, but the result failed
 *                    validation or the spend exceeded the approval
 *   not_settled      terminal: an unknown attempt was reconciled and no
 *                    settlement was found
 *
 * Unresolved states (block any new attempt on the same intent hash, whatever
 * the decision id): approved, signing, unknown. Terminal states allow a new
 * attempt only under a NEW decision id; an approval is single-use.
 *
 * Storage is append-only JSONL with a sha256 hash chain, replayed on open,
 * failing closed on a damaged file (same discipline as spend-ledger-file.ts).
 * Every write is a synchronous append that completes before the in-memory
 * state changes: if the append fails the transition did not happen. This
 * survives process death (not power loss: there is no fsync). Single-process
 * writer only.
 *
 * Local only. Nothing here makes a network call or verifies settlement; the
 * caller supplies settlement facts from its own reconciliation (facilitator
 * PAYMENT-RESPONSE, chain lookup). This ledger records what was established
 * and refuses to let an attempt proceed until something is.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export const OUTCOME_LEDGER_SCHEMA = "twzrd.outcome.v1";

export type AttemptState =
  | "approved"
  | "refused"
  | "expired"
  | "signing"
  | "unknown"
  | "completed"
  | "paid_incomplete"
  | "not_settled";

export const UNRESOLVED_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>([
  "approved",
  "signing",
  "unknown",
]);

export const TERMINAL_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>([
  "refused",
  "expired",
  "completed",
  "paid_incomplete",
  "not_settled",
]);

/**
 * What the approval commits to. The intent hash is computed by the caller
 * (intent.ts `intentHash`) and is the ledger key; the binding is stored so a
 * reviewer can see what the key covered without recomputing it.
 */
export type ApprovalBinding = {
  /** Receiving counterparty (payTo). */
  payTo: string;
  /** CAIP-2 network. */
  network: string;
  /** Asset identifier (mint / contract). */
  asset: string;
  /** Merchant charge in the asset's base units, as a decimal string. */
  amountAtomic: string;
  /**
   * Maximum all-in spend (merchant charge + assessment + network fees) in the
   * same asset's base units. Defaults to amountAtomic when omitted, which
   * means any fee at all makes the attempt paid_incomplete.
   */
  maxAllInAtomic?: string;
  request: {
    method: string;
    /**
     * Origin + path only. Query strings carry tokens and never reach the
     * file; the query is committed to through `queryHash`.
     */
    url: string;
    /** Hex hash of the exact request body; "" for no body. */
    bodyHash: string;
    /** Hex hash of the query string (without "?"); "" for none. */
    queryHash?: string;
    /** Hex hash over the headers the approval considers relevant, if any. */
    headersHash?: string;
  };
  /**
   * The logical operation this attempt belongs to, when the buyer named one.
   * Absent: the operation is derived from the bound request (method, URL,
   * query hash, body hash). One operation may hold one unresolved attempt at
   * a time whatever the terms, so a changed-price retry cannot sign while the
   * first payment is still unknown.
   */
  operationId?: string;
  /** ISO-8601 expiry of the approval. */
  expiresAt: string;
  /**
   * Success criteria bound into the approval. `ruleVersion` is required so a
   * "completed" outcome names the rule that judged it.
   */
  validation: {
    schemaId?: string;
    ruleVersion: string;
  };
};

export type SettlementFact = {
  settlementTx: string;
  /** Merchant charge actually settled, base units. */
  amountAtomic: string;
  /** Fees actually paid on top, base units; "0" when none. */
  feesAtomic?: string;
};

export type ValidationFact = {
  ok: boolean;
  /** Must equal the approval's validation.ruleVersion or the result is paid_incomplete. */
  ruleVersion: string;
  /** Free-form reason codes, e.g. "schema_mismatch", "empty_body". */
  reasonCodes?: string[];
};

export type AttemptRecord = {
  schema: typeof OUTCOME_LEDGER_SCHEMA;
  intentHash: string;
  decisionId: string;
  state: AttemptState;
  approval: ApprovalBinding;
  /** Unix ms of the first row. */
  openedAt: number;
  /** Unix ms of the latest row. */
  updatedAt: number;
  /** Reason codes from refuse / validation failure / reconcile. */
  reasonCodes: string[];
  /** Why the outcome became unknown (error name / message class), if it did. */
  unknownCause: string | null;
  settlement: (SettlementFact & { allInAtomic: string; withinCap: boolean }) | null;
  validation: ValidationFact | null;
  /** Ordered state history for review. */
  history: Array<{ at: number; state: AttemptState }>;
};

export type CanAttemptResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unresolved_attempt"
        | "approval_already_used"
        | "approval_reused_after_terminal";
      record: AttemptRecord | null;
    };

export type OutcomeLedger = {
  /**
   * Whether a new attempt under this (intentHash, decisionId) may begin. An
   * `approved` record whose expiry has passed does not block: no signer ran.
   */
  canAttempt(intentHash: string, decisionId: string, now?: number): CanAttemptResult;
  /** Record an approval. Throws OutcomeLedgerBlockedError when canAttempt is false. */
  begin(input: { intentHash: string; decisionId: string; approval: ApprovalBinding; now?: number }): AttemptRecord;
  /** approved -> refused. Never after signing. */
  refuse(intentHash: string, input: { reasonCodes: string[]; now?: number }): AttemptRecord;
  /**
   * approved -> signing. Call IMMEDIATELY before invoking the signer; the row
   * is on disk when this returns. Throws (and records `expired`) when the
   * approval has expired.
   */
  markSigning(intentHash: string, now?: number): AttemptRecord;
  /** signing -> unknown. Call from the catch around the signer / send. */
  markUnknown(intentHash: string, input: { cause: string; now?: number }): AttemptRecord;
  /**
   * signing | unknown -> completed | paid_incomplete. The caller has settlement
   * confirmation and has run the bound validation rule.
   */
  complete(
    intentHash: string,
    input: { settlement: SettlementFact; validation: ValidationFact; now?: number },
  ): AttemptRecord;
  /**
   * signing | unknown -> not_settled. The caller reconciled against the
   * settlement source of truth and found no settlement for this attempt.
   */
  markNotSettled(intentHash: string, input: { reasonCodes?: string[]; now?: number }): AttemptRecord;
  /**
   * approved -> expired, only when the approval's expiry has passed and no
   * signer ran. Returns the expired record, or null when the record is not a
   * lapsed approval (any other state, including signing and unknown, is left
   * exactly as it is: time alone never resolves a payment).
   */
  lapse(intentHash: string, now?: number): AttemptRecord | null;
  /** Latest attempt on this intent hash. Earlier attempts remain in the file only. */
  get(intentHash: string): AttemptRecord | null;
  /** Every record currently in an unresolved state. Reconcile these before paying again. */
  unresolved(): AttemptRecord[];
};

export class OutcomeLedgerBlockedError extends Error {
  override name = "OutcomeLedgerBlockedError";
  constructor(
    public readonly reason: Exclude<CanAttemptResult, { ok: true }>["reason"],
    public readonly record: AttemptRecord | null,
  ) {
    super(`[twzrd-x402-gate] outcome ledger refused a new attempt: ${reason}`);
  }
}

/** Thrown by markSigning when the approval expired first; the record is now `expired` and the signer was not invoked. */
export class OutcomeLedgerExpiredError extends Error {
  override name = "OutcomeLedgerExpiredError";
  constructor(public readonly record: AttemptRecord) {
    super(`[twzrd-x402-gate] outcome ledger: approval expired at ${record.approval.expiresAt}; signer not invoked`);
  }
}

export class OutcomeLedgerTransitionError extends Error {
  override name = "OutcomeLedgerTransitionError";
  constructor(
    public readonly intentHash: string,
    public readonly from: AttemptState | null,
    public readonly to: AttemptState,
  ) {
    super(`[twzrd-x402-gate] outcome ledger: ${from ?? "(none)"} -> ${to} is not a legal transition`);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const GENESIS = "genesis";

/** One row per transition. `prev` chains to the previous line's sha256. */
type Row = {
  schema: typeof OUTCOME_LEDGER_SCHEMA;
  at: number;
  intent_hash: string;
  decision_id: string;
  state: AttemptState;
  /** Present only on the opening row. */
  approval?: ApprovalBinding;
  reason_codes?: string[];
  unknown_cause?: string;
  settlement?: SettlementFact;
  validation?: ValidationFact;
  prev: string;
};

const ATOMIC_RE = /^(0|[1-9][0-9]*)$/;

function atomic(value: string | undefined, field: string, fallback?: string): bigint {
  const v = value ?? fallback;
  if (v === undefined || !ATOMIC_RE.test(v)) {
    throw new TypeError(`[twzrd-x402-gate] outcome ledger: ${field} must be a base-unit decimal string`);
  }
  return BigInt(v);
}

function assertBinding(a: ApprovalBinding): void {
  for (const k of ["payTo", "network", "asset"] as const) {
    if (typeof a[k] !== "string" || !a[k]) throw new TypeError(`[twzrd-x402-gate] outcome ledger: approval.${k} required`);
  }
  atomic(a.amountAtomic, "approval.amountAtomic");
  atomic(a.maxAllInAtomic, "approval.maxAllInAtomic", a.amountAtomic);
  if (!a.request || typeof a.request.method !== "string" || typeof a.request.url !== "string" || typeof a.request.bodyHash !== "string") {
    throw new TypeError("[twzrd-x402-gate] outcome ledger: approval.request {method,url,bodyHash} required");
  }
  if (!Number.isFinite(Date.parse(a.expiresAt))) {
    throw new TypeError("[twzrd-x402-gate] outcome ledger: approval.expiresAt must parse");
  }
  if (!a.validation || typeof a.validation.ruleVersion !== "string" || !a.validation.ruleVersion) {
    throw new TypeError("[twzrd-x402-gate] outcome ledger: approval.validation.ruleVersion required");
  }
}

/** Pure state machine over rows; the file layer only adds durability. */
function applyRow(records: Map<string, AttemptRecord>, usedDecisions: Set<string>, row: Row): AttemptRecord {
  const existing = records.get(row.intent_hash) ?? null;
  let rec: AttemptRecord;
  if (row.state === "approved") {
    if (!row.approval) throw new Error("[twzrd-x402-gate] outcome ledger: approved row without approval");
    rec = {
      schema: OUTCOME_LEDGER_SCHEMA,
      intentHash: row.intent_hash,
      decisionId: row.decision_id,
      state: "approved",
      approval: row.approval,
      openedAt: row.at,
      updatedAt: row.at,
      reasonCodes: [],
      unknownCause: null,
      settlement: null,
      validation: null,
      history: [{ at: row.at, state: "approved" }],
    };
    usedDecisions.add(row.decision_id);
  } else {
    if (!existing) throw new OutcomeLedgerTransitionError(row.intent_hash, null, row.state);
    rec = { ...existing, state: row.state, updatedAt: row.at, history: [...existing.history, { at: row.at, state: row.state }] };
    if (row.reason_codes) rec.reasonCodes = [...rec.reasonCodes, ...row.reason_codes];
    if (row.unknown_cause !== undefined) rec.unknownCause = row.unknown_cause;
    if (row.settlement) {
      const all = atomic(row.settlement.amountAtomic, "settlement.amountAtomic") + atomic(row.settlement.feesAtomic, "settlement.feesAtomic", "0");
      const cap = atomic(rec.approval.maxAllInAtomic, "approval.maxAllInAtomic", rec.approval.amountAtomic);
      rec.settlement = { ...row.settlement, allInAtomic: all.toString(), withinCap: all <= cap };
    }
    if (row.validation) rec.validation = row.validation;
  }
  records.set(row.intent_hash, rec);
  return rec;
}

const LEGAL: Record<AttemptState, ReadonlySet<AttemptState>> = {
  approved: new Set<AttemptState>(["refused", "expired", "signing"]),
  signing: new Set<AttemptState>(["unknown", "completed", "paid_incomplete", "not_settled"]),
  unknown: new Set<AttemptState>(["completed", "paid_incomplete", "not_settled"]),
  refused: new Set(),
  expired: new Set(),
  completed: new Set(),
  paid_incomplete: new Set(),
  not_settled: new Set(),
};

type Sink = (line: string) => void;

function createLedger(records: Map<string, AttemptRecord>, usedDecisions: Set<string>, lastHashInit: string, sink: Sink): OutcomeLedger {
  let lastHash = lastHashInit;

  function commit(partial: Omit<Row, "schema" | "prev">): AttemptRecord {
    const row: Row = { schema: OUTCOME_LEDGER_SCHEMA, ...partial, prev: lastHash };
    const line = JSON.stringify(row);
    // Disk before memory: a transition that did not reach the sink did not happen.
    sink(line);
    lastHash = sha256(line);
    return applyRow(records, usedDecisions, row);
  }

  function transition(intentHash: string, to: AttemptState, extra: Partial<Row>, now: number): AttemptRecord {
    const cur = records.get(intentHash) ?? null;
    if (!cur || !LEGAL[cur.state].has(to)) throw new OutcomeLedgerTransitionError(intentHash, cur?.state ?? null, to);
    return commit({ at: now, intent_hash: intentHash, decision_id: cur.decisionId, state: to, ...extra });
  }

  /** True when an `approved` record's expiry has passed: it never reached the signer, so it may lapse. */
  const approvedLapsed = (cur: AttemptRecord, now: number) =>
    cur.state === "approved" && !(now < Date.parse(cur.approval.expiresAt));

  function canAttempt(intentHash: string, decisionId: string, now: number = Date.now()): CanAttemptResult {
    const cur = records.get(intentHash) ?? null;
    // A lapsed approval is not an unresolved payment: no signer ran. `signing` and
    // `unknown` never lapse this way; they are exactly the case that must stay blocked.
    if (cur && UNRESOLVED_STATES.has(cur.state) && !approvedLapsed(cur, now)) {
      return { ok: false, reason: "unresolved_attempt", record: cur };
    }
    if (cur && cur.decisionId === decisionId) return { ok: false, reason: "approval_reused_after_terminal", record: cur };
    if (usedDecisions.has(decisionId)) return { ok: false, reason: "approval_already_used", record: cur };
    return { ok: true };
  }

  return {
    canAttempt,
    begin({ intentHash, decisionId, approval, now = Date.now() }) {
      if (typeof intentHash !== "string" || !intentHash) throw new TypeError("[twzrd-x402-gate] outcome ledger: intentHash required");
      if (typeof decisionId !== "string" || !decisionId) throw new TypeError("[twzrd-x402-gate] outcome ledger: decisionId required");
      assertBinding(approval);
      const cur = records.get(intentHash) ?? null;
      if (cur && approvedLapsed(cur, now)) {
        // Record the lapse before opening the new attempt so the chain shows why the old one ended.
        transition(intentHash, "expired", { reason_codes: ["approval_expired"] }, now);
      }
      const verdict = canAttempt(intentHash, decisionId, now);
      if (!verdict.ok) throw new OutcomeLedgerBlockedError(verdict.reason, verdict.record);
      return commit({ at: now, intent_hash: intentHash, decision_id: decisionId, state: "approved", approval });
    },
    refuse(intentHash, { reasonCodes, now = Date.now() }) {
      return transition(intentHash, "refused", { reason_codes: reasonCodes }, now);
    },
    lapse(intentHash, now = Date.now()) {
      const cur = records.get(intentHash) ?? null;
      if (!cur || !approvedLapsed(cur, now)) return null;
      return transition(intentHash, "expired", { reason_codes: ["approval_expired"] }, now);
    },
    markSigning(intentHash, now = Date.now()) {
      const cur = records.get(intentHash) ?? null;
      if (!cur || cur.state !== "approved") throw new OutcomeLedgerTransitionError(intentHash, cur?.state ?? null, "signing");
      const expiresAtMs = Date.parse(cur.approval.expiresAt);
      // Unparseable or past expiry both fail closed, matching decision-token.ts.
      if (!(now < expiresAtMs)) {
        const expired = transition(intentHash, "expired", { reason_codes: ["approval_expired"] }, now);
        throw new OutcomeLedgerExpiredError(expired);
      }
      return transition(intentHash, "signing", {}, now);
    },
    markUnknown(intentHash, { cause, now = Date.now() }) {
      return transition(intentHash, "unknown", { unknown_cause: String(cause) }, now);
    },
    complete(intentHash, { settlement, validation, now = Date.now() }) {
      const cur = records.get(intentHash) ?? null;
      if (!cur) throw new OutcomeLedgerTransitionError(intentHash, null, "completed");
      if (typeof settlement.settlementTx !== "string" || !settlement.settlementTx) {
        throw new TypeError("[twzrd-x402-gate] outcome ledger: complete() requires settlement.settlementTx; without one the outcome is still unknown");
      }
      const all = atomic(settlement.amountAtomic, "settlement.amountAtomic") + atomic(settlement.feesAtomic, "settlement.feesAtomic", "0");
      const cap = atomic(cur.approval.maxAllInAtomic, "approval.maxAllInAtomic", cur.approval.amountAtomic);
      const reasons: string[] = [...(validation.reasonCodes ?? [])];
      if (!validation.ok && reasons.length === 0) reasons.push("validation_failed");
      if (validation.ruleVersion !== cur.approval.validation.ruleVersion) reasons.push("validation_rule_mismatch");
      if (all > cap) reasons.push("spend_exceeds_approval");
      const to: AttemptState = validation.ok && reasons.length === 0 ? "completed" : "paid_incomplete";
      return transition(intentHash, to, { settlement, validation, reason_codes: reasons }, now);
    },
    markNotSettled(intentHash, { reasonCodes = [], now = Date.now() }) {
      return transition(intentHash, "not_settled", { reason_codes: reasonCodes }, now);
    },
    get: (intentHash) => records.get(intentHash) ?? null,
    unresolved: () => [...records.values()].filter((r) => UNRESOLVED_STATES.has(r.state)),
  };
}

/** In-memory ledger. Tests and single-shot processes only: nothing survives exit. */
export function createMemoryOutcomeLedger(): OutcomeLedger {
  return createLedger(new Map(), new Set(), GENESIS, () => {});
}

/**
 * File-backed ledger. Replays the file on open and fails closed on a corrupt
 * or chain-broken file: a damaged outcome record must never read as "nothing
 * unresolved".
 */
export function createFileOutcomeLedger(filePath: string): OutcomeLedger {
  const records = new Map<string, AttemptRecord>();
  const used = new Set<string>();
  let lastHash = GENESIS;
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dirname(filePath), { recursive: true });
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      throw new Error(`[twzrd-x402-gate] outcome ledger corrupt row: ${filePath}`);
    }
    if (row.schema !== OUTCOME_LEDGER_SCHEMA) throw new Error(`[twzrd-x402-gate] outcome ledger unknown schema: ${filePath}`);
    if (row.prev !== lastHash) throw new Error(`[twzrd-x402-gate] outcome ledger chain broken: ${filePath}`);
    applyRow(records, used, row);
    lastHash = sha256(line);
  }
  return createLedger(records, used, lastHash, (line) => appendFileSync(filePath, line + "\n"));
}

/** One instance per path per process; see spend-ledger-file.ts for why. */
const fileLedgers = new Map<string, OutcomeLedger>();

export function sharedFileOutcomeLedger(filePath: string): OutcomeLedger {
  const key = resolve(filePath);
  let ledger = fileLedgers.get(key);
  if (!ledger) {
    ledger = createFileOutcomeLedger(key);
    fileLedgers.set(key, ledger);
  }
  return ledger;
}

/** Test-only. */
export function __resetSharedFileOutcomeLedgers(): void {
  fileLedgers.clear();
}
