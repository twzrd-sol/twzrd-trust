#!/usr/bin/env node
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  classifyUpstreamOutcome,
  REQUEST_RATE_PAUSE_MS,
  REQUEST_RATE_PAUSE_REASON,
  RequestRateLimiter,
  UPSTREAM_FAILURE_PAUSE_REASON,
  UpstreamFailureBreaker,
  type BreakerTripRecord,
} from "./breakers.js";
import { runVerifyLedger } from "./chain.js";
import { loadConfig, type KillswitchConfig } from "./config.js";
import {
  chatOutputLimit,
  checkKillSwitch,
  checkPauseSwitch,
  evaluateGate,
  evaluateSessionManagement,
  isTextOnlyPrompt,
  requestEstimate,
  vetoBody,
  writePauseSwitch,
  type GateDecision,
  type PauseSwitchState,
  type PromptSize,
  type SpendWindow,
} from "./gate.js";
import { Ledger, type LedgerLine } from "./ledger.js";
import { costUsd, type ModelRates } from "./pricing.js";
import {
  carriesPaymentCredential,
  forwardChatCompletion,
  forwardSessionManagement,
  outboundBodyText,
  sessionManagementKind,
  type ForwardResult,
} from "./proxy.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The `model` written on a session-management ledger line: no model was requested. */
export const SESSION_MANAGEMENT_MODEL = "(session-management)";

/** The `model` written on the line that records an upstream-failure breaker trip. */
export const BREAKER_MODEL = "(breaker)";

/**
 * One server's breaker state (breakers.ts). Each breaker is null when it is
 * off. `heldPause` is a trip whose `.pause` could not be written: this
 * process refuses what a pause refuses until it ends, so a breaker still
 * fails closed when the state directory is not writable.
 */
interface Breakers {
  upstream: UpstreamFailureBreaker | null;
  rate: RequestRateLimiter | null;
  heldPause: { untilUnixMs: number; reason: string; decisionId: string } | null;
}

function createBreakers(cfg: KillswitchConfig): Breakers {
  return {
    upstream:
      cfg.upstreamFailureThreshold > 0
        ? new UpstreamFailureBreaker(cfg.upstreamFailureThreshold, cfg.upstreamFailureCooldownMs)
        : null,
    rate: cfg.maxRequestsPerMinute > 0 ? new RequestRateLimiter(cfg.maxRequestsPerMinute) : null,
    heldPause: null,
  };
}

/** The request text and the number of bytes it arrived as (the prompt-token bound counts bytes). */
function readBody(req: http.IncomingMessage): Promise<{ text: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), bytes: size }));
    req.on("error", reject);
  });
}

/**
 * What the gate needs from a parsed chat-completions body: the model, a
 * usable max_tokens, the prompt size, and the exact text to forward.
 *
 * The prompt size is the larger of `rawBytes` (the body as received) and
 * the byte length of the text that will be forwarded. The forwarded text is
 * what the upstream tokenizes, and it can be longer than what arrived, so
 * the received size alone would under-count.
 *
 * The output limit and the text-only flag come from chatOutputLimit and
 * isTextOnlyPrompt (gate.ts), the same functions a createBudgetGate caller
 * gets through budgetInputForChatRequest.
 */
export function admissionRequest(
  body: Record<string, unknown>,
  rawBytes: number,
): { model: string; maxTokens: number | null; prompt: PromptSize; outboundText: string } {
  const model = typeof body["model"] === "string" ? (body["model"] as string) : "unknown";
  const outboundText = outboundBodyText(body);
  const bytes = Math.max(rawBytes, Buffer.byteLength(outboundText, "utf8"));
  return { model, maxTokens: chatOutputLimit(body), prompt: { bytes, textOnly: isTextOnlyPrompt(body) }, outboundText };
}

function json(res: http.ServerResponse, status: number, obj: object): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function createServer(
  cfg: KillswitchConfig = loadConfig(process.env.KILLSWITCH_CONFIG ?? "./config.yaml"),
): http.Server {
  const ledger = new Ledger(cfg.ledgerPath);
  const replayed = ledger.load();
  // eslint-disable-next-line no-console
  console.log(`agent-killswitch: replayed ${replayed} ledger lines from the last 48 h`);
  const breakers = createBreakers(cfg);
  if (breakers.rate) {
    const n = breakers.rate.limit;
    // eslint-disable-next-line no-console
    console.log(`agent-killswitch: request-rate limit on: ${n} ${n === 1 ? "request" : "requests"} per 60 s`);
  }
  if (breakers.upstream) {
    const n = breakers.upstream.threshold;
    // eslint-disable-next-line no-console
    console.log(
      `agent-killswitch: upstream-failure breaker on: trips after ${n} consecutive ` +
        `${n === 1 ? "failure" : "failures"}, pauses ${breakers.upstream.cooldownMs} ms`,
    );
  }

  return http.createServer((req, res) => {
    void handle(req, res, cfg, ledger, breakers).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: { type: "killswitch_error", message: "internal error" } });
      else {
        try {
          res.end();
        } catch {
          /* already torn down */
        }
      }
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
  ledger: Ledger,
  breakers: Breakers,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/healthz") {
    const w = ledger.window();
    const nowMs = Date.now();
    const pause = checkPauseSwitch(cfg.pauseFilePath, nowMs);
    const held = activeHeldPause(breakers, nowMs);
    const paused = pause.paused || held !== null;
    json(res, 200, {
      ok: true,
      killed: checkKillSwitch(cfg.killFilePath),
      paused,
      ...(pause.paused
        ? {
            pause_until_unix_ms: pause.untilUnixMs,
            pause_reason: pause.reason,
            pause_decision_id: pause.decisionId,
          }
        : held
          ? {
              pause_until_unix_ms: held.untilUnixMs,
              pause_reason: held.reason,
              pause_decision_id: held.decisionId,
              pause_held_in_memory: true,
            }
          : {}),
      hour_usd: w.hourUsd,
      day_usd: w.dayUsd,
      in_flight: ledger.inFlight(),
      ...breakersHealth(breakers, paused),
    });
    return;
  }

  if (cfg.enableKillApi && req.method === "POST" && url.pathname === "/kill") {
    fs.mkdirSync(path.dirname(cfg.killFilePath), { recursive: true });
    fs.writeFileSync(cfg.killFilePath, `${new Date().toISOString()}\n`);
    json(res, 200, { ok: true, killed: true });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    json(res, 404, { error: { type: "not_found", message: "only POST /v1/chat/completions is proxied" } });
    return;
  }

  const { text: raw, bytes: rawBytes } = await readBody(req);

  // MPP session management (close, topUp) arrives here with no body: no
  // inference, so no budget hold. A bodiless call that carries any other
  // credential is refused before it can move money unmetered.
  const management = sessionManagementKind(req.headers, raw);
  if (management === "refuse") {
    json(res, 400, {
      error: {
        type: "invalid_request",
        message: "a request with no body may carry only an MPP close or topUp credential",
      },
    });
    return;
  }
  if (management !== null) {
    await handleSessionManagement(req, res, cfg, ledger, breakers, management);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json(res, 400, { error: { type: "invalid_request", message: "body must be JSON" } });
    return;
  }

  const { model, maxTokens, prompt, outboundText } = admissionRequest(body, rawBytes);
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ??
    (typeof body["request_id"] === "string" ? (body["request_id"] as string) : randomUUID());
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const pause = checkPauseSwitch(cfg.pauseFilePath, nowMs);
  const window = ledger.window();

  // $0 pricing (the free allowlist, a built-in $0 row) is for an unpaid call.
  // Keyless mode is also how an MPP/x402 buyer runs the proxy, and a call
  // that carries a payment credential can cost money: it passes an empty
  // list, which prices nothing at $0. An unpaid call with no allowlist
  // passes no list, so a built-in $0 row keeps its catalog price.
  const paid = carriesPaymentCredential(req.headers);
  const zeroPriceModels: readonly string[] | null = paid
    ? []
    : cfg.freeModels.length > 0
      ? cfg.freeModels
      : null;

  const decision = evaluateGate({
    killed: checkKillSwitch(cfg.killFilePath),
    paused: pause.paused,
    pauseReason: pause.reason,
    pauseDecisionId: pause.decisionId,
    window,
    model,
    maxTokens,
    prompt,
    maxTokensPerMinute: cfg.maxTokensPerMinute,
    maxUsdPerHour: cfg.maxUsdPerHour,
    maxUsdPerDay: cfg.maxUsdPerDay,
    maxCostPerRequestUsd: cfg.maxCostPerRequestUsd,
    allowedModels: cfg.freeModels,
    zeroPriceModels,
    modelRates: cfg.modelRates,
  });

  const vetoLine = {
    timestamp: now,
    model,
    requested_model: model,
    served_model: null,
    model_mismatch: false,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    request_id: requestId,
  };

  if (!decision.allowed) {
    // Do not shorten the pause this request saw in force: a 60 s
    // per-minute refusal must not cut an hourly or daily budget pause short,
    // which would release the sibling payment gate early. Nothing is awaited
    // between the read above and this write, so within one process this
    // holds; a pause another process writes in that gap can still be
    // replaced, as before.
    if (decision.code === "budget_exceeded" && decision.pauseWindowMs) {
      writePauseUnlessLonger(cfg, pause, nowMs, decision.pauseWindowMs, "budget_exceeded", requestId);
    }
    ledger.append({ ...vetoLine, allowed: false, veto_reason: decision.code });
    json(res, decision.status, vetoBody(decision));
    return;
  }

  const admitted = admitThroughBreakers(cfg, ledger, breakers, { nowMs, requestId, window, line: vetoLine });
  if ("refused" in admitted) {
    json(res, admitted.refused.status, vetoBody(admitted.refused));
    return;
  }

  // Allowed: hold the same estimate the check used, in this turn (no await
  // between the check and the hold), so a concurrent request sees it.
  const est = requestEstimate(model, maxTokens, cfg.maxCostPerRequestUsd, zeroPriceModels, cfg.modelRates, prompt);
  const holdId = ledger.hold(est.tokens, est.usd, Date.parse(now));

  let result: ForwardResult | null = null;
  try {
    result = await forwardChatCompletion(
      cfg.upstreamBaseUrl,
      cfg.apiKey,
      body,
      res,
      requestId,
      cfg.upstreamTimeoutMs,
      req.headers,
      outboundText,
    );
  } finally {
    try {
      settleHold(ledger, holdId, result, { now, model, requestId, est, freeModels: zeroPriceModels, rates: cfg.modelRates });
    } finally {
      observeUpstream(cfg, ledger, breakers, admitted.ticket, result, paid, requestId);
    }
  }
}

/**
 * Write `.pause` for `ttlMs` unless `pause` (read at `nowMs`) is already in
 * force at least as long. A corrupt sentinel (in force, no end) is never
 * replaced: it halts until a person removes it, and a timed pause written
 * over it would end on its own. Returns when the written pause ends, null
 * when none was written, or "failed" when the write threw.
 */
function writePauseUnlessLonger(
  cfg: KillswitchConfig,
  pause: PauseSwitchState,
  nowMs: number,
  ttlMs: number,
  reason: string,
  decisionId: string,
): number | null | "failed" {
  const untilUnixMs = Math.floor(nowMs + ttlMs);
  if (pause.paused && (pause.untilUnixMs === null || pause.untilUnixMs >= untilUnixMs)) return null;
  try {
    writePauseSwitch(cfg.pauseFilePath, { ttlMs, reason, decisionId, now: nowMs });
    return untilUnixMs;
  } catch {
    return "failed";
  }
}

/** The pause a failed `.pause` write left in memory, while it is in force. */
function activeHeldPause(breakers: Breakers, nowMs: number): Breakers["heldPause"] {
  const held = breakers.heldPause;
  if (held === null) return null;
  if (nowMs >= held.untilUnixMs) {
    breakers.heldPause = null;
    return null;
  }
  return held;
}

/**
 * Put a breaker trip in force: write `.pause` for `ttlMs` unless a longer
 * pause is already in force. When the write fails, hold the pause in this
 * process instead. Returns the pause fields of the trip's ledger record.
 */
function tripPause(
  cfg: KillswitchConfig,
  breakers: Breakers,
  nowMs: number,
  ttlMs: number,
  reason: string,
  decisionId: string,
): Pick<BreakerTripRecord, "pause_until_unix_ms" | "pause_write_failed"> {
  const written = writePauseUnlessLonger(cfg, checkPauseSwitch(cfg.pauseFilePath, nowMs), nowMs, ttlMs, reason, decisionId);
  if (written !== "failed") return { pause_until_unix_ms: written };
  const untilUnixMs = Math.floor(nowMs + ttlMs);
  if (breakers.heldPause === null || breakers.heldPause.untilUnixMs < untilUnixMs) {
    breakers.heldPause = { untilUnixMs, reason, decisionId };
  }
  return { pause_until_unix_ms: untilUnixMs, pause_write_failed: true };
}

/**
 * The breaker checks for a request that passed every other check and is
 * about to be forwarded: a pause held in memory, then the request-rate
 * limit. A refusal is ledgered here (as `line` plus the veto) and returned.
 * Otherwise the request is counted against the rate limit and gets the
 * upstream-failure ticket to hand back to observeUpstream when it ends.
 */
function admitThroughBreakers(
  cfg: KillswitchConfig,
  ledger: Ledger,
  breakers: Breakers,
  ctx: {
    nowMs: number;
    requestId: string;
    window: SpendWindow;
    line: Omit<LedgerLine, "allowed" | "veto_reason">;
  },
): { refused: GateDecision } | { ticket: number | null } {
  const held = activeHeldPause(breakers, ctx.nowMs);
  if (held !== null) {
    const refused: GateDecision = {
      allowed: false,
      status: 429,
      code: "payment_gate_halt",
      message: `Payment gate pause active: ${held.reason} (held in memory: the pause file could not be written)`,
      spentUsd: ctx.window.hourUsd,
      limitUsd: cfg.maxUsdPerHour,
      decisionId: held.decisionId,
    };
    ledger.append({ ...ctx.line, allowed: false, veto_reason: refused.code });
    return { refused };
  }

  const rate = breakers.rate;
  const rateNow = performance.now();
  if (rate !== null && rate.full(rateNow)) {
    const inWindow = rate.count(rateNow);
    const pauseFields = tripPause(cfg, breakers, ctx.nowMs, REQUEST_RATE_PAUSE_MS, REQUEST_RATE_PAUSE_REASON, ctx.requestId);
    // As the token-per-minute refusal carries tokens in these two fields,
    // this one carries requests.
    const refused: GateDecision = {
      allowed: false,
      status: 429,
      code: "request_rate_limit",
      message: `Request-rate limit of ${rate.limit} per 60 s reached; requests are paused for 60 s`,
      spentUsd: inWindow,
      limitUsd: rate.limit,
    };
    ledger.append({
      ...ctx.line,
      allowed: false,
      veto_reason: refused.code,
      breaker: {
        name: "request_rate",
        event: "trip",
        reason: `${inWindow} ${inWindow === 1 ? "request" : "requests"} forwarded in the last 60 s; the limit is ${rate.limit}`,
        ...pauseFields,
        requests_in_window: inWindow,
        limit: rate.limit,
        window_ms: rate.windowMs,
      },
    });
    return { refused };
  }
  rate?.record(rateNow);
  return { ticket: breakers.upstream?.ticket() ?? null };
}

/**
 * Hand a forwarded call's end to the upstream-failure breaker. A trip writes
 * `.pause` for the cooldown and one ledger line with `model` "(breaker)".
 */
function observeUpstream(
  cfg: KillswitchConfig,
  ledger: Ledger,
  breakers: Breakers,
  ticket: number | null,
  result: ForwardResult | null,
  paid: boolean,
  requestId: string,
): void {
  const breaker = breakers.upstream;
  if (breaker === null || ticket === null) return;
  const trip = breaker.observe(ticket, classifyUpstreamOutcome(result, paid));
  if (trip === null) return;
  const nowMs = Date.now();
  const pauseFields = tripPause(cfg, breakers, nowMs, breaker.cooldownMs, UPSTREAM_FAILURE_PAUSE_REASON, requestId);
  ledger.append({
    timestamp: new Date(nowMs).toISOString(),
    model: BREAKER_MODEL,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    allowed: false,
    veto_reason: UPSTREAM_FAILURE_PAUSE_REASON,
    request_id: requestId,
    breaker: {
      name: "upstream_failure",
      event: trip.event,
      reason:
        trip.event === "trip"
          ? `${trip.consecutiveFailures} consecutive upstream ${trip.consecutiveFailures === 1 ? "failure" : "failures"}; the last was ${trip.detail}`
          : `a failure while half-open: ${trip.detail}`,
      ...pauseFields,
      consecutive_failures: trip.consecutiveFailures,
      threshold: breaker.threshold,
      cooldown_ms: breaker.cooldownMs,
    },
  });
}

/** The `/healthz` `breakers` block; absent when both breakers are off. */
function breakersHealth(breakers: Breakers, pausedNow: boolean): { breakers?: Record<string, unknown> } {
  const { upstream, rate } = breakers;
  if (upstream === null && rate === null) return {};
  return {
    breakers: {
      ...(upstream !== null
        ? {
            upstream_failure: {
              state: upstream.state(pausedNow),
              consecutive_failures: upstream.consecutiveFailures,
              threshold: upstream.threshold,
              cooldown_ms: upstream.cooldownMs,
            },
          }
        : {}),
      ...(rate !== null
        ? {
            request_rate: {
              requests_in_window: rate.count(performance.now()),
              limit: rate.limit,
              window_ms: rate.windowMs,
            },
          }
        : {}),
    },
  };
}

/**
 * Forward an MPP session-management call without a hold. The kill file still
 * refuses it, and a pause refuses a topUp (gate.ts evaluateSessionManagement).
 * The breakers act on what a pause acts on: a topUp counts against the
 * request-rate limit and the upstream-failure breaker; a close and a
 * bodiless request without a credential do not.
 * One ledger line is written either way, at cost 0, with `session_action`.
 */
async function handleSessionManagement(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: KillswitchConfig,
  ledger: Ledger,
  breakers: Breakers,
  action: "close" | "topUp" | "empty",
): Promise<void> {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const nowMs = Date.now();
  const pause = checkPauseSwitch(cfg.pauseFilePath, nowMs);
  const window = ledger.window();
  const decision = evaluateSessionManagement({
    action,
    killed: checkKillSwitch(cfg.killFilePath),
    paused: pause.paused,
    pauseReason: pause.reason,
    pauseDecisionId: pause.decisionId,
    window,
    maxUsdPerHour: cfg.maxUsdPerHour,
  });
  const line = {
    timestamp: new Date(nowMs).toISOString(),
    model: SESSION_MANAGEMENT_MODEL,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    request_id: requestId,
    session_action: action,
  };
  if (!decision.allowed) {
    ledger.append({ ...line, allowed: false, veto_reason: decision.code });
    json(res, decision.status, vetoBody(decision));
    return;
  }
  let ticket: number | null = null;
  if (action === "topUp") {
    const admitted = admitThroughBreakers(cfg, ledger, breakers, { nowMs, requestId, window, line });
    if ("refused" in admitted) {
      json(res, admitted.refused.status, vetoBody(admitted.refused));
      return;
    }
    ticket = admitted.ticket;
  }
  let result: ForwardResult | null = null;
  try {
    result = await forwardSessionManagement(cfg.upstreamBaseUrl, cfg.apiKey, res, requestId, cfg.upstreamTimeoutMs, req.headers);
  } finally {
    try {
      ledger.append({ ...line, allowed: true, veto_reason: null });
    } finally {
      observeUpstream(cfg, ledger, breakers, ticket, result, carriesPaymentCredential(req.headers), requestId);
    }
  }
}

/**
 * Turn the in-flight hold into a ledger line once the call ends.
 * - Upstream usage: the hold is dropped and the real cost is written.
 * - No usage after a 2xx (JSON without usage, a stream that ended without a
 *   usage event), a timeout, an unreachable upstream, or an error after the
 *   request was sent: the held estimate is written, so a restart replays it.
 * - An answered non-2xx without usage (for example a 402 payment challenge)
 *   was not served and is not billed: the hold is released, nothing is written.
 */
function settleHold(
  ledger: Ledger,
  holdId: number,
  result: ForwardResult | null,
  ctx: { now: string; model: string; requestId: string; est: { tokens: number; usd: number }; freeModels: readonly string[] | null; rates: ModelRates },
): void {
  const telemetry = { requested_model: ctx.model, served_model: result?.servedModel ?? null, model_mismatch: result?.servedModel != null && result.servedModel !== ctx.model };
  if (result?.usage) {
    const u = result.usage;
    ledger.settle(holdId, {
      timestamp: ctx.now,
      model: ctx.model,
      ...telemetry,
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
      cost_usd: costUsd(ctx.model, u.prompt_tokens, u.completion_tokens, ctx.freeModels, ctx.rates),
      allowed: true,
      veto_reason: null,
      request_id: ctx.requestId,
      metered: "usage",
    });
    return;
  }
  const answeredUnbilled = result !== null && result.outcome === "answered" && (result.status < 200 || result.status >= 300);
  if (answeredUnbilled) {
    ledger.release(holdId);
    return;
  }
  ledger.settle(holdId, {
    timestamp: ctx.now,
    model: ctx.model,
    ...telemetry,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: ctx.est.tokens,
    cost_usd: ctx.est.usd,
    allowed: true,
    veto_reason: null,
    request_id: ctx.requestId,
    metered: "held_estimate",
  });
}

// Follow npm/npx bin symlinks: argv[1] is the shim, not this file.
function invokedAsMain(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const runAsMain = invokedAsMain();
if (runAsMain && process.argv[2] === "verify-ledger") {
  // Offline audit of the ledger's hash chain: no config, no API key, no network.
  process.exitCode = runVerifyLedger(process.argv.slice(3));
} else if (runAsMain) {
  if (process.argv[2]) process.env.KILLSWITCH_CONFIG = process.argv[2];
  // Expected startup failures (bad config, unreadable ledger) are operator
  // errors, not programmer faults: one actionable line and exit 1, no Node
  // stack trace. Programmatic callers of loadConfig still get the exception.
  // Explicit type so TypeScript treats a call as the end of this branch.
  const fail: (message: string) => never = (message) => {
    // eslint-disable-next-line no-console
    console.error(`agent-killswitch: ${message}`);
    process.exit(1);
  };
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let cfg: KillswitchConfig;
  try {
    cfg = loadConfig(process.env.KILLSWITCH_CONFIG ?? "./config.yaml");
  } catch (err) {
    fail(reason(err));
  }
  const port = cfg.port;
  // Default loopback for local runs. Containers set KILLSWITCH_HOST=0.0.0.0
  // (see Dockerfile) so Docker's published port can reach the server; the
  // host-side -p 127.0.0.1:... binding keeps it local-only from outside.
  const host = process.env.KILLSWITCH_HOST ?? "127.0.0.1";
  let server: http.Server;
  try {
    server = createServer(cfg);
  } catch (err) {
    fail(`cannot read the ledger at ${cfg.ledgerPath}: ${reason(err)}`);
  }
  // A taken port is the most common first-run failure: say what to change
  // instead of dumping a Node stack trace.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      const other = port < 65535 ? port + 1 : port - 1;
      console.error(
        `agent-killswitch: port ${port} on ${host} is already in use ` +
          `(another agent-killswitch may be running). ` +
          `Set KILLSWITCH_PORT to a free port, for example KILLSWITCH_PORT=${other}.`,
      );
      process.exit(1);
    }
    if (err.code === "EACCES") {
      // eslint-disable-next-line no-console
      console.error(`agent-killswitch: no permission to listen on ${host}:${port}.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`agent-killswitch listening on ${host}:${port}`);
  });
}
