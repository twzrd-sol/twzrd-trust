/*
 * Mastra beforeToolCall adapter for @twzrd1111/agent-killswitch.
 *
 * Mastra's agent-level `hooks.beforeToolCall` runs before every tool call
 * (@mastra/core >= 1.49.0). Returning `{ proceed: false, output }` blocks
 * the tool call and the agent receives `output` as the tool result. This
 * adapter returns Mastra's block shape on a killswitch veto; the `output`
 * payload keeps the proxy's OpenAI-shaped veto object so agent frameworks
 * handle it like a normal error result.
 *
 * No file I/O, no daemon, no network access from the hook itself: the
 * spend window is caller-owned and updated synchronously, so parallel tool
 * calls cannot both read a stale window. For the JSONL ledger, the kill
 * file and the upstream lifecycle, run the proxy itself instead.
 *
 * Written against @twzrd1111/agent-killswitch 0.1.11. Since 0.1.11 the
 * estimate counts the prompt: give `promptBytes` and `promptTextOnly` for
 * the model call a tool makes (`budgetInputForChatRequest(text)` reads both
 * from the request text). Without them every call holds at least
 * `maxCostPerRequestUsd`.
 */
import { createBudgetGate } from "@twzrd1111/agent-killswitch";
import type { BudgetGate, BudgetGateEstimateInput, BudgetGateRequest } from "@twzrd1111/agent-killswitch";

export interface ToolCallEstimate {
  /** Model id used for pricing. Unknown ids are priced at the $15/$60 fallback. */
  model: string;
  /**
   * Output limit for the model call this tool triggers (`chatOutputLimit(body)`),
   * or null if unknown; null holds the per-request cap.
   */
  maxTokens?: number | null;
  /**
   * UTF-8 byte length of the request text the tool sends. Omitted or null:
   * the dollar estimate is never below `maxCostPerRequestUsd`.
   */
  promptBytes?: number | null;
  /**
   * `isTextOnlyPrompt(JSON.parse(text))` for that text. Omitted means false,
   * which also keeps the estimate at or above `maxCostPerRequestUsd`.
   */
  promptTextOnly?: boolean | null;
  /** Override the zero-price list for this call (e.g. [] for a paid x402/MPP call). */
  zeroPriceModels?: readonly string[] | null;
}

export interface CallerWindow {
  minuteTokens: number;
  hourUsd: number;
  dayUsd: number;
}

export interface AgentKillswitchHookOptions {
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  /** Caller-owned live window. Mutated synchronously by the hooks. */
  window: CallerWindow;
  /**
   * Map a tool call to its estimated model cost. Called BEFORE gate
   * evaluation; must be pure. Throwing here means the tool call does not
   * execute (fail closed).
   */
  estimate: (call: { toolName: string; input: unknown }) => ToolCallEstimate;
  /**
   * Optional actual-usage reporter, called from afterToolCall. When it
   * returns numbers, the in-flight hold is replaced by the actuals; when it
   * returns undefined (or is omitted) the hold stays as the billable
   * estimate of the call.
   */
  actualCost?: (args: {
    toolName: string;
    input: unknown;
    output?: unknown;
    error?: unknown;
  }) => { tokens?: number; usd?: number } | undefined;
  /** Optional kill-switch predicate (e.g. your own flag; no file I/O here). */
  isKilled?: () => boolean;
  /** Optional pause-sentinel predicate (e.g. x402 payment-gate backpressure). */
  isPaused?: () => boolean;
  /** Override gate construction (the default binds the limits above). */
  gate?: BudgetGate;
}

/**
 * Mastra's `ToolBeforeHookResult`: the only non-void return of
 * `beforeToolCall`. `proceed` must be the literal `false`; any other shape
 * does not type-check as Mastra's `ToolHooks`.
 */
export interface BeforeToolCallResult {
  proceed: false;
  output: unknown;
}

/** OpenAI-shaped refusal body, same contract as the proxy's vetoBody(). */
export function refusalPayload(decision: {
  code: string | null;
  message: string;
  spentUsd: number;
  limitUsd: number;
  decisionId?: string | null;
}) {
  return {
    error: {
      type: "killswitch_veto",
      code: decision.code,
      message: decision.message,
      spent_usd: Math.round(decision.spentUsd * 10000) / 10000,
      limit_usd: decision.limitUsd,
      ...(decision.decisionId ? { decision_id: decision.decisionId } : {}),
    },
  };
}

/** The estimate fields both `evaluate()` and `estimate()` read, built once so they cannot differ. */
function toEstimateInput(estimate: ToolCallEstimate): BudgetGateEstimateInput {
  return {
    model: estimate.model,
    maxTokens: estimate.maxTokens ?? null,
    promptBytes: estimate.promptBytes ?? null,
    promptTextOnly: estimate.promptTextOnly ?? null,
    zeroPriceModels: estimate.zeroPriceModels,
  };
}

function toBudgetGateRequest(input: BudgetGateEstimateInput, opts: AgentKillswitchHookOptions): BudgetGateRequest {
  return {
    ...input,
    window: { ...opts.window },
    killed: opts.isKilled?.() ?? false,
    paused: opts.isPaused?.() ?? false,
  };
}

export function createAgentKillswitchHooks(options: AgentKillswitchHookOptions) {
  const { window } = options;
  if (!window || typeof window !== "object") {
    throw new TypeError("options.window must be a caller-owned { minuteTokens, hourUsd, dayUsd } object");
  }
  for (const key of ["minuteTokens", "hourUsd", "dayUsd"] as const) {
    if (typeof window[key] !== "number" || !Number.isFinite(window[key]) || window[key] < 0) {
      throw new TypeError(`options.window.${key} must be a finite non-negative number`);
    }
  }
  const gate = options.gate ?? createBudgetGate({
    maxTokensPerMinute: options.maxTokensPerMinute,
    maxUsdPerHour: options.maxUsdPerHour,
    maxUsdPerDay: options.maxUsdPerDay,
    maxCostPerRequestUsd: options.maxCostPerRequestUsd,
  });

  // Unreleased holds keyed by toolName, FIFO. afterToolCall settles the
  // oldest hold for the same tool; with parallel same-tool calls the first
  // completion settles the first call's hold.
  const pendingHolds = new Map<string, Array<{ tokens: number; usd: number }>>();

  const beforeToolCall = (
    { toolName, input }: { toolName: string; input: unknown },
  ): BeforeToolCallResult | undefined => {
    const estimate = options.estimate({ toolName, input }); // throws -> call does not execute
    if (!estimate || typeof estimate.model !== "string" || estimate.model.trim() === "") {
      throw new TypeError(
        "options.estimate must return { model: string, maxTokens?, promptBytes?, promptTextOnly?, zeroPriceModels? }",
      );
    }
    // Synchronous section: evaluate and hold before any await so parallel
    // tool calls cannot both read the pre-hold window.
    const gateInput = toEstimateInput(estimate);
    const decision = gate.evaluate(toBudgetGateRequest(gateInput, options));
    if (!decision.allowed) {
      return { proceed: false, output: refusalPayload(decision) };
    }
    const hold = gate.estimate(gateInput);
    window.minuteTokens += hold.tokens;
    window.hourUsd += hold.usd;
    window.dayUsd += hold.usd;
    const holds = pendingHolds.get(toolName) ?? [];
    holds.push(hold);
    pendingHolds.set(toolName, holds);
    return undefined; // allow: Mastra proceeds with the tool call
  };

  const afterToolCall = (
    args: { toolName: string; input: unknown; output?: unknown; error?: unknown },
  ): void => {
    const holds = pendingHolds.get(args.toolName);
    const hold = holds && holds.length > 0 ? holds.shift()! : undefined;
    const actual = options.actualCost?.(args);
    if (!hold) return; // nothing to settle (e.g. call was blocked)
    if (!actual) return; // hold stays as the billable estimate of the call
    const actualTokens = typeof actual.tokens === "number" && Number.isFinite(actual.tokens) ? actual.tokens : hold.tokens;
    const actualUsd = typeof actual.usd === "number" && Number.isFinite(actual.usd) ? actual.usd : hold.usd;
    window.minuteTokens = Math.max(0, window.minuteTokens - hold.tokens + actualTokens);
    window.hourUsd = Math.max(0, window.hourUsd - hold.usd + actualUsd);
    window.dayUsd = Math.max(0, window.dayUsd - hold.usd + actualUsd);
    if (holds && holds.length === 0) pendingHolds.delete(args.toolName);
  };

  return { beforeToolCall, afterToolCall };
}
