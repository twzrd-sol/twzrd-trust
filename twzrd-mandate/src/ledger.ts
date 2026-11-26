/**
 * The mandate decision ledger: one JSON line per allow, refuse and settle
 * decision, hash-chained the way the agent-killswitch spend ledger is. Each
 * line carries `prev`, the SHA-256 (hex) of the previous line's bytes, or
 * "genesis" for the first. Editing, removing or reordering any earlier line
 * changes every hash after it.
 *
 * One runtime writes one ledger. The runtime holds a lock on its state
 * directory (runtime.ts), so the chain here is verified strictly: no forks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LEDGER_GENESIS = "genesis";
export const DECISION_LEDGER_SCHEMA = "twzrd.mandate.decision.v1";

/**
 * `pending` is written just before a payment leaves. The call's own outcome
 * line answers it through `ref`; one left unanswered when a runtime opens the
 * state directory is a payment whose process died, and is answered then.
 */
export type DecisionOutcome = "settled" | "refused" | "free" | "forwarded" | "violation" | "control" | "pending";

export interface DecisionRecord {
  schema: typeof DECISION_LEDGER_SCHEMA;
  seq: number;
  at: string;
  mandateId: string;
  outcome: DecisionOutcome;
  /** Pre-sign refusal layer (1 to 6) for a refusal; null otherwise. */
  layer: number | null;
  code: string | null;
  tool: string | null;
  target: string | null;
  payTo: string | null;
  quotedUsd: string | null;
  settledUsd: string | null;
  /** Payment signatures this decision caused. A refusal is always 0. */
  signatures: number;
  receipt: string | null;
  inclusion: string | null;
  detail: string | null;
  /** The `seq` of the `pending` line this line answers, or null. */
  ref: number | null;
  /**
   * SHA-256 (hex) of the purchase: method, full target URL, request body,
   * Idempotency-Key, recipient, chain, asset and amount. On the `pending`
   * line of a paid call, its outcome line, and a `duplicate_purchase`
   * refusal. Absent on lines that carry no purchase.
   */
  dedupeKey?: string;
  /**
   * SHA-256 (hex) of the response body a signed payment bought, as the
   * runtime handed it back. On the outcome line of a call that signed a payment.
   */
  responseSha256?: string;
  prev: string;
}

export type DecisionInput = Omit<DecisionRecord, "schema" | "seq" | "at" | "prev" | "mandateId" | "ref"> & { ref?: number | null };

export interface LedgerVerifyReport {
  ok: boolean;
  lines: number;
  head: string;
  breaks: { line: number; reason: string }[];
  tornTail: boolean;
}

export function lineHash(line: Buffer | string): string {
  return crypto.createHash("sha256").update(line).digest("hex");
}

/** Verify a decision ledger file from its first line. A missing file is a valid empty ledger. */
export function verifyDecisionLedger(filePath: string): LedgerVerifyReport {
  const report: LedgerVerifyReport = { ok: false, lines: 0, head: LEDGER_GENESIS, breaks: [], tornTail: false };
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...report, ok: true };
    report.breaks.push({ line: 0, reason: "the ledger cannot be read" });
    return report;
  }
  let start = 0;
  let lineNo = 0;
  let expectedSeq = 1;
  while (start < data.length) {
    const nl = data.indexOf(0x0a, start);
    if (nl === -1) {
      // Bytes after the last newline: a write that did not finish.
      report.tornTail = true;
      break;
    }
    const raw = data.subarray(start, nl);
    start = nl + 1;
    lineNo += 1;
    if (raw.length === 0) {
      report.breaks.push({ line: lineNo, reason: "empty line" });
      continue;
    }
    report.lines += 1;
    let row: unknown;
    try {
      row = JSON.parse(raw.toString("utf8"));
    } catch {
      row = undefined;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      report.breaks.push({ line: lineNo, reason: "not a JSON object" });
    } else {
      const { prev, seq } = row as { prev?: unknown; seq?: unknown };
      if (prev !== report.head) report.breaks.push({ line: lineNo, reason: "prev does not match the line before" });
      if (seq !== expectedSeq) report.breaks.push({ line: lineNo, reason: `seq is not ${expectedSeq}` });
    }
    expectedSeq += 1;
    report.head = lineHash(raw);
  }
  report.ok = report.breaks.length === 0 && !report.tornTail;
  return report;
}

function usdToMicro(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/**
 * The chain alone cannot tell a rewritten ledger from an honest one: whoever
 * rewrites every line can recompute every hash. The last heartbeat signed a
 * ledger head and the counters at that moment, so the ledger must still
 * contain that head, and must not report fewer decisions or less settled
 * spend than the heartbeat did. A missing heartbeat file passes (a fresh
 * state directory has none); keep heartbeats somewhere else as well to
 * catch a deleted one.
 */
export function ledgerAgreesWithHeartbeat(
  ledger: Pick<DecisionLedger, "head" | "tail">,
  heartbeatPath: string,
): { ok: true } | { ok: false; detail: string } {
  let text: string;
  try {
    text = fs.readFileSync(heartbeatPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true };
    return { ok: false, detail: `the last heartbeat cannot be read: ${(err as Error).message}` };
  }
  let hb: Record<string, unknown>;
  try {
    const doc: unknown = JSON.parse(text);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
    hb = doc as Record<string, unknown>;
  } catch {
    return { ok: false, detail: "the last heartbeat is not JSON" };
  }
  const head = hb.ledgerHeadHash;
  if (typeof head !== "string") return { ok: false, detail: "the last heartbeat names no ledger head" };
  const rows = ledger.tail(Number.MAX_SAFE_INTEGER);
  const heads = new Set<string>([LEDGER_GENESIS, ledger.head(), ...rows.map((r) => r.prev)]);
  if (!heads.has(head)) {
    return {
      ok: false,
      detail: `the decision ledger no longer contains head ${head.slice(0, 16)} that heartbeat ${String(hb.seq)} signed: it was rewritten or cut short`,
    };
  }
  const calls = rows.filter((r) => r.outcome !== "control" && r.outcome !== "pending");
  if (typeof hb.decisions === "number" && calls.length < hb.decisions) {
    return { ok: false, detail: `the decision ledger has ${calls.length} decisions, fewer than the ${hb.decisions} heartbeat ${String(hb.seq)} signed` };
  }
  const signedMicro = usdToMicro(hb.settledUsd);
  if (signedMicro !== null) {
    const ledgerMicro = calls
      .filter((r) => r.outcome === "settled" || r.outcome === "violation")
      .reduce((sum, r) => sum + (usdToMicro(r.settledUsd) ?? 0n), 0n);
    if (ledgerMicro < signedMicro) {
      return { ok: false, detail: `the decision ledger records less settled spend than heartbeat ${String(hb.seq)} signed` };
    }
  }
  return { ok: true };
}

export interface DecisionLedger {
  readonly filePath: string;
  append(input: DecisionInput): DecisionRecord;
  /** Hash of the last line, or "genesis". */
  head(): string;
  count(): number;
  /** The last `limit` records, oldest first. */
  tail(limit: number): DecisionRecord[];
  verify(): LedgerVerifyReport;
}

/**
 * Open (or create) a decision ledger. Throws when an existing file does not
 * verify: a runtime must not extend a chain it cannot vouch for.
 */
export function openDecisionLedger(filePath: string, mandateId: string, clock: () => number = Date.now): DecisionLedger {
  const where = path.resolve(filePath);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  const opened = verifyDecisionLedger(where);
  if (!opened.ok) {
    const first = opened.breaks[0];
    throw new Error(
      `decision ledger ${where} does not verify` +
        (first ? ` (line ${first.line}: ${first.reason})` : opened.tornTail ? " (unfinished last line)" : ""),
    );
  }
  let head = opened.head;
  let lines = opened.lines;
  const fd = fs.openSync(where, "a", 0o600);

  return {
    filePath: where,
    append(input: DecisionInput): DecisionRecord {
      const record: DecisionRecord = {
        schema: DECISION_LEDGER_SCHEMA,
        seq: lines + 1,
        at: new Date(clock()).toISOString(),
        mandateId,
        ...input,
        ref: input.ref ?? null,
        prev: head,
      };
      const line = Buffer.from(JSON.stringify(record), "utf8");
      // One write call for the line and its newline, then to disk: a decision
      // that is not on the ledger did not happen as far as the runtime knows.
      fs.writeSync(fd, Buffer.concat([line, Buffer.from("\n")]));
      fs.fsyncSync(fd);
      head = lineHash(line);
      lines += 1;
      return record;
    },
    head: () => head,
    count: () => lines,
    tail(limit: number): DecisionRecord[] {
      const text = fs.readFileSync(where, "utf8");
      const rows = text.split("\n").filter((l) => l.length > 0);
      return rows.slice(Math.max(0, rows.length - Math.max(0, limit))).map((l) => JSON.parse(l) as DecisionRecord);
    },
    verify: () => verifyDecisionLedger(where),
  };
}
