#!/usr/bin/env node
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runVerifyLedger } from "./chain.js";
import { loadConfig, type KillswitchConfig } from "./config.js";
import {
  chatOutputLimit,
  checkKillSwitch,
  checkPauseSwitch,
  evaluateGate,
  isTextOnlyPrompt,
  requestEstimate,
  vetoBody,
  writePauseSwitch,
  type PromptSize,
} from "./gate.js";
import { Ledger } from "./ledger.js";
import { costUsd, type ModelRates } from "./pricing.js";
import { carriesPaymentCredential, forwardChatCompletion, outboundBodyText, type ForwardResult } from "./proxy.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

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

  return http.createServer((req, res) => {
    void handle(req, res, cfg, ledger).catch((err) => {
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
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/healthz") {
    const w = ledger.window();
    const pause = checkPauseSwitch(cfg.pauseFilePath);
    json(res, 200, {
      ok: true,
      killed: checkKillSwitch(cfg.killFilePath),
      paused: pause.paused,
      ...(pause.paused
        ? {
            pause_until_unix_ms: pause.untilUnixMs,
            pause_reason: pause.reason,
            pause_decision_id: pause.decisionId,
          }
        : {}),
      hour_usd: w.hourUsd,
      day_usd: w.dayUsd,
      in_flight: ledger.inFlight(),
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

  // The free allowlist prices an unlisted model at $0 only for an unpaid
  // call. Keyless mode is also how an MPP/x402 buyer runs the proxy, and a
  // call that carries a payment credential can cost money, so it keeps the
  // fail-closed price.
  const zeroPriceModels: readonly string[] = carriesPaymentCredential(req.headers) ? [] : cfg.freeModels;

  const decision = evaluateGate({
    killed: checkKillSwitch(cfg.killFilePath),
    paused: pause.paused,
    pauseReason: pause.reason,
    pauseDecisionId: pause.decisionId,
    window: ledger.window(),
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

  if (!decision.allowed) {
    // Do not shorten the pause this request saw in force: a 60 s
    // per-minute refusal must not cut an hourly or daily budget pause short,
    // which would release the sibling payment gate early. Nothing is awaited
    // between the read above and this write, so within one process this
    // holds; a pause another process writes in that gap can still be
    // replaced, as before.
    const longerPauseInForce =
      pause.paused && pause.untilUnixMs !== null && pause.untilUnixMs >= nowMs + (decision.pauseWindowMs ?? 0);
    if (decision.code === "budget_exceeded" && decision.pauseWindowMs && !longerPauseInForce) {
      try {
        writePauseSwitch(cfg.pauseFilePath, {
          ttlMs: decision.pauseWindowMs,
          reason: "budget_exceeded",
          decisionId: requestId,
          now: nowMs,
        });
      } catch {
        /* best-effort backpressure file write */
      }
    }
    ledger.append({
      timestamp: now,
      model,
      requested_model: model,
      served_model: null,
      model_mismatch: false,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      allowed: false,
      veto_reason: decision.code,
      request_id: requestId,
    });
    json(res, decision.status, vetoBody(decision));
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
    settleHold(ledger, holdId, result, { now, model, requestId, est, freeModels: zeroPriceModels, rates: cfg.modelRates });
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
  ctx: { now: string; model: string; requestId: string; est: { tokens: number; usd: number }; freeModels: readonly string[]; rates: ModelRates },
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
