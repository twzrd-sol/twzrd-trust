/**
 * Append-only decision ledger for support, evaluation, and settlement joins.
 * Single-process writer only: do not share one file between processes. Rows deliberately carry a schema version: readers must reject formats they
 * do not understand rather than silently misinterpret an audit record.
 */
import { mkdirSync } from "node:fs";
import { appendFile, open, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DECISION_LEDGER_SCHEMA_VERSION = 1;
export const MPP_FULFILLMENT_LEDGER_SCHEMA_VERSION = 3;
export const X402_SETTLEMENT_LEDGER_SCHEMA_VERSION = 3;

/**
 * Follow-up row for a paid x402 call, appended after the response arrives and
 * linked to the earlier allow/warn decision row by `decision_id`. The decision
 * row is made durable before signing, so it cannot carry the outcome; earlier
 * rows are never rewritten. Absence of this row means "not evaluated" (no
 * PAYMENT-RESPONSE with a boolean success), never "settled" or "failed".
 * The status is the facilitator's report, not an onchain confirmation.
 */
export type X402SettlementLedgerRow = {
  schema_version: typeof X402_SETTLEMENT_LEDGER_SCHEMA_VERSION;
  record_type: "x402_settlement";
  decision_id: string;
  at_unix_ms: number;
  http_status: number;
  network: string | null;
  settlement: { status: "settled" | "failed"; tx?: string };
};

export type X402SettlementLedgerInput = {
  decision_id: string;
  http_status: number;
  network?: unknown;
  success: boolean;
  transaction?: unknown;
  at_unix_ms?: number;
};

export type MppFulfillmentLedgerRow = {
  schema_version: typeof MPP_FULFILLMENT_LEDGER_SCHEMA_VERSION;
  record_type: "mpp_fulfillment";
  at_unix_ms: number;
  resource_origin: string | null;
  http_status: number;
  payment_method: string;
  payment_intent: string;
  challenge_id_sha256: string | null;
  paid_to: string | null;
  network: string | null;
  asset: string | null;
  amount_atomic: string | null;
  receipt_state: "valid_format" | "missing" | "invalid_format" | "unavailable";
  receipt_status: string | null;
  receipt_method: string | null;
  receipt_reference: string | null;
  receipt_timestamp: string | null;
  requested_model: string | null;
  seller_reported_model: string | null;
  seller_reported_model_matches_request: boolean | null;
  gate: { disposition: "allow" | "warn" | "block"; decisionId?: string; intentHash?: string; reasonCodes?: readonly string[] } | null;
  /** Complete-body byte count, or null when the body was not fully read. Never the body. */
  response_bytes: number | null;
  /** Lowercase hex SHA-256 of that same body, or null. */
  body_sha256: string | null;
  /** Null means not evaluated, never clean. */
  receipt_reference_chain_verified: boolean | null;
  receipt_reference_finalized_slot: number | null;
  receipt_reference_mismatch: boolean | null;
  receipt_reference_unverified_reason: string | null;
  receipt_reference_purchase_bound: boolean | null;
  receipt_reference_purchase_bound_reason: string | null;
  receipt_reference_local_acceptance: boolean | null;
  receipt_reference_refusal_reason: string | null;
};

type MppFulfillmentEvidenceField =
  | "response_bytes"
  | "body_sha256"
  | "receipt_reference_chain_verified"
  | "receipt_reference_finalized_slot"
  | "receipt_reference_mismatch"
  | "receipt_reference_unverified_reason"
  | "receipt_reference_purchase_bound"
  | "receipt_reference_purchase_bound_reason"
  | "receipt_reference_local_acceptance"
  | "receipt_reference_refusal_reason";

export type MppFulfillmentLedgerInput = Omit<MppFulfillmentLedgerRow, "schema_version" | "record_type" | "at_unix_ms" | "resource_origin" | "challenge_id_sha256" | MppFulfillmentEvidenceField> & {
  challenge_id: string;
  at_unix_ms?: number;
  resource_origin?: string | null;
} & Partial<Pick<MppFulfillmentLedgerRow, MppFulfillmentEvidenceField>>;

export type MppFulfillmentSink = (record: MppFulfillmentLedgerInput) => void | Promise<void>;

export type DecisionLedgerRow = {
  schema_version: typeof DECISION_LEDGER_SCHEMA_VERSION;
  decision_id: string;
  at_unix_ms: number;
  outcome: "allow" | "warn" | "block" | "error";
  reason_codes: string[];
  policy_version: string;
  input: {
    /** Public chain address, retained for settlement and counterparty joins. */
    pay_to?: string;
    resource_origin?: string;
    network?: string;
    /** Exact value retained for mandate/cap reconciliation. */
    amount_micro?: string;
  };
  signer_invocations: number;
  latency_ms?: number;
  error?: { code: string; message?: string };
  /**
   * Caller-owned slot. buyer-fetch never fills it: its decision row is durable
   * before signing, so settlement arrives later as an `x402_settlement` row
   * (X402SettlementLedgerRow) with the same decision_id.
   */
  settlement?: { status: "pending" | "settled" | "failed"; tx?: string };
};

export type RecordDecisionInput = Omit<DecisionLedgerRow, "schema_version" | "decision_id" | "at_unix_ms" | "input"> & {
  decision_id?: string;
  at_unix_ms?: number;
  input: { pay_to?: string; resource?: string; network?: string; amount_micro?: string };
};

function redactInput(input: RecordDecisionInput["input"]): DecisionLedgerRow["input"] {
  let resource_origin: string | undefined;
  try { resource_origin = input.resource ? new URL(input.resource).origin : undefined; } catch { resource_origin = undefined; }
  return {
    pay_to: input.pay_to,
    resource_origin,
    network: input.network,
    amount_micro: input.amount_micro,
  };
}

export type FileDecisionLedgerOptions = {
  maxBufferedRows?: number;
  rotateBytes?: number;
  /** Set false when the caller always awaits flush itself. Default: true. */
  flushBeforeExit?: boolean;
  /** Opt in only when this library owns the host process lifecycle. Default: false. */
  flushOnSignals?: boolean;
};

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
}

function normalizedOrigin(value: unknown): string | null {
  const text = boundedString(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

function safeModelLabel(value: unknown): string | null {
  const text = boundedString(value, 128);
  return text && /[A-Za-z]/.test(text) && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(text) ? text : null;
}

function safeReceiptReference(method: string, value: unknown): string | null {
  const text = boundedString(value, 96);
  if (!text) return null;
  if (method === "tempo" && /^0x[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  if (method === "solana" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text)) return text;
  return null;
}

function safeChainAddress(method: string, value: unknown): string | null {
  const text = boundedString(value, 128);
  if (!text) return null;
  if (method === "tempo" && /^0x[0-9a-f]{40}$/i.test(text)) return text.toLowerCase();
  if (method === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return text;
  return null;
}

function safeNetwork(value: unknown): string | null {
  const network = boundedString(value, 64);
  return network && /^(?:eip155:\d+|solana:[A-Za-z0-9]+|mainnet(?:-beta)?|devnet|testnet|localnet)$/.test(network) ? network : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeSettlementTx(value: unknown): string | null {
  const text = boundedString(value, 96);
  if (!text) return null;
  if (/^0x[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text)) return text;
  return null;
}

function sanitizeX402Settlement(input: X402SettlementLedgerInput): X402SettlementLedgerRow {
  if (typeof input.decision_id !== "string" || !UUID_RE.test(input.decision_id)) {
    throw new TypeError("x402 settlement decision_id must be a decision row UUID");
  }
  if (!Number.isInteger(input.http_status) || input.http_status < 100 || input.http_status > 599) {
    throw new TypeError("x402 settlement http_status must be an HTTP status code");
  }
  if (typeof input.success !== "boolean") throw new TypeError("x402 settlement success must be boolean");
  const tx = safeSettlementTx(input.transaction);
  const at = input.at_unix_ms;
  return {
    schema_version: X402_SETTLEMENT_LEDGER_SCHEMA_VERSION,
    record_type: "x402_settlement",
    decision_id: input.decision_id,
    at_unix_ms: Number.isSafeInteger(at) && (at as number) > 0 ? (at as number) : Date.now(),
    http_status: input.http_status,
    network: safeNetwork(input.network),
    settlement: { status: input.success ? "settled" : "failed", ...(tx ? { tx } : {}) },
  };
}

function sanitizeMppFulfillment(input: MppFulfillmentLedgerInput): MppFulfillmentLedgerRow {
  if (!Number.isInteger(input.http_status) || input.http_status < 100 || input.http_status > 599) {
    throw new TypeError("MPP fulfillment http_status must be an HTTP status code");
  }
  const gate = input.gate;
  const safeGate = gate && ["allow", "warn", "block"].includes(gate.disposition)
    ? {
        disposition: gate.disposition,
        ...(typeof gate.decisionId === "string" && UUID_RE.test(gate.decisionId) ? { decisionId: gate.decisionId } : {}),
        ...(typeof gate.intentHash === "string" && /^(?:tiv1:|0x)?[0-9a-f]{64}$/i.test(gate.intentHash) ? { intentHash: gate.intentHash } : {}),
        ...(Array.isArray(gate.reasonCodes) ? { reasonCodes: gate.reasonCodes.slice(0, 32).map(code => boundedString(code, 64)).filter((code): code is string => code !== null && /^[A-Za-z0-9_.-]+$/.test(code)) } : {}),
      }
    : null;
  const amount = boundedString(input.amount_atomic, 128);
  const method = input.payment_method === "tempo" || input.payment_method === "solana" ? input.payment_method : "unknown";
  const challengeId = boundedString(input.challenge_id, 256);
  const state = ["valid_format", "missing", "invalid_format", "unavailable"].includes(input.receipt_state) ? input.receipt_state : "unavailable";
  const at = input.at_unix_ms;
  return {
    schema_version: MPP_FULFILLMENT_LEDGER_SCHEMA_VERSION,
    record_type: "mpp_fulfillment",
    at_unix_ms: Number.isSafeInteger(at) && (at as number) > 0 ? (at as number) : Date.now(),
    resource_origin: normalizedOrigin(input.resource_origin),
    http_status: input.http_status,
    payment_method: method,
    payment_intent: input.payment_intent === "charge" || input.payment_intent === "session" ? input.payment_intent : "unknown",
    challenge_id_sha256: challengeId ? createHash("sha256").update(challengeId).digest("hex") : null,
    paid_to: safeChainAddress(method, input.paid_to),
    network: safeNetwork(input.network),
    asset: safeChainAddress(method, input.asset),
    amount_atomic: amount && /^\d+$/.test(amount) ? amount : null,
    receipt_state: state,
    receipt_status: input.receipt_status === "success" || input.receipt_status === "failed" ? input.receipt_status : null,
    receipt_method: input.receipt_method === method ? method : null,
    receipt_reference: safeReceiptReference(method, input.receipt_reference),
    receipt_timestamp: (() => {
      const timestamp = boundedString(input.receipt_timestamp, 64);
      return timestamp && Number.isFinite(Date.parse(timestamp)) && /^\d{4}-\d{2}-\d{2}T/.test(timestamp) ? timestamp : null;
    })(),
    requested_model: safeModelLabel(input.requested_model),
    seller_reported_model: safeModelLabel(input.seller_reported_model),
    seller_reported_model_matches_request: typeof input.seller_reported_model_matches_request === "boolean" ? input.seller_reported_model_matches_request : null,
    gate: safeGate,
    response_bytes: safeResponseBytes(input.response_bytes),
    body_sha256: safeBodySha256(input.body_sha256),
    receipt_reference_chain_verified: safeBoolean(input.receipt_reference_chain_verified),
    receipt_reference_finalized_slot: safeSlot(input.receipt_reference_finalized_slot),
    receipt_reference_mismatch: safeBoolean(input.receipt_reference_mismatch),
    receipt_reference_unverified_reason: safeReasonToken(input.receipt_reference_unverified_reason),
    receipt_reference_purchase_bound: safeBoolean(input.receipt_reference_purchase_bound),
    receipt_reference_purchase_bound_reason: safeReasonToken(input.receipt_reference_purchase_bound_reason),
    receipt_reference_local_acceptance: safeBoolean(input.receipt_reference_local_acceptance),
    receipt_reference_refusal_reason: safeReasonToken(input.receipt_reference_refusal_reason),
  };
}

const MPP_FULFILLMENT_MAX_BODY_BYTES = 1024 * 1024;

function safeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safeResponseBytes(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MPP_FULFILLMENT_MAX_BODY_BYTES
    ? (value as number)
    : null;
}

function safeBodySha256(value: unknown): string | null {
  const text = boundedString(value, 64);
  return text && /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function safeSlot(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function safeReasonToken(value: unknown): string | null {
  const text = boundedString(value, 64);
  return text && /^[a-z0-9_]+$/.test(text) ? text : null;
}

const sharedLedgers = new Map<string, ReturnType<typeof createNewFileDecisionLedger>>();

/** One writer per resolved path in this process, shared by every ledger entry point. */
export function sharedFileDecisionLedger(filePath: string, options: FileDecisionLedgerOptions = {}) {
  const path = resolve(filePath);
  let ledger = sharedLedgers.get(path);
  if (!ledger) {
    ledger = createNewFileDecisionLedger(path, options);
    sharedLedgers.set(path, ledger);
  }
  return ledger;
}

/** Public constructor also participates in the shared one-process writer registry. */
export function createFileDecisionLedger(filePath: string, options: FileDecisionLedgerOptions = {}) {
  return sharedFileDecisionLedger(filePath, options);
}

/** `record` never blocks the payment path. `flush` fsyncs an async batch. */
function createNewFileDecisionLedger(filePath: string, options: FileDecisionLedgerOptions = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const maxBufferedRows = options.maxBufferedRows ?? 100;
  const rotateBytes = options.rotateBytes ?? 64 * 1024 * 1024;
  let pending: string[] = [];
  let writer: Promise<void> = Promise.resolve();
  let scheduled = false;
  const flush = async (): Promise<void> => {
    const lines = pending;
    pending = [];
    scheduled = false;
    if (!lines.length) return writer;
    writer = writer.then(async () => {
      try { if ((await stat(filePath)).size >= rotateBytes) await rename(filePath, `${filePath}.${Date.now()}.jsonl`); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      const handle = await open(filePath, "a");
      try { await appendFile(handle, lines.join(""), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    });
    return writer;
  };
  const scheduleFlush = () => {
    if (scheduled) return;
    scheduled = true;
    // Keep failures on `writer` for an awaited flush to report. The background
    // promise must not become an unhandled rejection while a buyer fails closed.
    queueMicrotask(() => { void flush().catch(() => {}); });
  };
  // beforeExit is non-invasive. Hosts own SIGINT/SIGTERM unless they explicitly
  // opt in; libraries must not interleave themselves with an app's shutdown.
  const flushOnSignal = (signal: NodeJS.Signals) => {
    process.once(signal, () => { void flush().catch(() => {}).finally(() => process.kill(process.pid, signal)); });
  };
  if (options.flushBeforeExit !== false) process.once("beforeExit", () => { void flush().catch(() => {}); });
  if (options.flushOnSignals === true) {
    flushOnSignal("SIGINT");
    flushOnSignal("SIGTERM");
  }
  return {
    record(input: RecordDecisionInput): DecisionLedgerRow {
      const row: DecisionLedgerRow = {
        ...input,
        schema_version: DECISION_LEDGER_SCHEMA_VERSION,
        decision_id: input.decision_id ?? randomUUID(),
        at_unix_ms: input.at_unix_ms ?? Date.now(),
        input: redactInput(input.input),
      };
      pending.push(JSON.stringify(row) + "\n");
      if (pending.length >= maxBufferedRows) void flush().catch(() => {}); else scheduleFlush();
      return row;
    },
    recordMppFulfillment(input: MppFulfillmentLedgerInput): MppFulfillmentLedgerRow {
      const row = sanitizeMppFulfillment(input);
      pending.push(JSON.stringify(row) + "\n");
      if (pending.length >= maxBufferedRows) void flush().catch(() => {}); else scheduleFlush();
      return row;
    },
    recordX402Settlement(input: X402SettlementLedgerInput): X402SettlementLedgerRow {
      const row = sanitizeX402Settlement(input);
      pending.push(JSON.stringify(row) + "\n");
      if (pending.length >= maxBufferedRows) void flush().catch(() => {}); else scheduleFlush();
      return row;
    },
    flush,
  };
}

/** Adapt projected MPP fulfillment evidence into the existing decisions ledger. */
export function createMppFulfillmentLedgerSink(ledger: Pick<ReturnType<typeof createFileDecisionLedger>, "recordMppFulfillment">): MppFulfillmentSink {
  return record => { ledger.recordMppFulfillment(record); };
}

/** Default local MPP fulfillment sink; appends to the existing decisions JSONL. */
export function createDefaultMppFulfillmentLedgerSink(filePath = ".twzrd/decisions.jsonl"): MppFulfillmentSink {
  return createMppFulfillmentLedgerSink(sharedFileDecisionLedger(filePath, { flushBeforeExit: false }));
}
