#!/usr/bin/env node
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { checkKillSwitch, checkPauseSwitch, evaluateGate, requestEstimate, vetoBody, writePauseSwitch } from "./gate.js";
import { Ledger } from "./ledger.js";
import { costUsd } from "./pricing.js";
import { forwardChatCompletion, type ForwardResult } from "./proxy.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, obj: object): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function createServer(): http.Server {
  const configPath = process.env.KILLSWITCH_CONFIG ?? "./config.yaml";
  const cfg = loadConfig(configPath);
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

  if (cfg.enableKillApi && req.method === "POST" && url.pathname === "/reset") {
    for (const p of [cfg.killFilePath, cfg.pauseFilePath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already absent */
      }
    }
    json(res, 200, { ok: true, killed: false, paused: false });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    json(res, 404, { error: { type: "not_found", message: "only POST /v1/chat/completions is proxied" } });
    return;
  }

  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json(res, 400, { error: { type: "invalid_request", message: "body must be JSON" } });
    return;
  }

  const model = typeof body["model"] === "string" ? (body["model"] as string) : "unknown";
  const maxTokens =
    typeof body["max_tokens"] === "number" && Number.isFinite(body["max_tokens"])
      ? Math.floor(body["max_tokens"] as number)
      : null;
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ??
    (typeof body["request_id"] === "string" ? (body["request_id"] as string) : randomUUID());
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const pause = checkPauseSwitch(cfg.pauseFilePath, nowMs);

  const decision = evaluateGate({
    killed: checkKillSwitch(cfg.killFilePath),
    paused: pause.paused,
    pauseReason: pause.reason,
    pauseDecisionId: pause.decisionId,
    window: ledger.window(),
    model,
    maxTokens,
    maxTokensPerMinute: cfg.maxTokensPerMinute,
    maxUsdPerHour: cfg.maxUsdPerHour,
    maxUsdPerDay: cfg.maxUsdPerDay,
    maxCostPerRequestUsd: cfg.maxCostPerRequestUsd,
    allowedModels: cfg.freeModels,
  });

  if (!decision.allowed) {
    if (decision.code === "budget_exceeded" && decision.pauseWindowMs) {
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
  const est = requestEstimate(model, maxTokens, cfg.maxCostPerRequestUsd, cfg.freeModels);
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
    );
  } finally {
    settleHold(ledger, holdId, result, { now, model, requestId, est, freeModels: cfg.freeModels });
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
  ctx: { now: string; model: string; requestId: string; est: { tokens: number; usd: number }; freeModels: readonly string[] },
): void {
  if (result?.usage) {
    const u = result.usage;
    ledger.settle(holdId, {
      timestamp: ctx.now,
      model: ctx.model,
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
      cost_usd: costUsd(ctx.model, u.prompt_tokens, u.completion_tokens, ctx.freeModels),
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
if (invokedAsMain()) {
  if (process.argv[2]) process.env.KILLSWITCH_CONFIG = process.argv[2];
  const cfg = loadConfig(process.env.KILLSWITCH_CONFIG ?? "./config.yaml");
  const port = Number(process.env.KILLSWITCH_PORT ?? process.env.PORT ?? cfg.port);
  // Default loopback for local runs. Containers set KILLSWITCH_HOST=0.0.0.0
  // (see Dockerfile) so Docker's published port can reach the server; the
  // host-side -p 127.0.0.1:... binding keeps it local-only from outside.
  const host = process.env.KILLSWITCH_HOST ?? "127.0.0.1";
  const server = createServer();
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
