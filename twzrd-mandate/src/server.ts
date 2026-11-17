/**
 * The sidecar: one loopback HTTP server in front of a mandate runtime.
 *
 *   /health                      liveness
 *   /mandate/status              the mandate, halt state, spend and counters
 *   /mandate/ledger              the decision ledger's tail and chain check
 *   /mandate/heartbeat           the last signed heartbeat
 *   /mandate/kill                stop everything (no token: stopping is always allowed)
 *   /mandate/resume              clear `.pause` and `.kill` (control token)
 *   /mcp                         the MCP proxy
 *   /pay/<absolute-url>          the HTTP pay route
 *   /v1/*                        the OpenAI-compatible route, metered by agent-killswitch
 *   GET http://host/path         forward proxy (HTTP_PROXY) for http targets
 *
 * The server listens on loopback only. The agent it serves is on the same
 * host, so the one thing the agent must not be able to do through it is
 * lift its own halt: `/mandate/resume` needs the control token, which is
 * written to the state directory (mode 0600) for the operator.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { emitHeartbeat, lastHeartbeat } from "./heartbeat.js";
import { BodyTooLargeError, callRequestFromHttp, forwardProxyTarget, payRouteTarget, readRequestBody, writeCallResult, writeJson } from "./http-proxy.js";
import type { McpGateway } from "./mcp-proxy.js";
import type { MandateRuntime } from "./runtime.js";
import { mandateLimitsMicro } from "./schema.js";

export const DEFAULT_PORT = 4029;
export const DEFAULT_HOST = "127.0.0.1";
export const CONTROL_TOKEN_FILE = "control.token";
/** The tool name of the `/v1/*` route. */
export const INFERENCE_TOOL = "inference";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface InferenceMeter {
  /** Where the agent-killswitch proxy listens (loopback). */
  port: number;
  upstreamBaseUrl: string;
  close(): void;
}

export interface InferenceMeterOptions {
  runtime: MandateRuntime;
  expiresAtMs: number;
  /** The OpenAI-compatible upstream, such as https://api.openai.com/v1. */
  upstreamBaseUrl: string;
  /** Name of the environment variable that holds the upstream API key. */
  apiKeyEnv?: string;
  /** Models that cost nothing (a local model server). With these set, no API key is read. */
  freeModels?: string[];
  /** Per-model rates as JSON, in the form agent-killswitch's KILLSWITCH_MODEL_RATES takes. */
  modelRatesJson?: string;
  startTimeoutMs?: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, DEFAULT_HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start agent-killswitch as the meter for `/v1/*`. It is given the
 * mandate's caps and the same kill, pause and spend-ledger files as the
 * runtime, and nothing from the host environment but PATH and the one API
 * key it needs: agent-killswitch reads its limits from the environment
 * first, so each limit is set here and none is inherited.
 *
 * Budget holds are per process. A paid tool call in flight in the runtime
 * and an inference request in flight here do not see each other's holds, so
 * the two together can pass a window cap by at most what is in flight at
 * that moment. Settled spend is shared: both read the one ledger.
 */
export async function startInferenceMeter(options: InferenceMeterOptions): Promise<InferenceMeter> {
  const { runtime } = options;
  const limits = mandateLimitsMicro(runtime.mandate);
  const usd = (micro: bigint): string => (Number(micro) / 1_000_000).toString();
  const require = createRequire(import.meta.url);
  const entry = path.join(path.dirname(require.resolve("@twzrd1111/agent-killswitch/package.json")), "dist", "index.js");
  const configPath = path.join(runtime.stateDir, "inference-meter.json");
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const port = await freePort();
  const apiKeyEnv = options.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error("the API key variable name is not a valid environment variable name");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    KILLSWITCH_HOST: DEFAULT_HOST,
    KILLSWITCH_PORT: String(port),
    KILLSWITCH_KILL_API: "0",
    KILLSWITCH_UPSTREAM_BASE_URL: options.upstreamBaseUrl,
    KILLSWITCH_API_KEY_ENV: apiKeyEnv,
    KILLSWITCH_MAX_COST_REQUEST: usd(limits.perCall),
    KILLSWITCH_MAX_USD_HOUR: usd(limits.hourly),
    KILLSWITCH_MAX_USD_DAY: usd(limits.daily),
    KILLSWITCH_KILL_FILE: path.join(runtime.stateDir, ".kill"),
    KILLSWITCH_PAUSE_FILE: path.join(runtime.stateDir, ".pause"),
    KILLSWITCH_LEDGER_PATH: path.join(runtime.stateDir, "spend-ledger.jsonl"),
    TWZRD_STATE_DIR: runtime.stateDir,
  };
  if (options.freeModels?.length) env.KILLSWITCH_FREE_MODELS = options.freeModels.join(",");
  else if (process.env[apiKeyEnv] !== undefined) env[apiKeyEnv] = process.env[apiKeyEnv];
  if (options.modelRatesJson !== undefined) env.KILLSWITCH_MODEL_RATES = options.modelRatesJson;

  const child: ChildProcess = spawn(process.execPath, [entry, configPath], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString("utf8");
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + (options.startTimeoutMs ?? 10_000);
  for (;;) {
    if (exited) throw new Error(`the inference meter did not start: ${stderr.trim() || "agent-killswitch exited"}`);
    try {
      const resp = await fetch(`http://${DEFAULT_HOST}:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("the inference meter did not start in time");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // The meter does not know the mandate's expiry. Stop it when the mandate ends.
  const untilExpiry = options.expiresAtMs - Date.now();
  const timer = setTimeout(() => child.kill(), Math.max(0, Math.min(untilExpiry, 2_147_000_000)));
  timer.unref();
  return {
    port,
    upstreamBaseUrl: options.upstreamBaseUrl,
    close(): void {
      clearTimeout(timer);
      child.kill();
    },
  };
}

export interface SidecarOptions {
  runtime: MandateRuntime;
  version: string;
  host?: string;
  port?: number;
  mcp?: McpGateway;
  inference?: InferenceMeter;
  /** Sign a heartbeat this often. Needs the agent key. 0 or absent: only on request. */
  heartbeatSeconds?: number;
  /** Called with one line per request served. */
  log?: (line: string) => void;
}

export interface Sidecar {
  server: http.Server;
  url: string;
  port: number;
  controlToken: string;
  close(): Promise<void>;
}

function openAiError(res: http.ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { message, type: "twzrd_mandate_refused", code } });
}

/** Start the sidecar. Resolves once it is listening. */
export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const { runtime } = options;
  const host = options.host ?? DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`the sidecar listens on loopback only (127.0.0.1, ::1 or localhost), not ${host}`);
  }
  const controlToken = crypto.randomBytes(32).toString("hex");
  const tokenPath = path.join(runtime.stateDir, CONTROL_TOKEN_FILE);
  fs.writeFileSync(tokenPath, `${controlToken}\n`, { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  const log = options.log ?? (() => {});
  let listenPort = options.port ?? DEFAULT_PORT;

  const hasToken = (req: http.IncomingMessage): boolean => {
    const given = Buffer.from(req.headers.authorization ?? "", "utf8");
    const want = Buffer.from(`Bearer ${controlToken}`, "utf8");
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  /**
   * Keep web pages out. A page in the operator's browser can send requests
   * to a loopback port; it cannot choose the Host header, and the browser
   * marks what it sends.
   */
  const fromBrowserOrWrongHost = (req: http.IncomingMessage): string | null => {
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const allowed = [`127.0.0.1:${listenPort}`, `localhost:${listenPort}`, `[::1]:${listenPort}`];
    if (!allowed.includes(hostHeader)) return "host_not_allowed";
    if (req.headers.origin !== undefined) return "browser_origin_not_allowed";
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "none") return "browser_origin_not_allowed";
    return null;
  };

  async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const bytes = await readRequestBody(req, 64 * 1024);
    if (bytes.length === 0) return {};
    try {
      const doc: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  function forwardInference(req: http.IncomingMessage, res: http.ServerResponse, meter: InferenceMeter): void {
    const headers = { ...req.headers, host: `${DEFAULT_HOST}:${meter.port}` };
    const upstream = http.request({ host: DEFAULT_HOST, port: meter.port, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) openAiError(res, 503, "inference_meter_unavailable", "the inference meter is not running; nothing was forwarded");
      else res.destroy();
    });
    req.pipe(upstream);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const method = req.method ?? "GET";

    // Absolute-form request line: this is a forward-proxy request for an http target.
    const proxied = forwardProxyTarget(rawUrl);
    if (proxied !== null) {
      writeCallResult(res, await runtime.call(await callRequestFromHttp(req, proxied)));
      return;
    }
    if (!rawUrl.startsWith("/")) {
      writeJson(res, 400, { error: "bad_request" });
      return;
    }
    const blocked = fromBrowserOrWrongHost(req);
    if (blocked !== null) {
      writeJson(res, 403, { error: blocked, detail: "the mandate sidecar answers local, non-browser clients only" });
      return;
    }
    const url = new URL(rawUrl, `http://${DEFAULT_HOST}`);
    const route = url.pathname;

    if (route === "/health" && method === "GET") {
      const status = runtime.status();
      writeJson(res, 200, {
        ok: true,
        service: "twzrd-mandate",
        version: options.version,
        mandateId: status.mandate.mandateId,
        expired: status.mandate.expired,
        halted: status.halt.active,
      });
      return;
    }
    if (route === "/mandate/status" && method === "GET") {
      writeJson(res, 200, {
        ...runtime.status(),
        routes: { mcp: options.mcp !== undefined, inference: options.inference !== undefined, pay: true },
        heartbeat: lastHeartbeat(runtime.stateDir),
      });
      return;
    }
    if (route === "/mandate/ledger" && method === "GET") {
      const asked = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 1000) : 50;
      const report = runtime.ledger.verify();
      writeJson(res, 200, {
        schema: "twzrd.mandate.ledger.v1",
        path: runtime.ledger.filePath,
        lines: report.lines,
        head: report.head,
        chainVerified: report.ok,
        breaks: report.breaks,
        records: runtime.ledger.tail(limit),
      });
      return;
    }
    if (route === "/mandate/heartbeat") {
      if (method === "GET") {
        const last = lastHeartbeat(runtime.stateDir);
        if (last === null) writeJson(res, 404, { error: "no_heartbeat", detail: "this runtime has signed no heartbeat yet" });
        else writeJson(res, 200, last);
        return;
      }
      if (method === "POST") {
        if (!hasToken(req)) {
          writeJson(res, 401, { error: "control_token_required" });
          return;
        }
        if (!runtime.agentKey) {
          writeJson(res, 409, { error: "no_agent_key", detail: "start the sidecar with --agent-key to sign heartbeats" });
          return;
        }
        writeJson(res, 200, emitHeartbeat(runtime));
        return;
      }
    }
    if (route === "/mandate/kill" && method === "POST") {
      const body = await readJsonBody(req);
      runtime.kill(typeof body.reason === "string" ? body.reason : "control API");
      writeJson(res, 200, { killed: true, halt: runtime.status().halt });
      return;
    }
    if (route === "/mandate/resume" && method === "POST") {
      if (!hasToken(req)) {
        writeJson(res, 401, {
          error: "control_token_required",
          detail: `send "Authorization: Bearer <token>"; the token is in ${tokenPath}`,
        });
        return;
      }
      writeJson(res, 200, { ...runtime.resume(), halt: runtime.status().halt });
      return;
    }
    if (route === "/mcp") {
      if (!options.mcp) {
        writeJson(res, 503, { error: "mcp_not_configured", detail: "start the sidecar with --mcp-upstream <url>" });
        return;
      }
      await options.mcp.handleHttp(req, res);
      return;
    }
    if (rawUrl.startsWith("/pay/")) {
      const target = payRouteTarget(rawUrl);
      if (target === null) {
        writeJson(res, 400, { error: "bad_target", detail: "use /pay/<absolute http or https URL>" });
        return;
      }
      writeCallResult(res, await runtime.call(await callRequestFromHttp(req, target)));
      return;
    }
    if (route === "/v1" || route.startsWith("/v1/")) {
      const meter = options.inference;
      const refusal = runtime.admit(INFERENCE_TOOL, `${meter?.upstreamBaseUrl ?? "http://inference.mandate.invalid/v1"}${route.slice(3)}`);
      if (refusal !== null) {
        openAiError(res, 403, refusal.code, refusal.detail);
        return;
      }
      if (!meter) {
        openAiError(res, 503, "inference_not_configured", "start the sidecar with --upstream <OpenAI-compatible base URL>; nothing was forwarded");
        return;
      }
      forwardInference(req, res, meter);
      return;
    }
    writeJson(res, 404, {
      error: "not_found",
      routes: ["/health", "/mandate/status", "/mandate/ledger", "/mandate/heartbeat", "/mandate/kill", "/mandate/resume", "/mcp", "/pay/<url>", "/v1/*"],
    });
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => log(`${req.method} ${(req.url ?? "").split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`));
    handle(req, res).catch((err: Error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof BodyTooLargeError) writeJson(res, 413, { error: "request_too_large", detail: err.message });
      else writeJson(res, 500, { error: "sidecar_error", detail: err.message });
    });
  });
  // An https request through a forward proxy is a CONNECT tunnel the proxy cannot read, so cannot govern.
  server.on("connect", (req, socket) => {
    const target = req.url ?? "";
    let seq: number | null = null;
    try {
      seq = runtime.note(`http:${target.replace(/:443$/, "").toLowerCase()}`, `https://${target}`, "connect_not_supported", "an https tunnel cannot be inspected; use the /pay/ route").seq;
    } catch {
      seq = null;
    }
    const body = JSON.stringify({
      error: {
        type: "twzrd_mandate_refused",
        code: "connect_not_supported",
        detail: `the sidecar cannot govern an https tunnel; request http://127.0.0.1:${listenPort}/pay/https://${target.replace(/:443$/, "")}/... instead`,
        ledgerSeq: seq,
      },
    });
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address === "object" && address !== null) listenPort = address.port;

  let beat: NodeJS.Timeout | undefined;
  if (options.heartbeatSeconds && options.heartbeatSeconds > 0 && runtime.agentKey) {
    beat = setInterval(() => {
      try {
        emitHeartbeat(runtime);
      } catch (err) {
        log(`heartbeat failed: ${(err as Error).message}`);
      }
    }, options.heartbeatSeconds * 1000);
    beat.unref();
  }

  return {
    server,
    url: `http://${host === "::1" ? "[::1]" : host}:${listenPort}`,
    port: listenPort,
    controlToken,
    close(): Promise<void> {
      if (beat) clearInterval(beat);
      options.inference?.close();
      options.mcp?.close();
      return new Promise((resolve) => {
        server.close(() => {
          try {
            fs.unlinkSync(tokenPath);
          } catch {
            // already gone
          }
          runtime.close();
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
