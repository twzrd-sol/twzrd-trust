import {
  checkKillSwitch,
  checkPauseSwitch,
  writePauseSwitch,
} from "./gate.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { Ledger } from "./ledger.js";

/**
 * Hard spend guard for paid tool calls (a search API, a scraper, an x402 or
 * MPP resource): anything an agent pays for that is not a chat completion.
 *
 * It uses the same state as the proxy: the hash-chained JSONL ledger, the
 * `.kill` file and the `.pause` sentinel. Point it at the proxy's files and
 * tool spend and inference spend share one hourly and one daily budget.
 *
 * Before a call the guard refuses when the kill file exists, a pause is in
 * force, the tool is not on the allow-list, the caller cannot state a finite
 * worst-case cost, that worst case is over the per-call cap, or it would take
 * the hour or the day over its limit. An allowed call holds its worst case
 * until it is settled. After the call the guard records what was billed. A
 * bill above the worst case, or a call with no readable bill, trips it: it
 * writes `.pause`, so the proxy and the payment gate that share the state
 * directory stop too.
 */

export type ToolVetoCode =
  | "kill_switch"
  | "payment_gate_halt"
  | "tool_not_allowed"
  | "unbounded_cost"
  | "per_request_cap"
  | "budget_exceeded";

/** Reason written to `.pause` and to the ledger when the guard trips. */
export const TOOL_GUARD_PAUSE_REASON = "tool_guard_tripped";
/** Model name on every ledger line this guard writes. */
export const TOOL_LEDGER_MODEL = "(tool)";
export const DEFAULT_TOOL_TRIP_PAUSE_MS = 3_600_000;
export const MIN_TOOL_TRIP_PAUSE_MS = 1_000;
export const MAX_TOOL_TRIP_PAUSE_MS = 86_400_000;

// Comparison slack, in USD: a thousandth of a micro-dollar. Prices such as
// 0.0005 are not exact in binary, so ten of them can sum a few 1e-19 above
// 0.005. Without the slack that rounding alone would refuse a call that
// exactly fills a cap, or trip on a bill equal to its quote.
const EPS_USD = 1e-9;

export interface ToolGuardOptions {
  /** The JSONL ledger. Use the proxy's file to share its budget. */
  ledgerPath: string;
  killFilePath: string;
  pauseFilePath: string;
  /** Tools the guard may let through. Required and non-empty: there is no "allow all". */
  allowedTools: readonly string[];
  maxCostPerCallUsd: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  /** How long a trip pauses everything on this state directory, in whole milliseconds. Default one hour; at least one second, at most one day. */
  tripPauseMs?: number;
}

export interface ToolCall {
  /** The tool's name, exactly as it appears on the allow-list. */
  tool: string;
  /**
   * The most this call can cost in USD, worked out by the caller from the
   * tool's published price and the request it is about to send. Null,
   * undefined or anything that is not a finite non-negative number means
   * the cost cannot be bounded, and the call is refused.
   */
  worstCaseUsd: number | null | undefined;
  requestId?: string | null;
}

/** The `tool` object on a ledger line this guard wrote. */
export interface ToolCallRecord {
  name: string;
  event: "settled" | "refused" | "trip";
  worst_case_usd: number | null;
  /** What the tool reported it billed; null when there was no readable bill. Only on `settled`. */
  billed_usd?: number | null;
  /** Why the guard tripped, in words. Only on `trip`. */
  reason?: string;
  /** When the pause this trip put in force ends; null when one at least as long was already in force. Only on `trip`. */
  pause_until_unix_ms?: number | null;
  /** Set when the `.pause` write failed: this guard holds the pause in memory instead. */
  pause_write_failed?: true;
}

export interface ToolSettlement {
  /** What went on the ledger: the bill, or the worst case when there was none. */
  costUsd: number;
  metered: "usage" | "held_estimate";
  tripped: boolean;
  tripReason: string | null;
}

export interface ToolHold {
  readonly tool: string;
  readonly worstCaseUsd: number;
  /**
   * Record the call. Pass what the tool reported it billed, in USD, or null
   * when it gave no readable bill: the worst case is then recorded and the
   * guard trips. A bill above the worst case is recorded in full and trips.
   */
  /** After a settle whose ledger write failed, the bill is fixed: call `settle()` again to retry the write. */
  settle(billedUsd?: number | null): ToolSettlement;
  /** Drop the hold without recording spend. Only for a call that was never sent. */
  release(): void;
}

export interface ToolDecision {
  allowed: boolean;
  code: ToolVetoCode | null;
  message: string;
  /** Hour and day spend, holds included, as read for this decision. */
  hourUsd: number;
  dayUsd: number;
  /** Present exactly when `allowed` is true. Settle or release it. */
  hold: ToolHold | null;
}

export interface ToolGuard {
  /**
   * Decide and, when allowed, hold the worst case, in one synchronous step.
   * Call it before the first await of the tool call: two parallel calls
   * that each read the budget before either holds would both pass.
   */
  authorize(call: ToolCall): ToolDecision;
  /**
   * `authorize`, run `fn`, settle. `fn` resolves to the tool's result and
   * what it billed. A refusal throws `ToolRefusedError` before `fn` runs.
   * If `fn` throws or returns no readable bill, the worst case is recorded,
   * the guard trips, and the error is rethrown. The one exception: when
   * `fn` throws a `ToolNotSentError`, the hold is released, nothing is
   * recorded, the guard does not trip, and the error is rethrown. The same
   * happens when `options.isNotSent(err)` returns exactly `true`.
   */
  run<T>(
    call: ToolCall,
    fn: () => Promise<{ result: T; billedUsd: number | null | undefined }>,
    options?: ToolRunOptions,
  ): Promise<{ result: T; settlement: ToolSettlement }>;
  /** Hour and day spend on the ledger, holds included. */
  spend(): { hourUsd: number; dayUsd: number };
}

export interface ToolRunOptions {
  /**
   * Classify an error thrown by the tool function: return exactly `true`
   * when the call cannot have been sent (for example a DNS failure your
   * client reports before it opens a connection). The hold is then released
   * as for a `ToolNotSentError`. Anything else, including a truthy value
   * that is not `true` or a classifier that throws, fails closed: the worst
   * case is recorded and the guard trips.
   */
  isNotSent?: (err: unknown) => boolean;
}

/**
 * Thrown by `run` when the tool call completed but its spend could not be
 * written to the ledger. The guard has paused and the spend is counting in
 * memory. `result` is what the tool returned; call `hold.settle()` again
 * once the ledger is writable to put the spend on record.
 */
export class ToolSettleError<T = unknown> extends Error {
  readonly result: T;
  readonly hold: ToolHold;
  constructor(result: T, hold: ToolHold, cause: unknown) {
    super("the tool call completed but its spend could not be recorded", { cause });
    this.name = "ToolSettleError";
    this.result = result;
    this.hold = hold;
  }
}

/** Thrown by `run` when the guard refuses. Nothing was sent and nothing was spent. */
export class ToolRefusedError extends Error {
  readonly code: ToolVetoCode;
  readonly decision: ToolDecision;
  constructor(decision: ToolDecision) {
    super(decision.message);
    this.name = "ToolRefusedError";
    this.code = decision.code as ToolVetoCode;
    this.decision = decision;
  }
}

/**
 * Throw this from the function given to `run` when no byte of the request
 * can have left the process (a refusal your own code raised before it called
 * the client), so it cannot have been billed. `run` then releases the hold
 * instead of recording the worst case and tripping. A network error code is
 * not proof: a client that follows redirects can reach the tool, be billed,
 * and then fail a later hop with a DNS error or a refused connection. A
 * request that may have reached the tool must not use it.
 */
export class ToolNotSentError extends Error {
  constructor(message: string = "the tool call was never sent", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolNotSentError";
  }
}

// One ledger reader and one set of in-flight holds per ledger file, shared by
// every guard in this process: two guards on the same file must see each
// other's holds, or both would pass on the same unspent budget.
interface SharedState {
  path: string;
  ledger: Ledger;
  holds: Map<number, number>;
  nextHoldId: number;
  // A pause that could not be written to disk, or that covers spend the
  // ledger would not take. Shared, so every guard on this file honours it.
  heldPauseUntilMs: number;
}
// Entries live for the life of the process: one per distinct ledger file.
const sharedStates = new Map<string, SharedState>();

/** The ledger's real path, so a symlink or a different spelling is the same file. */
function canonicalPath(ledgerPath: string): string {
  const abs = path.resolve(ledgerPath);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

// The same entries by file identity (device and inode), so a second name for
// one file (a hard link) reaches the state its first name made.
const sharedStatesByFile = new Map<string, SharedState>();

/** Device and inode of the file at `filePath`, or null when it cannot be read. */
function fileIdentity(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * Create the ledger file when it is missing, so it has an identity before
 * a guard is keyed on it. Opening through a symlink whose target does not
 * exist yet creates the target. A failure here is left for the first ledger
 * write to report.
 */
function ensureLedgerFile(ledgerPath: string): void {
  const abs = path.resolve(ledgerPath);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.closeSync(fs.openSync(abs, "a"));
  } catch {
    // keyed on the path alone, as before
  }
}

function sharedStateFor(ledgerPath: string): SharedState {
  ensureLedgerFile(ledgerPath);
  const key = canonicalPath(ledgerPath);
  const fileId = fileIdentity(key);
  let state = sharedStates.get(key);
  if (state === undefined && fileId !== null) {
    // Only while that state's own path still names this file: an inode
    // number freed by a rotation can be reused by an unrelated file.
    const byFile = sharedStatesByFile.get(fileId);
    if (byFile !== undefined && fileIdentity(byFile.path) === fileId) state = byFile;
  }
  if (state === undefined) {
    const ledger = new Ledger(key);
    ledger.load();
    state = { path: key, ledger, holds: new Map(), nextHoldId: 1, heldPauseUntilMs: 0 };
  }
  sharedStates.set(key, state);
  if (fileId !== null) sharedStatesByFile.set(fileId, state);
  return state;
}

/**
 * End a torn last line before appending. A write cut short (a full disk, a
 * crash) leaves bytes with no newline; a row appended straight after them
 * becomes part of one unparseable line, and its spend is then read by
 * nobody. Ending the fragment first keeps the new row on a line of its own.
 */
function endTornTail(filePath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  let torn = false;
  try {
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      torn = fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (torn) fs.appendFileSync(filePath, "\n");
}

function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function finiteNonNegative(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function isBill(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createToolGuard(options: ToolGuardOptions): ToolGuard {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  // Snapshot policy once: mutating the options object later must not loosen a live guard.
  const ledgerPath = nonEmptyString("ledgerPath", options.ledgerPath);
  const killFilePath = nonEmptyString("killFilePath", options.killFilePath);
  const pauseFilePath = nonEmptyString("pauseFilePath", options.pauseFilePath);
  const maxCostPerCallUsd = finiteNonNegative("maxCostPerCallUsd", options.maxCostPerCallUsd);
  const maxUsdPerHour = finiteNonNegative("maxUsdPerHour", options.maxUsdPerHour);
  const maxUsdPerDay = finiteNonNegative("maxUsdPerDay", options.maxUsdPerDay);
  const rawTools = options.allowedTools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    throw new TypeError("allowedTools must be a non-empty array of tool names");
  }
  const allowedTools = new Set<string>();
  for (let index = 0; index < rawTools.length; index += 1) {
    allowedTools.add(nonEmptyString(`allowedTools[${index}]`, rawTools[index]));
  }
  const rawPause = options.tripPauseMs;
  let tripPauseMs = DEFAULT_TOOL_TRIP_PAUSE_MS;
  if (rawPause !== undefined) {
    if (
      typeof rawPause !== "number" || !Number.isSafeInteger(rawPause) ||
      rawPause < MIN_TOOL_TRIP_PAUSE_MS || rawPause > MAX_TOOL_TRIP_PAUSE_MS
    ) {
      throw new TypeError(
        `tripPauseMs must be a whole number from ${MIN_TOOL_TRIP_PAUSE_MS} to ${MAX_TOOL_TRIP_PAUSE_MS}`,
      );
    }
    tripPauseMs = rawPause;
  }

  const shared = sharedStateFor(ledgerPath);
  const ledger = shared.ledger;
  const append = (row: Parameters<Ledger["append"]>[0]): void => {
    endTornTail(shared.path);
    ledger.append(row);
  };

  /**
   * Hour and day spend: the ledger plus every open hold on this file. A hold
   * counts in full for as long as it is open, however long the call runs,
   * so a slow or abandoned call cannot age out of the budget unrecorded.
   */
  function spendNow(nowMs: number): { hourUsd: number; dayUsd: number } {
    const window = ledger.window(nowMs);
    let held = 0;
    for (const usd of shared.holds.values()) held += usd;
    return { hourUsd: window.hourUsd + held, dayUsd: window.dayUsd + held };
  }

  function line(
    record: ToolCallRecord,
    fields: { allowed: boolean; costUsd: number; veto: string | null; requestId: string | null; metered?: "usage" | "held_estimate" },
  ) {
    return {
      timestamp: new Date().toISOString(),
      model: TOOL_LEDGER_MODEL,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: fields.costUsd,
      allowed: fields.allowed,
      veto_reason: fields.veto,
      request_id: fields.requestId,
      ...(fields.metered ? { metered: fields.metered } : {}),
      tool: record,
    };
  }

  /**
   * Put a pause in force without touching the ledger: write `.pause` unless
   * one at least as long (or a corrupt sentinel, which already fails closed)
   * is there. A failed write is held in memory.
   */
  function forcePause(requestId: string | null): { pauseUntil: number | null; writeFailed: boolean } {
    const nowMs = Date.now();
    const untilUnixMs = nowMs + tripPauseMs;
    let pause;
    try {
      pause = checkPauseSwitch(pauseFilePath, nowMs);
    } catch {
      shared.heldPauseUntilMs = Math.max(shared.heldPauseUntilMs, untilUnixMs);
      return { pauseUntil: untilUnixMs, writeFailed: true };
    }
    if (pause.paused && (pause.untilUnixMs === null || pause.untilUnixMs >= untilUnixMs)) {
      return { pauseUntil: null, writeFailed: false };
    }
    try {
      writePauseSwitch(pauseFilePath, {
        ttlMs: tripPauseMs,
        reason: TOOL_GUARD_PAUSE_REASON,
        ...(requestId ? { decisionId: requestId } : {}),
        now: nowMs,
      });
      return { pauseUntil: untilUnixMs, writeFailed: false };
    } catch {
      shared.heldPauseUntilMs = Math.max(shared.heldPauseUntilMs, untilUnixMs);
      return { pauseUntil: untilUnixMs, writeFailed: true };
    }
  }

  /** Pause first, then record the trip: a ledger that cannot be written must not lose the pause. */
  function trip(tool: string, worstCaseUsd: number, reason: string, requestId: string | null): void {
    const { pauseUntil, writeFailed } = forcePause(requestId);
    append(line(
      {
        name: tool,
        event: "trip",
        worst_case_usd: worstCaseUsd,
        reason,
        pause_until_unix_ms: pauseUntil,
        ...(writeFailed ? { pause_write_failed: true as const } : {}),
      },
      { allowed: false, costUsd: 0, veto: TOOL_GUARD_PAUSE_REASON, requestId },
    ));
  }

  function authorize(call: ToolCall): ToolDecision {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new TypeError("call must be an object");
    }
    const tool = nonEmptyString("tool", call.tool);
    const rawRequestId = call.requestId;
    if (rawRequestId !== undefined && rawRequestId !== null && typeof rawRequestId !== "string") {
      throw new TypeError("requestId must be a string or null");
    }
    const requestId = rawRequestId ?? null;
    // Read the quote exactly once.
    const quoted = call.worstCaseUsd;
    const worst = isBill(quoted) ? quoted : null;

    const nowMs = Date.now();
    const window = spendNow(nowMs);
    const refuse = (code: ToolVetoCode, message: string): ToolDecision => {
      append(line(
        { name: tool, event: "refused", worst_case_usd: worst },
        { allowed: false, costUsd: 0, veto: code, requestId },
      ));
      return { allowed: false, code, message, hourUsd: window.hourUsd, dayUsd: window.dayUsd, hold: null };
    };

    if (checkKillSwitch(killFilePath)) {
      return refuse("kill_switch", "kill switch is on: no tool call is sent");
    }
    const pause = checkPauseSwitch(pauseFilePath, nowMs);
    if (pause.paused) {
      return refuse("payment_gate_halt", `paused: ${pause.reason ?? "payment_gate_halt"}`);
    }
    if (nowMs < shared.heldPauseUntilMs) {
      return refuse("payment_gate_halt", `paused: ${TOOL_GUARD_PAUSE_REASON}`);
    }
    if (!allowedTools.has(tool)) {
      return refuse("tool_not_allowed", `tool "${tool}" is not on the allow-list`);
    }
    if (worst === null) {
      return refuse("unbounded_cost", `tool "${tool}" has no finite worst-case cost for this call`);
    }
    // A ledger line with a cost that is not a number can make the totals NaN,
    // a string or negative, and every "over the limit" test below would then
    // pass. Spend that cannot be read is treated as over the limit.
    if (
      typeof window.hourUsd !== "number" || !Number.isFinite(window.hourUsd) || window.hourUsd < 0 ||
      typeof window.dayUsd !== "number" || !Number.isFinite(window.dayUsd) || window.dayUsd < 0 ||
      ledger.unreadableCostLines(nowMs) > 0
    ) {
      return refuse("budget_exceeded", "recorded spend on the ledger cannot be read as a non-negative number");
    }
    if (worst > maxCostPerCallUsd + EPS_USD) {
      return refuse("per_request_cap", `worst case $${worst} is over the per-call cap $${maxCostPerCallUsd}`);
    }
    if (window.hourUsd + worst > maxUsdPerHour + EPS_USD) {
      return refuse(
        "budget_exceeded",
        `worst case $${worst} on top of $${window.hourUsd} this hour is over the hourly limit $${maxUsdPerHour}`,
      );
    }
    if (window.dayUsd + worst > maxUsdPerDay + EPS_USD) {
      return refuse(
        "budget_exceeded",
        `worst case $${worst} on top of $${window.dayUsd} today is over the daily limit $${maxUsdPerDay}`,
      );
    }

    const holdId = shared.nextHoldId++;
    shared.holds.set(holdId, worst);
    let open = true;
    // Set by the first settle() whose ledger write failed. From then on the
    // bill is fixed: a retry cannot swap in a smaller one, and the hold can
    // no longer be released.
    let attempted: { billed: number | null } | null = null;
    const hold: ToolHold = Object.freeze({
      tool,
      worstCaseUsd: worst,
      settle(billedUsd?: number | null): ToolSettlement {
        if (!open) throw new Error("this hold was already settled or released");
        const billed = attempted !== null ? attempted.billed : isBill(billedUsd) ? billedUsd : null;
        const costUsd = billed ?? worst;
        const metered = billed === null ? "held_estimate" as const : "usage" as const;
        let tripReason: string | null = null;
        if (billed === null) {
          tripReason = `tool "${tool}" gave no readable bill; its worst case $${worst} was recorded`;
        } else if (billed > worst + EPS_USD) {
          tripReason = `tool "${tool}" billed $${billed}, over its worst case $${worst}`;
        }
        try {
          append(line(
            { name: tool, event: "settled", worst_case_usd: worst, billed_usd: billed },
            { allowed: true, costUsd, veto: null, requestId, metered },
          ));
        } catch (err) {
          // The spend could not be recorded. Keep it counting in memory at
          // the larger of the bill and the worst case, pause (on disk if
          // possible, in memory always), and leave the hold open so a later
          // settle() can retry the write.
          attempted = { billed };
          shared.holds.set(holdId, Math.max(costUsd, worst));
          forcePause(requestId);
          shared.heldPauseUntilMs = Math.max(shared.heldPauseUntilMs, Date.now() + tripPauseMs);
          throw err;
        }
        shared.holds.delete(holdId);
        open = false;
        if (tripReason !== null) trip(tool, worst, tripReason, requestId);
        return { costUsd, metered, tripped: tripReason !== null, tripReason };
      },
      release(): void {
        if (!open) throw new Error("this hold was already settled or released");
        if (attempted !== null) {
          throw new Error("a settle was attempted on this hold: it can only be settled, not released");
        }
        shared.holds.delete(holdId);
        open = false;
      },
    });
    return { allowed: true, code: null, message: "allowed", hourUsd: window.hourUsd, dayUsd: window.dayUsd, hold };
  }

  return Object.freeze({
    authorize,
    async run<T>(
      call: ToolCall,
      fn: () => Promise<{ result: T; billedUsd: number | null | undefined }>,
      options?: ToolRunOptions,
    ): Promise<{ result: T; settlement: ToolSettlement }> {
      if (typeof fn !== "function") throw new TypeError("fn must be a function");
      if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
        throw new TypeError("options must be an object");
      }
      // Read the classifier once, before anything is held.
      const isNotSent = options?.isNotSent;
      if (isNotSent !== undefined && typeof isNotSent !== "function") {
        throw new TypeError("isNotSent must be a function");
      }
      const decision = authorize(call);
      if (!decision.allowed || decision.hold === null) throw new ToolRefusedError(decision);
      const hold = decision.hold;
      let out: { result: T; billedUsd: number | null | undefined };
      try {
        out = await fn();
      } catch (err) {
        let notSent = err instanceof ToolNotSentError;
        if (!notSent && isNotSent !== undefined) {
          try {
            const verdict: unknown = isNotSent(err);
            if (verdict !== null && typeof verdict === "object" && typeof (verdict as PromiseLike<unknown>).then === "function") {
              // An async classifier is not `true`; do not let its rejection go unhandled.
              (verdict as PromiseLike<unknown>).then(undefined, () => {});
            }
            notSent = verdict === true;
          } catch {
            notSent = false; // a classifier that throws fails closed
          }
        }
        if (notSent) {
          hold.release();
          throw err;
        }
        // The call may have been billed: count the worst case and stop.
        try {
          hold.settle(null);
        } catch {
          // settle() already paused and kept the hold counting; the caller
          // needs the tool's own error, not the ledger's.
        }
        throw err;
      }
      // The tool function resolved, so the call was sent. From here nothing
      // releases the hold: the not-sent escape applies only to what fn throws.
      let result: T;
      let billedUsd: number | null | undefined;
      try {
        if (!out || typeof out !== "object") {
          throw new TypeError("fn must resolve to { result, billedUsd }");
        }
        result = out.result;
        // Read once: a bill that throws on read is no bill.
        billedUsd = out.billedUsd;
      } catch (err) {
        try {
          hold.settle(null);
        } catch {
          // paused and still counting; report the original problem
        }
        throw err;
      }
      let settlement: ToolSettlement;
      try {
        settlement = hold.settle(billedUsd);
      } catch (err) {
        // The result was paid for: hand it back with the hold, so the
        // caller can retry the ledger write.
        throw new ToolSettleError(result, hold, err);
      }
      return { result, settlement };
    },
    spend(): { hourUsd: number; dayUsd: number } {
      return spendNow(Date.now());
    },
  });
}
