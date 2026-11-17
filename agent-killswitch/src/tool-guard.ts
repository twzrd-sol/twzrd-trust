import {
  checkKillSwitch,
  checkPauseSwitch,
  writePauseSwitch,
} from "./gate.js";
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
  /** How long a trip pauses everything on this state directory. Default one hour, at most one day. */
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
  settle(billedUsd: number | null | undefined): ToolSettlement;
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
   * the guard trips, and the error is rethrown.
   */
  run<T>(
    call: ToolCall,
    fn: () => Promise<{ result: T; billedUsd: number | null | undefined }>,
  ): Promise<{ result: T; settlement: ToolSettlement }>;
  /** Hour and day spend on the ledger, holds included. */
  spend(): { hourUsd: number; dayUsd: number };
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
      typeof rawPause !== "number" || !Number.isFinite(rawPause) ||
      rawPause <= 0 || rawPause > MAX_TOOL_TRIP_PAUSE_MS
    ) {
      throw new TypeError(`tripPauseMs must be above 0 and at most ${MAX_TOOL_TRIP_PAUSE_MS}`);
    }
    tripPauseMs = rawPause;
  }

  const ledger = new Ledger(ledgerPath);
  ledger.load();
  // A trip whose `.pause` could not be written is held here, for this guard only.
  let heldPauseUntilMs = 0;

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

  function trip(tool: string, worstCaseUsd: number, reason: string, requestId: string | null): void {
    const nowMs = Date.now();
    const untilUnixMs = Math.floor(nowMs + tripPauseMs);
    const pause = checkPauseSwitch(pauseFilePath, nowMs);
    let pauseUntil: number | null = null;
    let writeFailed = false;
    // Never shorten a longer pause and never replace a corrupt sentinel (it already fails closed).
    if (!(pause.paused && (pause.untilUnixMs === null || pause.untilUnixMs >= untilUnixMs))) {
      try {
        writePauseSwitch(pauseFilePath, {
          ttlMs: tripPauseMs,
          reason: TOOL_GUARD_PAUSE_REASON,
          ...(requestId ? { decisionId: requestId } : {}),
          now: nowMs,
        });
      } catch {
        writeFailed = true;
        heldPauseUntilMs = Math.max(heldPauseUntilMs, untilUnixMs);
      }
      pauseUntil = untilUnixMs;
    }
    ledger.append(line(
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
    const window = ledger.window(nowMs);
    const refuse = (code: ToolVetoCode, message: string): ToolDecision => {
      ledger.append(line(
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
    if (nowMs < heldPauseUntilMs) {
      return refuse("payment_gate_halt", `paused: ${TOOL_GUARD_PAUSE_REASON}`);
    }
    if (!allowedTools.has(tool)) {
      return refuse("tool_not_allowed", `tool "${tool}" is not on the allow-list`);
    }
    if (worst === null) {
      return refuse("unbounded_cost", `tool "${tool}" has no finite worst-case cost for this call`);
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

    const holdId = ledger.hold(0, worst, nowMs);
    let open = true;
    const hold: ToolHold = Object.freeze({
      tool,
      worstCaseUsd: worst,
      settle(billedUsd: number | null | undefined): ToolSettlement {
        if (!open) throw new Error("this hold was already settled or released");
        const billed = isBill(billedUsd) ? billedUsd : null;
        const costUsd = billed ?? worst;
        const metered = billed === null ? "held_estimate" as const : "usage" as const;
        // Append first: if the write throws, the hold stays open and keeps counting.
        ledger.settle(holdId, line(
          { name: tool, event: "settled", worst_case_usd: worst, billed_usd: billed },
          { allowed: true, costUsd, veto: null, requestId, metered },
        ));
        open = false;
        let tripReason: string | null = null;
        if (billed === null) {
          tripReason = `tool "${tool}" gave no readable bill; its worst case $${worst} was recorded`;
        } else if (billed > worst + EPS_USD) {
          tripReason = `tool "${tool}" billed $${billed}, over its worst case $${worst}`;
        }
        if (tripReason !== null) trip(tool, worst, tripReason, requestId);
        return { costUsd, metered, tripped: tripReason !== null, tripReason };
      },
      release(): void {
        if (!open) throw new Error("this hold was already settled or released");
        ledger.release(holdId);
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
    ): Promise<{ result: T; settlement: ToolSettlement }> {
      if (typeof fn !== "function") throw new TypeError("fn must be a function");
      const decision = authorize(call);
      if (!decision.allowed || decision.hold === null) throw new ToolRefusedError(decision);
      let out: { result: T; billedUsd: number | null | undefined };
      try {
        out = await fn();
      } catch (err) {
        // The call may have been billed: count the worst case and stop.
        decision.hold.settle(null);
        throw err;
      }
      if (!out || typeof out !== "object") {
        decision.hold.settle(null);
        throw new TypeError("fn must resolve to { result, billedUsd }");
      }
      const settlement = decision.hold.settle(out.billedUsd);
      return { result: out.result, settlement };
    },
    spend(): { hourUsd: number; dayUsd: number } {
      const window = ledger.window();
      return { hourUsd: window.hourUsd, dayUsd: window.dayUsd };
    },
  });
}
