import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { checkKillSwitch, evaluateGate, vetoBody } from "./gate.js";
import { Ledger } from "./ledger.js";
import { costUsd } from "./pricing.js";
import { forwardChatCompletion } from "./proxy.js";

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
    json(res, 200, {
      ok: true,
      killed: checkKillSwitch(cfg.killFilePath),
      hour_usd: w.hourUsd,
      day_usd: w.dayUsd,
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
    try {
      fs.unlinkSync(cfg.killFilePath);
    } catch {
      /* already absent */
    }
    json(res, 200, { ok: true, killed: false });
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
  const now = new Date().toISOString();

  const decision = evaluateGate({
    killed: checkKillSwitch(cfg.killFilePath),
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

  // Allowed: forward, then meter on the actual usage reported upstream.
  const result = await forwardChatCompletion(
    cfg.upstreamBaseUrl,
    cfg.apiKey,
    body,
    res,
    requestId,
    cfg.upstreamTimeoutMs,
    req.headers,
  );
  if (result.usage) {
    const u = result.usage;
    ledger.append({
      timestamp: now,
      model,
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
      cost_usd: costUsd(model, u.prompt_tokens, u.completion_tokens),
      allowed: true,
      veto_reason: null,
      request_id: requestId,
    });
  }
}

// CLI entry: `node dist/index.js [config.yaml]`.
const invokedAsMain = process.argv[1] !== undefined && import.meta.url.endsWith(
  process.argv[1].split("/").pop() ?? "",
);
if (invokedAsMain) {
  if (process.argv[2]) process.env.KILLSWITCH_CONFIG = process.argv[2];
  const cfg = loadConfig(process.env.KILLSWITCH_CONFIG ?? "./config.yaml");
  const port = Number(process.env.KILLSWITCH_PORT ?? process.env.PORT ?? cfg.port);
  // Default loopback for local runs. Containers set KILLSWITCH_HOST=0.0.0.0
  // (see Dockerfile) so Docker's published port can reach the server; the
  // host-side -p 127.0.0.1:... binding keeps it local-only from outside.
  const host = process.env.KILLSWITCH_HOST ?? "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`agent-killswitch listening on ${host}:${port}`);
  });
}
