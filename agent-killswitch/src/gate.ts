import * as fs from "node:fs";
import * as path from "node:path";
import { priceFor, type ModelRates } from "./pricing.js";

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
  /** Cap window duration (ms) when a budget_exceeded veto should write .pause. */
  pauseWindowMs?: number;
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

/**
 * Atomically write a `.pause` sentinel (temp file + fsync + rename) when a
 * budget cap is breached so the sibling payment gate halts for the cap window.
 */
export function writePauseSwitch(
  filePath: string,
  input: { ttlMs: number; reason: string; decisionId?: string; now?: number },
): void {
  if (typeof input.ttlMs !== "number" || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return;
  }
  const now = input.now ?? Date.now();
  const payload = {
    schema: PAUSE_SENTINEL_SCHEMA,
    until_unix_ms: Math.floor(now + input.ttlMs),
    reason: String(input.reason ?? "").trim() || "budget_exceeded",
    ...(input.decisionId ? { decision_id: input.decisionId } : {}),
  };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${now}.tmp`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export interface GateInput {
  modelRates?: ModelRates;
  killed: boolean;
  paused?: boolean;
  pauseReason?: string | null;
  pauseDecisionId?: string | null;
  window: SpendWindow;
  model: string;
  /** Requested max_tokens, if the client sent one. Without it the dollar estimate is the per-request cap. */
  maxTokens: number | null;
  /**
   * Size of the request, for the prompt-token bound (see requestEstimate).
   * Absent or invalid: the dollar estimate is never below the per-request cap.
   */
  prompt?: PromptSize | null;
  maxTokensPerMinute: number;
  maxUsdPerHour: number;
  maxUsdPerDay: number;
  maxCostPerRequestUsd: number;
  /** When set, any other model is vetoed before budget math and before upstream. */
  allowedModels?: readonly string[] | null;
  /**
   * Models priced at $0 for this request when they have no price row (see
   * priceFor). The caller passes the free allowlist for an unpaid call and
   * nothing for a call that carries a payment credential.
   */
  zeroPriceModels?: readonly string[] | null;
}

export interface RequestEstimate {
  /** Tokens held against the per-minute window: max_tokens plus the prompt-token bound. */
  tokens: number;
  /** Dollars held against the hourly and daily windows. */
  usd: number;
}

/** What the caller knows about the size of the request it is about to send. */
export interface PromptSize {
  /**
   * UTF-8 byte length of the whole serialized request body, or null when it
   * is not known. Anything but a non-negative safe integer counts as unknown.
   */
  bytes: number | null;
  /**
   * True only when isTextOnlyPrompt(body) is true: every prompt token comes
   * from text carried in those bytes. Anything but `true` counts as false.
   */
  textOnly: boolean;
}

// Top-level request fields that cannot add prompt tokens: sampling and
// transport settings, and the two fields the gate itself reads. Any other
// field (tools, response_format, plugins, a provider extension) may make the
// upstream add or fetch prompt content, so its presence ends the text-only
// bound.
const TEXT_ONLY_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "n",
  "stream",
  "stream_options",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "user",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "metadata",
  "store",
  "service_tier",
  "reasoning_effort",
  "request_id",
]);

// Message fields whose content, if any, is text inside the request bytes.
const TEXT_ONLY_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  "role",
  "content",
  "name",
  "tool_calls",
  "tool_call_id",
  "function_call",
  "refusal",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True only for a chat-completions body whose prompt is nothing but text
 * that is present in the body itself: an allowlisted set of top-level and
 * message fields, and message content that is a string, null/absent, or an
 * array of `{ "type": "text", "text": "<string>" }` parts.
 *
 * This is an allowlist, so it fails toward `false`: an image, audio or file
 * part, a file or URL reference, tools, a response schema, or any field this
 * function does not know returns false, and requestEstimate then holds at
 * least the per-request cap. The agent being limited writes the body, so an
 * unknown shape is never given the cheaper estimate.
 */
export function isTextOnlyPrompt(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  for (const key of Object.keys(body)) {
    if (!TEXT_ONLY_TOP_LEVEL_KEYS.has(key)) return false;
  }
  const messages = body["messages"];
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isPlainObject(message)) return false;
    for (const key of Object.keys(message)) {
      if (!TEXT_ONLY_MESSAGE_KEYS.has(key)) return false;
    }
    if (typeof message["role"] !== "string") return false;
    const content = message["content"];
    if (content === undefined || content === null || typeof content === "string") continue;
    if (!Array.isArray(content)) return false;
    for (const part of content) {
      if (!isPlainObject(part)) return false;
      const keys = Object.keys(part);
      if (keys.length !== 2 || part["type"] !== "text" || typeof part["text"] !== "string") return false;
    }
  }
  return true;
}

/** The prompt size as the estimate will use it: bytes or null, and whether the byte bound holds. */
function readPromptSize(prompt: PromptSize | null | undefined): { bytes: number | null; bounded: boolean } {
  if (!isPlainObject(prompt)) return { bytes: null, bounded: false };
  const raw = prompt["bytes"];
  const bytes = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  return { bytes, bounded: bytes !== null && prompt["textOnly"] === true };
}

/**
 * Pre-call estimate, used both by evaluateGate and by the in-flight hold.
 *
 * Prompt tokens are bounded without a tokenizer by the byte length of the
 * request body: one token per byte. A token of any tokenizer that splits
 * text into pieces covers at least one byte of the text it encodes, and a
 * JSON string is never shorter than the UTF-8 text it decodes to, so the
 * text in a body of B bytes is at most B tokens. That argument covers text
 * carried in the body and nothing else, so the bound is used alone only when
 * `prompt.textOnly` is true (isTextOnlyPrompt). See README "Prompt-token
 * bound" for the argument and what it assumes about the upstream.
 *
 * - Tokens: max_tokens (0 without it) plus the byte count (0 when unknown).
 * - Dollars, with max_tokens: max_tokens at the output rate plus the byte
 *   count at the input rate. Without max_tokens: the per-request cap, or the
 *   prompt bound's cost when that is higher.
 * - When the size is unknown, invalid, or the prompt is not text-only, the
 *   dollar estimate is never below the per-request cap.
 * - A model priced at $0 (see priceFor) holds no dollars.
 *
 * A max_tokens that is not a finite non-negative number is treated as absent.
 */
export function requestEstimate(
  model: string,
  maxTokens: number | null,
  maxCostPerRequestUsd: number,
  freeModels?: readonly string[] | null,
  rates?: ModelRates,
  prompt?: PromptSize | null,
): RequestEstimate {
  const { price } = priceFor(model, freeModels, rates);
  const free = price.inputPerMTok === 0 && price.outputPerMTok === 0;
  const { bytes, bounded } = readPromptSize(prompt);
  const promptTokens = bytes ?? 0;
  const outputTokens =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens >= 0 ? maxTokens : null;

  if (outputTokens === null) {
    const promptUsd = (promptTokens * price.inputPerMTok) / 1_000_000;
    return { tokens: promptTokens, usd: free ? 0 : Math.max(maxCostPerRequestUsd, promptUsd) };
  }
  const usd = (outputTokens * price.outputPerMTok + promptTokens * price.inputPerMTok) / 1_000_000;
  return {
    tokens: outputTokens + promptTokens,
    usd: bounded || free ? usd : Math.max(usd, maxCostPerRequestUsd),
  };
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

  if (input.paused && input.pauseReason !== "budget_exceeded") {
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
  const est = requestEstimate(input.model, input.maxTokens, input.maxCostPerRequestUsd, input.zeroPriceModels, input.modelRates, input.prompt);

  // Token velocity gate: tokens in the last 60 s (recorded and in flight)
  // plus this request's max_tokens and prompt-token bound as a stand-in for
  // its eventual size.
  if (input.window.minuteTokens + est.tokens > input.maxTokensPerMinute) {
    return {
      allowed: false,
      status: 429,
      code: "budget_exceeded",
      message: `Token-per-minute limit ${input.maxTokensPerMinute} would be exceeded`,
      spentUsd: input.window.minuteTokens,
      limitUsd: input.maxTokensPerMinute,
      pauseWindowMs: 60_000,
    };
  }

  // Pessimistic cost gate: every requested max_token bills at the output
  // rate and every request byte as one prompt token at the input rate.
  // Without max_tokens, or without a text-only prompt of known size, the
  // request is assumed to cost at least the per-request cap, so the hourly
  // and daily checks still run.
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
      pauseWindowMs: 3_600_000,
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
      pauseWindowMs: 86_400_000,
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
      pauseWindowMs: 3_600_000,
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
      pauseWindowMs: 86_400_000,
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
