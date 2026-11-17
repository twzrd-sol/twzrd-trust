/**
 * The MCP side of the sidecar: a proxy in front of any upstream MCP server
 * (Streamable HTTP, or a stdio server the sidecar starts) that sends every
 * `tools/call` through the mandate.
 *
 * Everything that is not a `tools/call` passes through unchanged, so the
 * agent sees the upstream's own tool list and session. A `tools/call` for
 * tool `X` is the mandate tool `mcp:X`. It is refused before it is sent
 * unless `mcp:X` is on the allow-list, and a payment it asks for goes
 * through the same pipeline as an HTTP 402, whichever way the upstream asks:
 *
 *   an HTTP 402 answer to the POST, or
 *   the x402 MCP transport: a tool result with `isError: true` that carries
 *   the PaymentRequired object, paid by resending the call with
 *   `_meta["x402/payment"]`, settled in `_meta["x402/payment-response"]`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type http from "node:http";
import readline from "node:readline";
import { Readable } from "node:stream";
import { strictBase64ToUtf8 } from "./challenge.js";
import { BodyTooLargeError, flatHeaders, readRequestBody, writeJson } from "./http-proxy.js";
import { type CallResult, type MandateRuntime, MAX_BODY_BYTES, type Refusal } from "./runtime.js";

export type JsonRpcMessage = Record<string, unknown>;

export const MCP_PAYMENT_META = "x402/payment";
export const MCP_PAYMENT_RESPONSE_META = "x402/payment-response";
/** The stand-in target URL of a stdio upstream, for the ledger. It is never fetched. */
export const STDIO_TARGET_URL = "http://stdio.mandate.invalid/mcp";
/** Client headers an MCP proxy forwards upstream. Everything else stays behind. */
const FORWARD_CLIENT_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "authorization", "last-event-id"];
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "upgrade", "trailer"]);

export interface McpUpstream {
  kind: "http" | "stdio";
  /** The URL a call is recorded against. */
  targetUrl: string;
  /** One HTTP-shaped exchange with the upstream: POST a JSON-RPC message, get its answer. */
  fetch: typeof fetch;
  /** Messages the upstream sends that answer no request (stdio upstreams only). */
  onMessage?: (message: JsonRpcMessage) => void;
  close(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An upstream MCP server reached over Streamable HTTP. `headers` are added to every request (an upstream API key, say). */
export function createHttpUpstream(url: string, opts: { fetch?: typeof fetch; headers?: Record<string, string> } = {}): McpUpstream {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("the MCP upstream must be an http or https URL");
  const inner: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    kind: "http",
    targetUrl: target.href,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(opts.headers ?? {})) headers.set(key, value);
      return inner(input, { ...init, headers });
    },
    close(): void {},
  };
}

/**
 * An upstream MCP server run as a child process speaking JSON-RPC over
 * stdio. Requests are matched to answers by id; the ids the child sees are
 * the proxy's own, so two clients cannot collide.
 */
export function createStdioUpstream(command: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): McpUpstream {
  const child: ChildProcess = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: opts.env ?? process.env });
  const pending = new Map<number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void; id: unknown; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let closed = false;
  let exitError: Error | null = null;
  const failAll = (err: Error): void => {
    exitError = err;
    for (const [key, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
      pending.delete(key);
    }
  };
  child.on("error", (err) => failAll(new Error(`the MCP server process could not be started: ${err.message}`)));
  child.on("exit", (code) => failAll(new Error(`the MCP server process exited (${code ?? "signal"})`)));
  const upstream: McpUpstream = {
    kind: "stdio",
    targetUrl: STDIO_TARGET_URL,
    fetch: async (_input, init) => {
      if (exitError) throw exitError;
      const text = typeof init?.body === "string" ? init.body : Buffer.from((init?.body ?? "") as Uint8Array).toString("utf8");
      const message = JSON.parse(text) as JsonRpcMessage;
      const stdin = child.stdin;
      if (!stdin || closed) throw new Error("the MCP server process is closed");
      if (message.id === undefined || message.id === null || typeof message.method !== "string") {
        // A notification, or the client's answer to a server request: nothing to wait for.
        stdin.write(`${JSON.stringify(message)}\n`);
        return new Response(null, { status: 202 });
      }
      const internal = nextId++;
      const answer = new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(internal);
          reject(new Error("the MCP server process did not answer in time"));
        }, opts.timeoutMs ?? 120_000);
        pending.set(internal, { resolve, reject, id: message.id, timer });
      });
      stdin.write(`${JSON.stringify({ ...message, id: internal })}\n`);
      const reply = await answer;
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    },
    close(): void {
      closed = true;
      child.kill();
    },
  };
  const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (!isObject(message)) return;
    const waiter = typeof message.id === "number" && message.method === undefined ? pending.get(message.id) : undefined;
    if (waiter) {
      pending.delete(message.id as number);
      clearTimeout(waiter.timer);
      waiter.resolve({ ...message, id: waiter.id });
      return;
    }
    upstream.onMessage?.(message);
  });
  return upstream;
}

/** The JSON-RPC answer in an upstream reply, from a JSON body or an SSE stream. */
export function readReply(headers: Headers, bytes: Uint8Array): { message: JsonRpcMessage; only: boolean } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/event-stream")) {
    const events: JsonRpcMessage[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(data);
        if (isObject(parsed)) events.push(parsed);
      } catch {
        // an event that is not JSON is not a JSON-RPC message
      }
    }
    const answer = events.find((e) => e.method === undefined && (e.result !== undefined || e.error !== undefined));
    return answer ? { message: answer, only: events.length === 1 } : null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? { message: parsed, only: true } : null;
  } catch {
    return null;
  }
}

/** The PaymentRequired object of a tool result that asks for payment (x402 MCP transport), or null. */
export function paymentRequiredOf(result: unknown): Record<string, unknown> | null {
  if (!isObject(result) || result.isError !== true) return null;
  const looksRight = (doc: unknown): doc is Record<string, unknown> => isObject(doc) && Array.isArray(doc.accepts) && doc.x402Version !== undefined;
  if (looksRight(result.structuredContent)) return result.structuredContent;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (isObject(first) && typeof first.text === "string") {
    try {
      const doc: unknown = JSON.parse(first.text);
      if (looksRight(doc)) return doc;
    } catch {
      // an ordinary tool error
    }
  }
  return null;
}

/**
 * Carry the x402 MCP transport over the HTTP 402 exchange the mandate
 * pipeline speaks: a payment-required tool result becomes a 402, a payment
 * header becomes `_meta["x402/payment"]`, and the settlement in
 * `_meta["x402/payment-response"]` becomes a `PAYMENT-RESPONSE` header.
 */
export function x402McpTransport(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    let body = await request.text();
    const payment = headers.get("payment-signature") ?? headers.get("x-payment");
    if (payment !== null) {
      const decoded = strictBase64ToUtf8(payment);
      let payload: unknown;
      let message: unknown;
      try {
        payload = decoded === null ? undefined : JSON.parse(decoded);
        message = JSON.parse(body);
      } catch {
        payload = undefined;
      }
      if (!isObject(payload) || !isObject(message)) throw new Error("the payment could not be carried in an MCP request");
      const params = isObject(message.params) ? message.params : {};
      const meta = isObject(params._meta) ? params._meta : {};
      body = JSON.stringify({ ...message, params: { ...params, _meta: { ...meta, [MCP_PAYMENT_META]: payload } } });
      headers.delete("payment-signature");
      headers.delete("x-payment");
    }
    const resp = await inner(request.url, { method: request.method, headers, body, redirect: "manual", signal: request.signal });
    if (!resp.ok) return resp;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new Error("the MCP answer is too large");
    const out = new Headers(resp.headers);
    out.delete("content-length");
    out.delete("content-encoding");
    const reply = readReply(resp.headers, bytes);
    if (reply === null) return new Response(bytes, { status: resp.status, headers: out });
    const result = reply.message.result;
    const required = paymentRequiredOf(result);
    if (required !== null) {
      const json = JSON.stringify(required);
      const challenge = new Headers({ "content-type": "application/json" });
      // x402 v2 payers read the challenge from the header; v1 payers read the body.
      if (typeof required.x402Version === "number" && required.x402Version >= 2) {
        challenge.set("payment-required", Buffer.from(json, "utf8").toString("base64"));
      }
      return new Response(json, { status: 402, headers: challenge });
    }
    const settled = isObject(result) && isObject(result._meta) ? result._meta[MCP_PAYMENT_RESPONSE_META] : undefined;
    if (isObject(settled)) out.set("payment-response", Buffer.from(JSON.stringify(settled), "utf8").toString("base64"));
    if (reply.only) {
      // One answer and nothing else in the stream: hand it on as plain JSON so the receipt in it can be read.
      out.set("content-type", "application/json");
      return new Response(JSON.stringify(reply.message), { status: resp.status, headers: out });
    }
    return new Response(bytes, { status: resp.status, headers: out });
  };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** A mandate refusal as a tool result: the form an agent's model reads and can act on. */
export function refusalToolResult(id: unknown, result: CallResult): JsonRpcMessage {
  const code = result.record.code ?? "refused";
  const paid = result.signatures > 0;
  const head =
    result.outcome === "refused"
      ? `TWZRD mandate refused this tool call before any payment was signed (${code}).`
      : result.outcome === "violation"
        ? `TWZRD mandate stopped this tool call after a payment was sent (${code}); spending is paused.`
        : `TWZRD mandate could not complete this tool call (${code}).`;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      isError: true,
      content: [{ type: "text", text: `${head} ${result.record.detail ?? ""}`.trim() }],
      structuredContent: {
        twzrd_mandate: {
          outcome: result.outcome,
          layer: result.refusal?.layer ?? null,
          code,
          detail: result.record.detail,
          signatures: result.signatures,
          paid,
          quotedUsd: result.quotedUsd,
          settledUsd: result.settledUsd,
          ledgerSeq: result.record.seq,
          mandateId: result.record.mandateId,
        },
      },
    },
  };
}

function haltError(id: unknown, refusal: Refusal): JsonRpcMessage {
  return rpcError(id, -32001, `TWZRD mandate: ${refusal.code}. ${refusal.detail}`, { twzrd_mandate: refusal });
}

export interface McpGateway {
  /** Serve one HTTP request to the proxy's `/mcp` endpoint. */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  /** Handle one client message (stdio wrapper). Resolves to the answer, or null when there is none. */
  handleMessage(message: JsonRpcMessage): Promise<JsonRpcMessage | null>;
  close(): void;
}

/**
 * Build the proxy. With `runtime` null it is a plain bridge: nothing is
 * checked here, because the upstream is itself a mandate sidecar.
 */
export function createMcpGateway(runtime: MandateRuntime | null, upstream: McpUpstream): McpGateway {
  const transport = x402McpTransport(upstream.fetch);
  // The stdio wrapper is one client with one session.
  const session: Record<string, string> = {};

  async function callTool(message: JsonRpcMessage, headers: Record<string, string>, body: Uint8Array): Promise<CallResult | JsonRpcMessage> {
    const params = isObject(message.params) ? message.params : {};
    if (typeof params.name !== "string" || params.name.length === 0) return rpcError(message.id, -32602, "tools/call needs params.name");
    if (isObject(params._meta) && params._meta[MCP_PAYMENT_META] !== undefined) {
      // The sidecar is the payer. An agent cannot hand it a payment to forward.
      return rpcError(message.id, -32602, "a tools/call through the mandate proxy must not carry its own payment");
    }
    return (runtime as MandateRuntime).call({
      tool: `mcp:${params.name}`,
      url: upstream.targetUrl,
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: headers.accept ?? "application/json, text/event-stream" },
      body,
      transport,
    });
  }

  function forwardHeaders(all: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of FORWARD_CLIENT_HEADERS) {
      const value = all[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  async function passThrough(req: http.IncomingMessage, res: http.ServerResponse, body: Uint8Array | null): Promise<void> {
    const headers = forwardHeaders(flatHeaders(req));
    let resp: Response;
    try {
      resp = await upstream.fetch(upstream.targetUrl, {
        method: req.method ?? "POST",
        headers,
        ...(body !== null ? { body: Buffer.from(body) } : {}),
        redirect: "manual",
      });
    } catch (err) {
      writeJson(res, 502, rpcError(null, -32002, `the MCP upstream could not be reached: ${(err as Error).message}`));
      return;
    }
    const out: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      if (!DROP_RESPONSE_HEADERS.has(key)) out[key] = value;
    });
    res.writeHead(resp.status, out);
    if (resp.body === null) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(resp.body as never);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "POST") {
      const halted = runtime?.precheck() ?? null;
      if (halted) {
        writeJson(res, 403, haltError(null, halted));
        return;
      }
      if (upstream.kind === "stdio") {
        // A stdio upstream offers no server-initiated stream and has no session to end.
        if (method === "DELETE") writeJson(res, 200, {});
        else writeJson(res, 405, rpcError(null, -32000, "this MCP proxy offers no server-sent stream"), { allow: "POST, DELETE" });
        return;
      }
      await passThrough(req, res, null);
      return;
    }
    let body: Uint8Array;
    try {
      body = await readRequestBody(req);
    } catch (err) {
      writeJson(res, err instanceof BodyTooLargeError ? 413 : 400, rpcError(null, -32700, (err as Error).message));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      writeJson(res, 400, rpcError(null, -32700, "the request body is not JSON"));
      return;
    }
    if (runtime !== null) {
      if (Array.isArray(message)) {
        if (message.some((m) => isObject(m) && m.method === "tools/call")) {
          const answers = message
            .filter((m): m is JsonRpcMessage => isObject(m) && m.id !== undefined)
            .map((m) => rpcError(m.id, -32600, "a tools/call cannot be sent in a batch through the mandate proxy"));
          writeJson(res, 200, answers);
          return;
        }
      } else if (isObject(message) && message.method === "tools/call") {
        const result = await callTool(message, forwardHeaders(flatHeaders(req)), body);
        if (!("outcome" in result)) {
          writeJson(res, 200, result);
          return;
        }
        const call = result as CallResult;
        if (call.delivered) {
          const out: Record<string, string> = {};
          call.headers.forEach((value, key) => {
            out[key] = value;
          });
          out["content-length"] = String(call.body.length);
          res.writeHead(call.status, out);
          res.end(Buffer.from(call.body));
          return;
        }
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        writeJson(res, 200, refusalToolResult(message.id, call), {
          "x-twzrd-mandate": call.outcome,
          "x-twzrd-mandate-seq": String(call.record.seq),
          ...(call.record.code ? { "x-twzrd-mandate-code": call.record.code } : {}),
        });
        return;
      }
      const halted = runtime.precheck();
      if (halted) {
        const id = isObject(message) ? message.id : null;
        if (isObject(message) && message.id === undefined) res.writeHead(202).end();
        else writeJson(res, 200, haltError(id, halted));
        return;
      }
    }
    await passThrough(req, res, body);
  }

  async function handleMessage(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const body = new TextEncoder().encode(JSON.stringify(message));
    const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json", ...session };
    const answered = message.id !== undefined && message.id !== null && typeof message.method === "string";
    let resp: { headers: Headers; body: Uint8Array; ok: boolean; status: number };
    if (runtime !== null && message.method === "tools/call") {
      const result = await callTool(message, headers, body);
      if (!("outcome" in result)) return answered ? result : null;
      const call = result as CallResult;
      if (!call.delivered) return answered ? refusalToolResult(message.id, call) : null;
      resp = { headers: call.headers, body: call.body, ok: call.status >= 200 && call.status < 300, status: call.status };
    } else {
      const halted = runtime?.precheck() ?? null;
      if (halted) return answered ? haltError(message.id, halted) : null;
      try {
        const raw = await upstream.fetch(upstream.targetUrl, { method: "POST", headers, body: Buffer.from(body), redirect: "manual" });
        resp = { headers: raw.headers, body: new Uint8Array(await raw.arrayBuffer()), ok: raw.ok, status: raw.status };
      } catch (err) {
        return answered ? rpcError(message.id, -32002, `the MCP upstream could not be reached: ${(err as Error).message}`) : null;
      }
    }
    const sessionId = resp.headers.get("mcp-session-id");
    if (sessionId !== null) session["mcp-session-id"] = sessionId;
    if (message.method === "initialize" && resp.ok) {
      const reply = readReply(resp.headers, resp.body);
      const version = reply && isObject(reply.message.result) ? reply.message.result.protocolVersion : undefined;
      if (typeof version === "string") session["mcp-protocol-version"] = version;
    }
    if (!answered) return null;
    const reply = readReply(resp.headers, resp.body);
    if (reply !== null && (reply.message.result !== undefined || reply.message.error !== undefined)) return { ...reply.message, id: message.id };
    return rpcError(message.id, -32002, `the MCP upstream answered ${resp.status} without a JSON-RPC message`);
  }

  return {
    handleHttp,
    handleMessage,
    close(): void {
      upstream.close();
    },
  };
}

/**
 * Run the proxy as a stdio MCP server: one JSON-RPC message per line on
 * stdin, answers on stdout. Resolves when stdin closes.
 */
export function runMcpStdio(gateway: McpGateway, io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): Promise<void> {
  return new Promise((resolve) => {
    const lines = readline.createInterface({ input: io.input });
    let inFlight = 0;
    let ended = false;
    const maybeDone = (): void => {
      if (ended && inFlight === 0) resolve();
    };
    const write = (message: JsonRpcMessage): void => {
      io.output.write(`${JSON.stringify(message)}\n`);
    };
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, "not JSON"));
        return;
      }
      if (!isObject(message)) {
        write(rpcError(null, -32600, "a message must be one JSON-RPC object"));
        return;
      }
      inFlight += 1;
      gateway
        .handleMessage(message)
        .then((answer) => {
          if (answer !== null) write(answer);
        })
        .catch((err: Error) => {
          if ((message as JsonRpcMessage).id !== undefined) write(rpcError((message as JsonRpcMessage).id, -32603, err.message));
        })
        .finally(() => {
          inFlight -= 1;
          maybeDone();
        });
    });
    lines.on("close", () => {
      ended = true;
      maybeDone();
    });
  });
}
