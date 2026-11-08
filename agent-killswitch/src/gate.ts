import * as fs from "node:fs";
import { pessimisticRequestCostUsd } from "./pricing.js";

export type VetoCode = "budget_exceeded" | "kill_switch" | "per_request_cap" | "model_not_allowed";

export interface SpendWindow {
  minuteTokens: number;
  hourUsd: number;
  dayUsd: number;
}

export interface GateDecision {
  allowed: boolean;
  /** HTTP status to return on veto: 403 for the kill switch, 429 for budgets. */
  status: number;
  code: VetoCode | null;
  message: string;
  spentUsd: number;
  limitUsd: number;
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

export interface GateInput {
  killed: boolean;
  window: SpendWindow;
  model: string;
  /** Requested max_tokens, if the client sent one. Without it no pessimistic check is possible. */
  maxTokens: number | null;
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  /** When set, any other model is vetoed before budget math and before upstream. */
  allowedModels?: readonly string[] | null;
}

/** Pure pre-call budget evaluator. No I/O, no tokenizer. */
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

  // Token velocity gate: recorded tokens in the last 60 s plus this
  // request's max_tokens as a stand-in for its eventual size.
  const estTokens = input.maxTokens ?? 0;
  if (input.window.minuteTokens + estTokens > input.maxTokensPerMinute) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Token-per-minute limit ${input.maxTokensPerMinute} would be exceeded`,
      spentUsd: input.window.minuteTokens,
      limitUsd: input.maxTokensPerMinute,
    };
  }

  // Pessimistic cost gate: assume every requested max_token bills at the
  // output rate. Requests without max_tokens skip this check and are metered
  // on actual usage instead.
  if (input.maxTokens !== null) {
    const pessimistic = pessimisticRequestCostUsd(input.model, input.maxTokens);
    if (pessimistic > input.maxCostPerRequestUsd) {
      return {
        allowed: false,
        status: 429,
        code: "per_request_cap",
        message: `Request could cost $${pessimistic.toFixed(4)}, over the per-request cap $${input.maxCostPerRequestUsd.toFixed(2)}`,
        spentUsd: pessimistic,
        limitUsd: input.maxCostPerRequestUsd,
      };
    }
    if (input.window.hourUsd + pessimistic > input.maxUsdPerHour) {
      return {
        allowed: false,
        status: 429,
        code: "budget_exceeded",
        message: `Hourly limit $${input.maxUsdPerHour.toFixed(2)} would be exceeded`,
        spentUsd: input.window.hourUsd,
        limitUsd: input.maxUsdPerHour,
      };
    }
    if (input.window.dayUsd + pessimistic > input.maxUsdPerDay) {
      return {
        allowed: false,
        status: 429,
        code: "budget_exceeded",
        message: `Daily limit $${input.maxUsdPerDay.toFixed(2)} would be exceeded`,
        spentUsd: input.window.dayUsd,
        limitUsd: input.maxUsdPerDay,
      };
    }
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
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
