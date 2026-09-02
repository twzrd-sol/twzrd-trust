/**
 * Durable SpendLedger — append-only JSONL with a sha256 hash chain.
 *
 * The in-memory ledger resets on process death, which turns a crashlooping
 * agent into an unbounded spender: every restart re-opens its cumulative
 * budgets. This ledger replays its file on create so caps survive restarts,
 * and every row commits to the hash of the previous line so a silent edit or
 * truncation breaks the chain.
 *
 * Fail-closed: a missing file is a fresh ledger; an unparsable or
 * chain-broken file throws — a damaged spend record must never be read as
 * "nothing spent".
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import { createMemorySpendLedger, type SpendLedger } from "./policy-runtime.js";

type Row = { at: number; scope: string; micro: string; prev: string };

const GENESIS = "genesis";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createFileSpendLedger(filePath: string): SpendLedger {
  const inner = createMemorySpendLedger();
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
      throw new Error(`[twzrd-x402-gate] spend ledger corrupt row: ${filePath}`);
    }
    if (row.prev !== lastHash || typeof row.micro !== "string") {
      throw new Error(`[twzrd-x402-gate] spend ledger chain broken: ${filePath}`);
    }
    inner.record(row.scope, BigInt(row.micro), row.at);
    lastHash = sha256(line);
  }
  return {
    spentMicro: (scopeKey, windowMs, now) => inner.spentMicro(scopeKey, windowMs, now),
    firstSeen: (scopeKey) => inner.firstSeen(scopeKey),
    record(scopeKey, amountMicro, at) {
      const line = JSON.stringify({
        at,
        scope: scopeKey,
        micro: amountMicro.toString(),
        prev: lastHash,
      } satisfies Row);
      // Disk before memory: if the append fails, the spend must not be
      // counted as recorded anywhere.
      appendFileSync(filePath, line + "\n");
      lastHash = sha256(line);
      inner.record(scopeKey, amountMicro, at);
    },
  };
}

/**
 * One ledger instance per file path, for the lifetime of the process.
 *
 * `createFileSpendLedger` reads the file once and then carries `lastHash` in a
 * closure. Constructing it per request — which `spendControlSafeFetch` used to
 * do on every call — gives each concurrent call its OWN `lastHash` read from
 * the same pre-state. Both append a row with the same `prev`, and the next
 * replay throws "spend ledger chain broken" forever after: the durable ledger
 * is permanently unreadable, which fails closed but bricks the agent's budget.
 *
 * Sharing one instance makes `record()` — which is fully synchronous — atomic
 * with respect to other calls in this process, so the chain stays linear.
 *
 * Trade-off, deliberate: a cached ledger does not observe writes made to the
 * file by ANOTHER process. Cross-process sharing of one ledger file was never
 * safe (same interleaving, no lock) and is still not; this makes the
 * single-process case correct rather than pretending to fix both.
 */
const fileLedgers = new Map<string, SpendLedger>();

export function sharedFileSpendLedger(filePath: string): SpendLedger {
  const key = resolve(filePath);
  let ledger = fileLedgers.get(key);
  if (!ledger) {
    ledger = createFileSpendLedger(key);
    fileLedgers.set(key, ledger);
  }
  return ledger;
}

/** Test-only: drop cached instances so a suite can start from a fresh file. */
export function __resetSharedFileSpendLedgers(): void {
  fileLedgers.clear();
}
