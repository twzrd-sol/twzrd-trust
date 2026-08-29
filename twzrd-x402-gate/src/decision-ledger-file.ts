/**
 * Append-only decision ledger for support, evaluation, and settlement joins.
 * Single-process writer only: do not share one file between processes. Rows deliberately carry a schema version: readers must reject formats they
 * do not understand rather than silently misinterpret an audit record.
 */
import { mkdirSync } from "node:fs";
import { appendFile, open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DECISION_LEDGER_SCHEMA_VERSION = 1;

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

export type FileDecisionLedgerOptions = { maxBufferedRows?: number; rotateBytes?: number };

/** `record` never blocks the payment path. `flush` fsyncs an async batch. */
export function createFileDecisionLedger(filePath: string, options: FileDecisionLedgerOptions = {}) {
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
    queueMicrotask(() => { void flush(); });
  };
  // Flush on ordinary Node shutdown. Signal handlers re-raise the signal after
  // fsync so supervisors retain normal termination semantics.
  const flushOnSignal = (signal: NodeJS.Signals) => {
    process.once(signal, () => { void flush().finally(() => process.kill(process.pid, signal)); });
  };
  process.once("beforeExit", () => { void flush(); });
  flushOnSignal("SIGINT");
  flushOnSignal("SIGTERM");
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
      if (pending.length >= maxBufferedRows) void flush(); else scheduleFlush();
      return row;
    },
    flush,
  };
}
