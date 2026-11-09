import * as fs from "node:fs";
import { pessimisticRequestCostUsd } from "./pricing.js";

export type VetoCode =
  | "budget_exceeded"
  | "kill_switch"
  | "payment_gate_halt"
  | "per_request_cap"
  | "model_not_allowed";

export const PAUSE_SENTINEL_SCHEMA = "twzrd.pause_sentinel.v1" as const;

export interface PauseSwitchState {
  paused: boolean;
  corrupt: boolean;
  expired: boolean;
  untilUnixMs: number | null;
  reason: string | null;
  decisionId: string | null;
}

export interface SpendWindow {
  minuteTokens: number;
  hourUsd: number;
  dayUsd: number;
}

export interface GateDecision {
  allowed: boolean;
  /** HTTP status to return on veto: 403 for the kill switch, 429 for budgets and payment gate pauses. */
  status: number;
  code: VetoCode | null;
  message: string;
  spentUsd: number;
  limitUsd: number;
  decisionId?: string | null;
}

/** Instant kill switch: the mere existence of the file vetoes everything. */
export function checkKillSwitch(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    // If we cannot even stat the file, fail closed.
    return true;
  }
}

/**
 * Payment-gate backpressure sentinel (.pause).
 *
 * - Missing file (ENOENT): not paused.
 * - Unreadable, non-JSON, unknown schema, or invalid until_unix_ms: fail closed (paused=true, corrupt=true).
 * - Valid until_unix_ms > now: paused (429 payment_gate_halt).
 * - Valid until_unix_ms <= now: expired, not paused (allows requests without mutating disk).
 */
export function checkPauseSwitch(filePath: string, now = Date.now()): PauseSwitchState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        paused: false,
        corrupt: false,
        expired: false,
        untilUnixMs: null,
        reason: null,
        decisionId: null,
      };
    }
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  const obj = parsed as Record<string, unknown>;
  if ("schema" in obj && obj["schema"] !== PAUSE_SENTINEL_SCHEMA) {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  const until = obj["until_unix_ms"];
  if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
    return {
      paused: true,
      corrupt: true,
      expired: false,
      untilUnixMs: null,
      reason: "corrupt_pause_sentinel",
      decisionId: null,
    };
  }

  const reason =
    typeof obj["reason"] === "string" && obj["reason"].trim().length > 0
      ? obj["reason"].trim()
      : null;
  const decisionId =
    typeof obj["decision_id"] === "string" && obj["decision_id"].trim().length > 0
      ? obj["decision_id"].trim()
      : null;

  if (now < until) {
    return {
      paused: true,
      corrupt: false,
      expired: false,
      untilUnixMs: until,
      reason: reason ?? "payment_gate_halt",
      decisionId,
    };
  }

  return {
    paused: false,
    corrupt: false,
    expired: true,
    untilUnixMs: until,
    reason,
    decisionId,
  };
}

export interface GateInput {
  killed: boolean;
  paused?: boolean;
  pauseReason?: string | null;
  pauseDecisionId?: string | null;
  window: SpendWindow;
  model: string;
  /** Requested max_tokens, if the client sent one. Without it the dollar estimate is the per-request cap. */
  maxTokens: number | null;
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  /** When set, any other model is vetoed before budget math and before upstream. */
  allowedModels?: readonly string[] | null;
}

export interface RequestEstimate {
  /** Tokens held against the per-minute window: max_tokens, or 0 without it. */
  tokens: number;
  /** Dollars held against the hourly and daily windows. */
  usd: number;
}

/**
 * Pre-call estimate, used both by evaluateGate and by the in-flight hold.
 * With max_tokens: all of them at the output rate. Without it there is no
 * token estimate, and the dollar estimate is the per-request cap.
 */
export function requestEstimate(model: string, maxTokens: number | null, maxCostPerRequestUsd: number): RequestEstimate {
  if (maxTokens === null) return { tokens: 0, usd: maxCostPerRequestUsd };
  return { tokens: maxTokens, usd: pessimisticRequestCostUsd(model, maxTokens) };
}

/** Pure pre-call budget evaluator. No I/O, no tokenizer. The window must include in-flight holds. */
export function evaluateGate(input: GateInput): GateDecision {
  if (input.killed) {
    return {
      allowed: false,
      status: 403,
      code: "kill_switch",
      message: "Kill switch engaged",
      spentUsd: input.window.hourUsd,
      limitUsd: input.maxUsdPerHour,
    };
  }

  if (input.paused) {
    const detail = input.pauseReason ? `: ${input.pauseReason}` : "";
    return {
      allowed: false,
      status: 429,
      code: "payment_gate_halt",
      message: `Payment gate pause active${detail}`,
      spentUsd: input.window.hourUsd,
      limitUsd: input.maxUsdPerHour,
      decisionId: input.pauseDecisionId ?? null,
    };
  }

  if (input.allowedModels && input.allowedModels.length > 0 && !input.allowedModels.includes(input.model)) {
    return {
      allowed: false,
      status: 403,
      code: "model_not_allowed",
      message: "model is not on the free allowlist",
      spentUsd: 0,
      limitUsd: 0,
    };
  }

  // The same estimate the caller holds while the request is in flight.
  const est = requestEstimate(input.model, input.maxTokens, input.maxCostPerRequestUsd);

  // Token velocity gate: tokens in the last 60 s (recorded and in flight)
  // plus this request's max_tokens as a stand-in for its eventual size.
  if (input.window.minuteTokens + est.tokens > input.maxTokensPerMinute) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Token-per-minute limit ${input.maxTokensPerMinute} would be exceeded`,
      spentUsd: input.window.minuteTokens,
      limitUsd: input.maxTokensPerMinute,
    };
  }

  // Pessimistic cost gate: every requested max_token bills at the output
  // rate. Without max_tokens the request is assumed to cost the per-request
  // cap, so the hourly and daily checks still run.
  if (est.usd > input.maxCostPerRequestUsd) {
    return {
      allowed: false,
      status: 429,
      code: "per_request_cap",
      message: `Request could cost $${est.usd.toFixed(4)}, over the per-request cap $${input.maxCostPerRequestUsd.toFixed(2)}`,
      spentUsd: est.usd,
      limitUsd: input.maxCostPerRequestUsd,
    };
  }
  if (input.window.hourUsd + est.usd > input.maxUsdPerHour) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Hourly limit $${input.maxUsdPerHour.toFixed(2)} would be exceeded`,
      spentUsd: input.window.hourUsd,
      limitUsd: input.maxUsdPerHour,
    };
  }
  if (input.window.dayUsd + est.usd > input.maxUsdPerDay) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Daily limit $${input.maxUsdPerDay.toFixed(2)} would be exceeded`,
      spentUsd: input.window.dayUsd,
      limitUsd: input.maxUsdPerDay,
    };
  }

  // Hard caps apply even without max_tokens: an already-blown window vetoes.
  if (input.window.hourUsd >= input.maxUsdPerHour) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Hourly limit $${input.maxUsdPerHour.toFixed(2)} hit`,
      spentUsd: input.window.hourUsd,
      limitUsd: input.maxUsdPerHour,
    };
  }
  if (input.window.dayUsd >= input.maxUsdPerDay) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Daily limit $${input.maxUsdPerDay.toFixed(2)} hit`,
      spentUsd: input.window.dayUsd,
      limitUsd: input.maxUsdPerDay,
    };
  }

  return { allowed: true, status: 200, code: null, message: "allowed", spentUsd: 0, limitUsd: 0 };
}

/** OpenAI-shaped veto body so agent frameworks handle it like a normal API error. */
export function vetoBody(decision: GateDecision): object {
  return {
    error: {
      type: "killswitch_veto",
      code: decision.code,
      message: decision.message,
      spent_usd: round4(decision.spentUsd),
      limit_usd: decision.limitUsd,
      ...(decision.decisionId ? { decision_id: decision.decisionId } : {}),
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
