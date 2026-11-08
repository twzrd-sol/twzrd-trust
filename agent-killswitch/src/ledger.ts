import * as fs from "node:fs";
import * as path from "node:path";
import type { SpendWindow } from "./gate.js";

export interface LedgerLine {
  timestamp: string;
  model: string;
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

/** Append-only JSONL ledger (source of truth) + in-memory sliding windows. */
export class Ledger {
  private spends: TimedSpend[] = [];
  // In-flight holds: counted by window() but never written to the JSONL.
  // A crash drops them; an unsettled hold must not consume budget forever.
  private holds = new Map<number, TimedSpend>();
  private nextHoldId = 1;

  constructor(private readonly filePath: string) {}

  /** Replay the last 48 h of the ledger to rebuild the windows. */
  load(): number {
    this.spends = [];
    if (!fs.existsSync(this.filePath)) return 0;
    const cutoff = Date.now() - REPLAY_MS;
    let replayed = 0;
    const content = fs.readFileSync(this.filePath, "utf8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: LedgerLine;
      try {
        parsed = JSON.parse(line) as LedgerLine;
      } catch {
        continue; // A torn write must never break startup.
      }
      if (!parsed.allowed) continue; // Vetoed calls cost nothing.
      const atMs = Date.parse(parsed.timestamp);
      if (!Number.isFinite(atMs) || atMs < cutoff) continue;
      this.spends.push({
        atMs,
        totalTokens: parsed.total_tokens ?? 0,
        costUsd: parsed.cost_usd ?? 0,
      });
      replayed++;
    }
    return replayed;
  }

  window(nowMs: number = Date.now()): SpendWindow {
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
    fs.appendFileSync(this.filePath, JSON.stringify(line) + "\n", "utf8");
    if (line.allowed) {
      this.spends.push({
        atMs: Date.parse(line.timestamp),
        totalTokens: line.total_tokens,
        costUsd: line.cost_usd,
      });
      // Bound memory: drop anything older than the replay horizon.
      const cutoff = Date.now() - RETAIN_MS;
      if (this.spends.length > 10000) {
        this.spends = this.spends.filter((s) => s.atMs >= cutoff);
      }
    }
  }
}
