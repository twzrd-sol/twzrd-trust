import * as fs from "node:fs";
import * as path from "node:path";
import { nextPrev } from "./chain.js";
import type { SpendWindow } from "./gate.js";

export interface LedgerLine {
  timestamp: string;
  model: string;
  requested_model?: string;
  served_model?: string | null;
  model_mismatch?: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  allowed: boolean;
  veto_reason: string | null;
  request_id: string | null;
  /**
   * How an allowed line was metered: "usage" from upstream, or
   * "held_estimate" when the call finished without usage (timeout,
   * unreachable upstream, a 2xx with no usage) and the pre-call hold stands.
   * Absent on vetoes and on lines written before 0.1.5.
   */
  metered?: "usage" | "held_estimate";
  /**
   * SHA-256 (hex) of the line before this one, or "genesis" (chain.ts).
   * Written by `append()`; a value the caller passes is ignored. Absent on
   * lines written before the chain existed.
   */
  prev?: string;
}

interface TimedSpend {
  atMs: number;
  totalTokens: number;
  costUsd: number;
}

// Lines older than this are ignored on rebuild; the in-memory window only
// ever needs the last day, with headroom for a long-downtime restart.
const REPLAY_MS = 48 * 3600 * 1000;
const RETAIN_MS = 48 * 3600 * 1000;

/** Append-only JSONL ledger (source of truth) + in-memory sliding windows.
 *
 * Multi-instance: every Ledger tracks its own byte offset into the file.
 * `refresh()` stats the file and reads only the bytes this instance has not
 * consumed yet — including bytes another running copy appended. Budget
 * decisions see every copy's spend without a restart. `window()` refreshes
 * automatically, so both the chat-completions gate and /healthz get fresh
 * windows on every read; callers do not have to remember.
 *
 * The kill switch file is deliberately outside this class.
 */
export class Ledger {
  private spends: TimedSpend[] = [];
  // In-flight holds: counted by window() but never written to the JSONL.
  // A crash drops them; an unsettled hold must not consume budget forever.
  private holds = new Map<number, TimedSpend>();
  private nextHoldId = 1;
  // Incremental-read bookkeeping: bytes consumed from the file by this
  // instance, a trailing unterminated line held between refreshes, and the
  // stat snapshot the fast path uses to skip no-op reads.
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private lastSize = 0;
  private lastMtimeMs = 0;
  private lastInode = 0;

  constructor(private readonly filePath: string) {}

  /** Replay the last 48 h of the ledger to rebuild the windows. */
  load(): number {
    this.spends = [];
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.lastSize = 0;
    this.lastMtimeMs = 0;
    this.lastInode = 0;
    return this.refresh(true);
  }

  /**
   * Stat the file and ingest whatever bytes this instance has not seen yet.
   * When nothing changed, this costs one stat and no read. Returns the number
   * of allowed lines applied.
   *
   * Torn tail: a chunk ending mid-line is held until the rest of the line
   * arrives, so a torn write never crashes a refresh nor half-counts. A file
   * that was truncated or replaced (new inode) resets the baseline and is
   * re-read from the start; the 48 h retention window keeps that cheap.
   */
  refresh(force: boolean = false): number {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return 0;
      throw err;
    }
    if (st.ino !== this.lastInode) {
      // Rotation: start over against the new file.
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.spends = [];
      this.lastInode = st.ino;
    }
    if (st.size < this.offset) {
      // Truncated: same reset.
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.spends = [];
    }
    if (!force && st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) {
      return 0;
    }
    const fh = fs.openSync(this.filePath, "r");
    try {
      const len = st.size - this.offset;
      if (len <= 0) {
        this.lastSize = st.size;
        this.lastMtimeMs = st.mtimeMs;
        return 0;
      }
      const buf = Buffer.alloc(len);
      const bytesRead = fs.readSync(fh, buf, 0, len, this.offset);
      const applied = this.ingest(buf.subarray(0, bytesRead));
      this.offset += bytesRead;
      this.lastSize = this.offset;
      this.lastMtimeMs = st.mtimeMs;
      return applied;
    } finally {
      fs.closeSync(fh);
    }
  }

  /** Apply complete lines from a byte chunk, holding any unterminated tail. */
  private ingest(chunk: Buffer): number {
    const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const cut = data.lastIndexOf(0x0a); // last newline
    const consumable = cut >= 0 ? data.subarray(0, cut) : Buffer.alloc(0);
    this.pending = cut >= 0 ? Buffer.from(data.subarray(cut + 1)) : Buffer.from(data);
    const cutoff = Date.now() - REPLAY_MS;
    let applied = 0;
    for (const raw of consumable.toString("utf8").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: LedgerLine;
      try {
        parsed = JSON.parse(line) as LedgerLine;
      } catch {
        continue; // A torn write must never break a refresh.
      }
      if (!parsed.allowed) continue; // Vetoed calls cost nothing.
      const atMs = Date.parse(parsed.timestamp);
      if (!Number.isFinite(atMs) || atMs < cutoff) continue;
      this.spends.push({
        atMs,
        totalTokens: parsed.total_tokens ?? 0,
        costUsd: parsed.cost_usd ?? 0,
      });
      applied++;
    }
    // Bound memory: drop anything older than the replay horizon.
    if (this.spends.length > 10000) {
      this.spends = this.spends.filter((s) => s.atMs >= Date.now() - RETAIN_MS);
    }
    return applied;
  }

  window(nowMs: number = Date.now()): SpendWindow {
    this.refresh();
    let minuteTokens = 0;
    let hourUsd = 0;
    let dayUsd = 0;
    for (const s of [...this.spends, ...this.holds.values()]) {
      const age = nowMs - s.atMs;
      if (age < 0) continue;
      if (age < 24 * 3600 * 1000) {
        dayUsd += s.costUsd;
        if (age < 3600 * 1000) {
          hourUsd += s.costUsd;
          if (age < 60 * 1000) minuteTokens += s.totalTokens;
        }
      }
    }
    return { minuteTokens, hourUsd, dayUsd };
  }

  /** Reserve an in-flight estimate. Synchronous: call it in the same turn as the gate check. */
  hold(totalTokens: number, costUsd: number, atMs: number = Date.now()): number {
    const id = this.nextHoldId++;
    this.holds.set(id, { atMs, totalTokens, costUsd });
    return id;
  }

  /** Drop a hold without recording spend (the call never reached a billable state). */
  release(id: number): void {
    this.holds.delete(id);
  }

  /** Replace a hold with a durable line (real usage or the held estimate). */
  settle(id: number, line: LedgerLine): void {
    // Append first: if the write throws, the hold keeps counting in memory.
    this.append(line);
    this.holds.delete(id);
  }

  /** Number of in-flight holds (for tests and /healthz). */
  inFlight(): number {
    return this.holds.size;
  }

  append(line: LedgerLine): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Read the current last line and append on the same O_APPEND descriptor,
    // so a row a peer copy wrote a moment ago is the one this row commits to
    // (chain.ts). The caller never chooses `prev`.
    const fd = fs.openSync(this.filePath, "a+");
    try {
      const { prev: _callerPrev, ...fields } = line;
      const buf = Buffer.from(JSON.stringify({ ...fields, prev: nextPrev(fd) }) + "\n", "utf8");
      let written = 0;
      while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written);
    } finally {
      fs.closeSync(fd);
    }
    // The hold check reads spend from window(), which refreshes from the
    // file. The append path deliberately does NOT cache appended bytes or
    // move the read cursor: the cursor advances only in refresh(), by the
    // bytes it parsed there. Anything a peer appended before or after this
    // write is ingested exactly once, in file order, on the next check.
    // (A cursor advanced by "whatever the file size was at the next stat"
    // after our own write absorbs that peer line without parsing it.)
  }
}
