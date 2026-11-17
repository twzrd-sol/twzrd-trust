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

export type DecisionOutcome = "settled" | "refused" | "free" | "forwarded" | "violation" | "control";

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
  prev: string;
}

export type DecisionInput = Omit<DecisionRecord, "schema" | "seq" | "at" | "prev" | "mandateId">;

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
