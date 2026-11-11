/**
 * Hash chain over the JSONL spend ledger, and its offline verifier.
 *
 * Every row the proxy writes carries `prev`: the lowercase hex SHA-256 of the
 * exact bytes of the last complete, non-empty line before it (without the
 * newline), or "genesis" when there is none. This is the convention
 * twzrd-x402-gate's durable spend ledger already uses, so one head format
 * covers both.
 *
 * What the chain shows, read offline:
 * - An edited, removed or reordered line breaks the link of the line after it.
 * - The newest line is committed to by nothing yet. Removing it, or rewriting
 *   every line and recomputing every hash, leaves a valid chain. Only a head
 *   recorded somewhere the writer cannot change (for example an on-chain
 *   anchor) detects that. `verify-ledger` prints the head to record.
 *
 * Several proxy copies may append to one file (see ledger.ts). Each writer
 * reads the file's last line right before its own append, so the chain stays
 * linear except when two copies append within the same moment: both rows then
 * name the same `prev`. The verifier accepts that as a fork when the named
 * line is among the FORK_WINDOW lines before; one row of each fork is then
 * committed to by no later row. `--strict` refuses forks, for deployments that
 * run one copy per ledger file.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const GENESIS = "genesis";
/** How far back a fork may point. Concurrent appends land microseconds apart. */
export const FORK_WINDOW = 16;
// Rows are a few hundred bytes; a longer line doubles the read until it fits.
const TAIL_CHUNK = 8 * 1024;
const READ_CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

export function lineHash(line: Buffer | string): string {
  return createHash("sha256").update(line).digest("hex");
}

/** The file got shorter between fstat and read (truncated or rotated in place). */
class LedgerShrankError extends Error {}

function readFully(fd: number, buf: Buffer, position: number): void {
  let done = 0;
  while (done < buf.length) {
    const n = fs.readSync(fd, buf, done, buf.length - done, position + done);
    if (n === 0) throw new LedgerShrankError("ledger shrank while reading its tail");
    done += n;
  }
}

/**
 * The last complete, non-empty line of an open file (`size` bytes), or null.
 * Bytes after the final newline are a torn or in-progress write, not a line.
 */
export function lastCompleteLine(fd: number, size: number): Buffer | null {
  if (size === 0) return null;
  let chunk = Math.min(size, TAIL_CHUNK);
  for (;;) {
    const start = size - chunk;
    const buf = Buffer.alloc(chunk);
    readFully(fd, buf, start);
    let nl = buf.lastIndexOf(NEWLINE);
    while (nl >= 0) {
      const before = nl === 0 ? -1 : buf.lastIndexOf(NEWLINE, nl - 1);
      if (before === -1 && start > 0) break; // the line may start before this chunk
      const line = buf.subarray(before + 1, nl);
      if (line.length > 0) return Buffer.from(line);
      nl = before; // an empty line is not a row: keep walking back
    }
    if (start === 0) return null;
    chunk = Math.min(size, chunk * 2);
  }
}

/**
 * The `prev` value for the next row appended to an open file. A file cut
 * short mid-read is re-measured, so an operator truncating the ledger does
 * not fail the call that was being recorded.
 */
export function nextPrev(fd: number): string {
  for (let attempt = 1; ; attempt++) {
    try {
      const last = lastCompleteLine(fd, fs.fstatSync(fd).size);
      return last ? lineHash(last) : GENESIS;
    } catch (e) {
      if (!(e instanceof LedgerShrankError) || attempt >= 3) throw e;
    }
  }
}

export interface ChainBreak {
  line: number;
  reason: string;
}

export interface ChainReport {
  /** True when nothing is broken (and, with strict, no fork, unparseable or unchained line). */
  ok: boolean;
  strict: boolean;
  /** Complete, non-empty lines. */
  lines: number;
  /** Lines that carry `prev`. */
  chained: number;
  /** Rows without `prev` before the first chained row (written before the chain existed). */
  legacy: number;
  /** Line numbers of rows without `prev` after the chain started (an older copy still writing). */
  unchained: number[];
  /** Line numbers that are not a JSON object. Still links: the next line commits to their bytes. */
  unparseable: number[];
  /** Line numbers whose `prev` names an earlier line than the one right before them. */
  forks: number[];
  breaks: ChainBreak[];
  /** The file ends in bytes without a newline (a torn or in-progress write). */
  torn_tail: boolean;
  /** SHA-256 of the last complete line: the value to record or anchor. */
  head: string | null;
  head_line: number | null;
}

/** Walk the ledger at `filePath` and check every link. Throws if it cannot be read. */
export function verifyLedgerFile(filePath: string, opts: { strict?: boolean } = {}): ChainReport {
  const strict = opts.strict === true;
  const report: ChainReport = {
    ok: false,
    strict,
    lines: 0,
    chained: 0,
    legacy: 0,
    unchained: [],
    unparseable: [],
    forks: [],
    breaks: [],
    torn_tail: false,
    head: null,
    head_line: null,
  };
  // Hashes of the most recent lines, oldest first; "genesis" stands for the
  // line before the first one and leaves the window like any other.
  const recent: string[] = [GENESIS];
  let chainStarted = false;
  let lineNo = 0;

  const visit = (raw: Buffer): void => {
    lineNo++;
    if (raw.length === 0) return;
    report.lines++;
    let row: unknown;
    try {
      row = JSON.parse(raw.toString("utf8"));
    } catch {
      row = undefined;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      report.unparseable.push(lineNo);
    } else if (!Object.prototype.hasOwnProperty.call(row, "prev")) {
      if (chainStarted) report.unchained.push(lineNo);
      else report.legacy++;
    } else {
      chainStarted = true;
      report.chained++;
      const prev = (row as { prev: unknown }).prev;
      if (typeof prev !== "string") {
        report.breaks.push({ line: lineNo, reason: "prev is not a hash string" });
      } else if (prev === recent[recent.length - 1]) {
        // linked to the line right before it
      } else if (recent.slice(0, -1).includes(prev)) {
        report.forks.push(lineNo);
      } else {
        report.breaks.push({
          line: lineNo,
          reason:
            `prev matches none of the ${recent.length} lines before it: ` +
            "a line before it was edited, removed or reordered",
        });
      }
    }
    const hash = lineHash(raw);
    recent.push(hash);
    if (recent.length > FORK_WINDOW + 1) recent.shift();
    report.head = hash;
    report.head_line = lineNo;
  };

  const fd = fs.openSync(filePath, "r");
  try {
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(READ_CHUNK);
    let position = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, position);
      if (n === 0) break;
      position += n;
      const data = carry.length === 0 ? buf.subarray(0, n) : Buffer.concat([carry, buf.subarray(0, n)]);
      let from = 0;
      for (let nl = data.indexOf(NEWLINE); nl !== -1; nl = data.indexOf(NEWLINE, from)) {
        visit(data.subarray(from, nl));
        from = nl + 1;
      }
      carry = Buffer.from(data.subarray(from));
    }
    report.torn_tail = carry.length > 0;
  } finally {
    fs.closeSync(fd);
  }

  const strictClean =
    report.forks.length === 0 && report.unparseable.length === 0 && report.unchained.length === 0;
  report.ok = report.breaks.length === 0 && (!strict || strictClean);
  return report;
}

const USAGE =
  "usage: agent-killswitch verify-ledger [ledger.jsonl] [--strict] [--json]\n" +
  "  default path: $KILLSWITCH_LEDGER_PATH, else $TWZRD_STATE_DIR/spend-ledger.jsonl, else ./data/spend-ledger.jsonl\n" +
  "  exit 0 chain intact, 1 chain broken (or a --strict finding), 2 cannot verify";

function defaultLedgerPath(): string {
  const env = process.env.KILLSWITCH_LEDGER_PATH?.trim();
  if (env) return path.resolve(env);
  const stateDir = process.env.TWZRD_STATE_DIR?.trim() || "./data";
  return path.resolve(stateDir, "spend-ledger.jsonl");
}

function list(lines: number[]): string {
  const shown = lines.slice(0, 10).join(", ");
  return lines.length > 10 ? `${shown}, ... (${lines.length})` : shown;
}

/** `agent-killswitch verify-ledger ...`: print a report, return the exit code. */
export function runVerifyLedger(
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s + "\n"),
  err: (s: string) => void = (s) => process.stderr.write(s + "\n"),
): number {
  let strict = false;
  let json = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === "--strict") strict = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      out(USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      err(`agent-killswitch verify-ledger: unknown option ${arg}\n${USAGE}`);
      return 2;
    } else paths.push(arg);
  }
  if (paths.length > 1) {
    err(`agent-killswitch verify-ledger: one ledger path at a time\n${USAGE}`);
    return 2;
  }
  const file = paths.length === 1 ? path.resolve(paths[0]) : defaultLedgerPath();

  let report: ChainReport;
  try {
    report = verifyLedgerFile(file, { strict });
  } catch (e) {
    const code = (e as { code?: string }).code;
    err(
      code === "ENOENT"
        ? `agent-killswitch verify-ledger: no ledger at ${file}`
        : `agent-killswitch verify-ledger: cannot read ${file}: ${(e as Error).message}`,
    );
    return 2;
  }

  if (json) {
    out(JSON.stringify({ file, ...report }));
    return report.ok ? 0 : 1;
  }

  out(`ledger ${file}`);
  out(
    `  ${report.lines} lines: ${report.chained} chained, ${report.legacy} written before the chain, ` +
      `${report.forks.length} forks, ${report.unparseable.length} unparseable, ` +
      `${report.unchained.length} unchained after it started`,
  );
  if (report.forks.length > 0) out(`  forks (two copies appended at once) at lines ${list(report.forks)}`);
  if (report.unparseable.length > 0) out(`  unparseable lines ${list(report.unparseable)}`);
  if (report.unchained.length > 0) out(`  rows without prev after the chain started (an older copy?) at lines ${list(report.unchained)}`);
  if (report.torn_tail) out("  the file ends mid-line (a torn or in-progress write); that line is not checked");
  for (const b of report.breaks) out(`  BROKEN at line ${b.line}: ${b.reason}`);
  if (report.head) out(`  head ${report.head} (line ${report.head_line})`);
  if (report.ok) {
    out(
      report.chained === 0
        ? "OK: no chained rows yet; nothing contradicts the file."
        : "OK: every chained row commits to the line before it. Record the head: the newest line is covered only by a head kept elsewhere.",
    );
    return 0;
  }
  out(
    report.breaks.length > 0
      ? "BROKEN: the ledger was changed after it was written, or damaged."
      : "STRICT: forks, unparseable lines or unchained rows found (see above).",
  );
  return 1;
}
