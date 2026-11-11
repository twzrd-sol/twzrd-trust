// Offline tests: a stub upstream on 127.0.0.1:0 stands in for OpenAI.
// No API key, no network, no spend. Run with `npm test` (builds dist first).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../dist/index.js";
import { costUsd, pessimisticRequestCostUsd, parseModelRates } from "../dist/pricing.js";
import { clientResponseHeaders, outboundBodyText, upstreamRequestHeaders } from "../dist/proxy.js";

const ORIGINAL_CWD = process.cwd();

function hasPaymentProof(headers) {
  const auth = headers.authorization;
  return Boolean(
    headers["x-payment"] ||
      headers["payment-signature"] ||
      headers["x-payment-signature"] ||
      (typeof auth === "string" && auth.trim().toLowerCase().startsWith("payment ")),
  );
}

function writeOkJson(res, extra = {}) {
  res.writeHead(200, { "content-type": "application/json", ...extra });
  res.end(
    JSON.stringify({
      id: "chatcmpl-stub",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    }),
  );
}

/** Stub OpenAI upstream. `mode` picks the behaviour per test. */
function startUpstream() {
  const state = { hits: 0, bodies: [], auths: [], mode: "ok", delayMs: 0, extraHeaders: {}, requestHeaders: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.hits++;
      state.requestHeaders.push({ ...req.headers });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.bodies.push(body);
      state.auths.push(req.headers.authorization ?? "");
      const send = () => {
        const extra = state.extraHeaders;
        if (state.mode === "402") {
          res.writeHead(402, { "content-type": "application/json", ...extra });
          res.end(JSON.stringify({ error: { message: "Payment required" } }));
          return;
        }
        if (state.mode === "402-until-paid") {
          if (!hasPaymentProof(req.headers)) {
            res.writeHead(402, { "content-type": "application/json", ...extra });
            res.end(JSON.stringify({ error: { message: "Payment required" } }));
            return;
          }
          writeOkJson(res);
          return;
        }
        if (state.mode === "stream") {
          res.writeHead(200, { "content-type": "text/event-stream", ...extra });
          res.write('data: ' + JSON.stringify({ model: state.servedModel ?? 'gpt-4o-mini', choices: [{delta: {content: 'hi'}}] }) + '\n\n');
          res.write(
            'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":1000,"total_tokens":3000}}\n\n',
          );
          res.end("data: [DONE]\n\n");
          return;
        }
        if (state.mode === "nousage") {
          res.writeHead(200, { "content-type": "application/json", ...extra });
          res.end(JSON.stringify({ id: "chatcmpl-stub", choices: [{ message: { role: "assistant", content: "hi" } }] }));
          return;
        }
        if (state.mode === "stream-nousage") {
          res.writeHead(200, { "content-type": "text/event-stream", ...extra });
          res.write('data: ' + JSON.stringify({ model: state.servedModel ?? 'gpt-4o-mini', choices: [{delta: {content: 'hi'}}] }) + '\n\n');
          res.end("data: [DONE]\n\n");
          return;
        }
        const headers = { "content-type": "application/json", ...extra };
        if (state.mode === "free") headers["x-free-model"] = "true";
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            id: "chatcmpl-stub",
            model: state.servedModel ?? (state.mode === "free" ? "nvidia/nemotron-3.5-bolt" : "gpt-4o-mini"),
            choices: [{ message: { role: "assistant", content: "hi" } }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
          }),
        );
      };
      if (state.delayMs > 0) setTimeout(send, state.delayMs);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function chat(port, body, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE or empty */
  }
  return { status: res.status, text, json, headers: res.headers };
}

/**
 * Bytes the proxy counts for `body` from chat(): one prompt token per byte of
 * the text it forwards, which for a stream includes the injected
 * `stream_options.include_usage`.
 */
function bodyBytes(body) {
  return Math.max(Buffer.byteLength(JSON.stringify(body)), Buffer.byteLength(outboundBodyText(body)));
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  return res.json();
}

function readLedger(dir) {
  const file = path.join(dir, "data", "spend-ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let dir;
let upstream;
let servers;

beforeEach(async () => {
  // A fresh working directory per test, with no config.yaml in it, so every
  // path (kill file, ledger) takes its built-in default relative to cwd,
  // the same way it resolves against WORKDIR /app in the Docker image.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-test-"));
  process.chdir(dir);
  for (const k of Object.keys(process.env)) if (k.startsWith("KILLSWITCH_")) delete process.env[k];
  upstream = await startUpstream();
  process.env.OPENAI_API_KEY = "sk-test-offline";
  process.env.KILLSWITCH_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstream.port}/v1`;
  servers = [];
});

afterEach(async () => {
  for (const s of servers) await close(s);
  await close(upstream.server);
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startKillswitch() {
  const server = createServer();
  servers.push(server);
  return listen(server);
}

test("default kill file ./data/.kill vetoes with 403 and never reaches upstream", async () => {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", ".kill"), "");
  const port = await startKillswitch();

  const r = await chat(port, { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.type, "killswitch_veto");
  assert.equal(r.json.error.code, "kill_switch");
  assert.equal(upstream.state.hits, 0);
  assert.equal((await health(port)).killed, true);

  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].allowed, false);
  assert.equal(lines[0].veto_reason, "kill_switch");
  assert.equal(lines[0].cost_usd, 0);
});

test("a .kill in the working directory root no longer engages the default switch", async () => {
  // 0.1.0 and 0.1.1 defaulted to ./.kill, which in Docker sat outside the
  // mounted data/ volume. The default now lives under data/.
  fs.writeFileSync(path.join(dir, ".kill"), "");
  const port = await startKillswitch();
  assert.equal((await health(port)).killed, false);
});

test("POST /kill then POST /reset toggles the default kill file", async () => {
  const port = await startKillswitch();
  const kill = await fetch(`http://127.0.0.1:${port}/kill`, { method: "POST" });
  assert.equal(kill.status, 200);
  assert.ok(fs.existsSync(path.join(dir, "data", ".kill")));
  const vetoed = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(vetoed.status, 403);

  const reset = await fetch(`http://127.0.0.1:${port}/reset`, { method: "POST" });
  assert.equal(reset.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, "data", ".kill")));
  const allowed = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(allowed.status, 200);
  assert.equal(upstream.state.hits, 1);
});

test("replayed ledger over the hourly limit vetoes with 429 and never reaches upstream", async () => {
  const now = Date.now();
  const seed = [
    // Counted: allowed spend 10 minutes ago, over the $5.00 default hourly limit.
    { timestamp: new Date(now - 10 * 60_000).toISOString(), model: "gpt-4o", prompt_tokens: 0,
      completion_tokens: 0, total_tokens: 0, cost_usd: 6.0, allowed: true, veto_reason: null, request_id: "a" },
  ];
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "spend-ledger.jsonl"),
    seed.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const port = await startKillswitch();

  const h = await health(port);
  assert.equal(h.hour_usd, 6.0);
  const r = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "budget_exceeded");
  assert.equal(upstream.state.hits, 0);
});

test("a Payment credential does not skip an already-spent hourly cap", async () => {
  const now = Date.now();
  const seed = [
    { timestamp: new Date(now - 10 * 60_000).toISOString(), model: "gpt-4o", prompt_tokens: 0,
      completion_tokens: 0, total_tokens: 0, cost_usd: 6.0, allowed: true, veto_reason: null, request_id: "a" },
  ];
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "spend-ledger.jsonl"), seed.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const port = await startKillswitch();
  const r = await chat(
    port,
    { model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    { authorization: "Payment cred-abc", "x-payment": "pay-payload" },
  );
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "budget_exceeded");
  assert.equal(upstream.state.hits, 0);
});

test("an empty free-model key sends no Authorization header", () => {
  const headers = upstreamRequestHeaders("", "req-1", {});
  assert.equal(headers.authorization, undefined);
});

test("replay ignores vetoed lines, lines older than 48 h and torn lines", async () => {
  const now = Date.now();
  const lines = [
    JSON.stringify({ timestamp: new Date(now - 49 * 3600_000).toISOString(), model: "gpt-4o",
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 50, allowed: true,
      veto_reason: null, request_id: "old" }),
    JSON.stringify({ timestamp: new Date(now - 5 * 60_000).toISOString(), model: "gpt-4o",
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 50, allowed: false,
      veto_reason: "budget_exceeded", request_id: "vetoed" }),
    '{"timestamp": "torn',
  ];
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "spend-ledger.jsonl"), lines.join("\n") + "\n");
  const port = await startKillswitch();

  const h = await health(port);
  assert.equal(h.hour_usd, 0);
  assert.equal(h.day_usd, 0);
  const r = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(r.status, 200);
  assert.equal(upstream.state.hits, 1);
});

test("an allowed request is ledgered at the table price and survives a restart", async () => {
  const port = await startKillswitch();
  const r = await chat(port, { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, "chatcmpl-stub");
  assert.equal(upstream.state.hits, 1);

  // gpt-4o-mini: $0.15 / $0.60 per 1M tokens; 1000 in + 500 out = $0.00045.
  const expected = (1000 * 0.15 + 500 * 0.6) / 1_000_000;
  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].allowed, true);
  assert.equal(lines[0].total_tokens, 1500);
  assert.ok(Math.abs(lines[0].cost_usd - expected) < 1e-12, `cost_usd ${lines[0].cost_usd}`);

  // Restart: a new server replays the ledger and reports the same window.
  await close(servers.pop());
  const port2 = await startKillswitch();
  const h = await health(port2);
  assert.ok(Math.abs(h.hour_usd - expected) < 1e-12, `hour_usd ${h.hour_usd}`);
  assert.ok(Math.abs(h.day_usd - expected) < 1e-12, `day_usd ${h.day_usd}`);
});

test("upstream HTTP 402 WWW-Authenticate challenge is forwarded to the client", async () => {
  const challenge =
    'Payment id="chal-test" method="tempo" intent="charge" request="dGVzdA"';
  upstream.state.mode = "402";
  upstream.state.extraHeaders = {
    "WWW-Authenticate": challenge,
    "Set-Cookie": "session=should-not-leak",
    Authorization: "Bearer should-not-leak",
  };
  const port = await startKillswitch();

  const r = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(r.status, 402);
  assert.equal(r.headers.get("www-authenticate"), challenge);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(r.headers.get("authorization"), null);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);

  const streamed = await chat(port, {
    model: "gpt-4o-mini",
    stream: true,
    messages: [],
  });
  assert.equal(streamed.status, 402);
  assert.equal(streamed.headers.get("www-authenticate"), challenge);
  assert.equal(streamed.headers.get("set-cookie"), null);
  assert.equal(upstream.state.hits, 2);
  assert.deepEqual(readLedger(dir), []);
});

test("402 challenge reflects and retry payment headers reach upstream", async () => {
  const challenge =
    'Payment id="chal-test" method="tempo" intent="charge" request="dGVzdA"';
  const paymentRequired = 'Payment id="chal-test" method="tempo"';
  upstream.state.mode = "402-until-paid";
  upstream.state.extraHeaders = {
    "WWW-Authenticate": challenge,
    "PAYMENT-REQUIRED": paymentRequired,
  };
  const port = await startKillswitch();

  const first = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(first.status, 402);
  assert.equal(first.headers.get("www-authenticate"), challenge);
  assert.equal(first.headers.get("payment-required"), paymentRequired);
  assert.equal(upstream.state.requestHeaders[0].authorization, "Bearer sk-test-offline");
  assert.equal(upstream.state.requestHeaders[0]["x-payment"], undefined);

  const retry = await chat(
    port,
    { model: "gpt-4o-mini", messages: [] },
    {
      "x-payment": "pay-payload",
      "payment-signature": "sig-1",
      "x-payment-signature": "sig-2",
      authorization: "Payment cred-abc",
    },
  );
  assert.equal(retry.status, 200);
  assert.equal(upstream.state.hits, 2);
  const paid = upstream.state.requestHeaders[1];
  assert.equal(paid["x-payment"], "pay-payload");
  assert.equal(paid["payment-signature"], "sig-1");
  assert.equal(paid["x-payment-signature"], "sig-2");
  assert.equal(paid.authorization, "Payment cred-abc");
});

test("Payment-Receipt and X-Payment-* survive on 200 non-stream and stream", async () => {
  const receipt = "receipt-from-upstream";
  const xPay = "x-payment-response-value";
  upstream.state.extraHeaders = {
    "Payment-Receipt": receipt,
    "X-Payment-Response": xPay,
    "Set-Cookie": "session=should-not-leak",
    Authorization: "Bearer should-not-leak",
  };
  const port = await startKillswitch();

  const r = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("payment-receipt"), receipt);
  assert.equal(r.headers.get("x-payment-response"), xPay);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal(r.headers.get("authorization"), null);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);

  upstream.state.mode = "stream";
  const s = await chat(port, { model: "gpt-4o-mini", stream: true, messages: [] });
  assert.equal(s.status, 200);
  assert.match(s.text, /data: \[DONE\]/);
  assert.equal(s.headers.get("payment-receipt"), receipt);
  assert.equal(s.headers.get("x-payment-response"), xPay);
  assert.equal(s.headers.get("set-cookie"), null);
  assert.match(s.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(s.headers.get("cache-control"), "no-cache");

  const lines = readLedger(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].allowed, true);
  assert.equal(lines[1].allowed, true);
  assert.equal(lines[0].total_tokens, 1500);
  assert.equal(lines[1].total_tokens, 3000);
});

test("a stream is forwarded, include_usage is injected, and the terminal usage is ledgered", async () => {
  upstream.state.mode = "stream";
  const port = await startKillswitch();
  const r = await chat(port, { model: "gpt-4o-mini", stream: true, messages: [] });
  assert.equal(r.status, 200);
  assert.match(r.text, /data: \[DONE\]/);
  assert.equal(upstream.state.bodies[0].stream_options.include_usage, true);

  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].total_tokens, 3000);
  const expected = (2000 * 0.15 + 1000 * 0.6) / 1_000_000;
  assert.ok(Math.abs(lines[0].cost_usd - expected) < 1e-12, `cost_usd ${lines[0].cost_usd}`);
});

test("upstream slower than timeout_ms returns 504 upstream_timeout and keeps the held estimate", async () => {
  process.env.KILLSWITCH_UPSTREAM_TIMEOUT_MS = "150";
  upstream.state.delayMs = 2000;
  const port = await startKillswitch();
  const started = Date.now();
  const body = { model: "gpt-4o-mini", messages: [] };
  const r = await chat(port, body);
  assert.equal(r.status, 504);
  assert.equal(r.json.error.type, "killswitch_error");
  assert.equal(r.json.error.code, "upstream_timeout");
  assert.ok(Date.now() - started < 1500, "returned well before the upstream answered");
  assert.equal(upstream.state.hits, 1);
  // No max_tokens: the hold is the per-request cap ($0.50 default) and the
  // prompt-token bound, one token per request byte.
  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].allowed, true);
  assert.equal(lines[0].metered, "held_estimate");
  assert.equal(lines[0].cost_usd, 0.5);
  assert.equal(lines[0].total_tokens, bodyBytes(body));
  const h = await health(port);
  assert.equal(h.hour_usd, 0.5);
  assert.equal(h.in_flight, 0);
});

test("the pinned free model costs zero and an unknown model stays at the o1 rate", () => {
  assert.equal(costUsd("nvidia/nemotron-3.5-bolt", 1_000_000, 1_000_000), 0);
  assert.equal(pessimisticRequestCostUsd("nvidia/nemotron-3.5-bolt", 256), 0);
  assert.equal(pessimisticRequestCostUsd("not-a-real-model", 1), 60 / 1_000_000);
});

test("a model on the free allowlist with no price row costs zero; a priced model keeps its price", () => {
  const free = ["local-model", "gpt-4o"];
  assert.equal(costUsd("local-model", 1_000_000, 1_000_000, free), 0);
  assert.equal(pessimisticRequestCostUsd("local-model", 4096, free), 0);
  // Listing a priced model as free does not zero it.
  assert.equal(costUsd("gpt-4o", 1_000_000, 1_000_000, free), 12.5);
  assert.equal(pessimisticRequestCostUsd("gpt-4o", 1_000_000, free), 10);
  // Not on the list: still the o1 fallback, with or without a list.
  assert.equal(costUsd("other-model", 1_000_000, 1_000_000, free), 75);
  assert.equal(costUsd("local-model", 1_000_000, 1_000_000), 75);
  assert.equal(costUsd("local-model", 1_000_000, 1_000_000, []), 75);
  // A dated or suffixed id of a priced model is not free either.
  assert.equal(costUsd("gpt-4o-2024-11-20", 1_000_000, 1_000_000, ["gpt-4o-2024-11-20"]), 75);
  assert.equal(costUsd("o1:preview", 1_000_000, 1_000_000, ["o1:preview"]), 75);
  // A name that only shares letters with a priced id is still free.
  assert.equal(costUsd("o1x-local", 1_000_000, 1_000_000, ["o1x-local"]), 0);
});

test("a paid call in keyless mode keeps the fail-closed price and the dollar limit", async () => {
  delete process.env.OPENAI_API_KEY;
  process.env.KILLSWITCH_FREE_MODELS = "seller/paid-model";
  process.env.KILLSWITCH_MAX_USD_HOUR = "0.05";
  upstream.state.mode = "402-until-paid";
  const port = await startKillswitch();
  const body = { model: "seller/paid-model", max_tokens: 256, messages: [{ role: "user", content: "hi" }] };
  const paidHeaders = { "x-payment": "pay-payload", authorization: "Payment cred-abc" };

  // Unpaid: the seller answers 402, nothing is billed.
  const challenge = await chat(port, body);
  assert.equal(challenge.status, 402);
  assert.equal((await health(port)).hour_usd, 0);

  // Paid: 1000 prompt + 500 completion tokens at the o1 fallback = $0.045.
  const paid = await chat(port, body, paidHeaders);
  assert.equal(paid.status, 200);
  const lines = readLedger(dir);
  assert.equal(lines.at(-1).cost_usd, 0.045);
  assert.equal((await health(port)).hour_usd, 0.045);

  // The next paid call would cross $0.05/hour and never reaches the seller.
  const hitsBefore = upstream.state.hits;
  const capped = await chat(port, body, paidHeaders);
  assert.equal(capped.status, 429);
  assert.equal(capped.json.error.code, "budget_exceeded");
  assert.equal(upstream.state.hits, hitsBefore);

  // Each payment header on its own counts as a credential.
  for (const h of [{ "payment-signature": "s" }, { "x-payment-signature": "s" }, { authorization: "Payment c" }]) {
    const r = await chat(port, body, h);
    assert.equal(r.status, 429, JSON.stringify(h));
  }
});

test("an allowlisted local model meters $0 with default limits, and the token limit still vetoes", async () => {
  delete process.env.OPENAI_API_KEY;
  process.env.KILLSWITCH_FREE_MODELS = "local-model";
  process.env.KILLSWITCH_MAX_TOKENS_MINUTE = "2000";
  const port = await startKillswitch();

  // No max_tokens: before this change the call held the $0.50 per-request cap
  // and its 1500 tokens were then billed at the o1 fallback rate.
  const ok = await chat(port, { model: "local-model", messages: [{ role: "user", content: "hi" }] });
  assert.equal(ok.status, 200);
  assert.equal(upstream.state.auths[0], "");
  let lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].cost_usd, 0);
  assert.equal(lines[0].total_tokens, 1500);
  assert.equal(lines[0].metered, "usage");
  const h = await health(port);
  assert.equal(h.hour_usd, 0);
  assert.equal(h.day_usd, 0);

  // 1500 tokens are in the minute window; 1000 more would cross 2000.
  const capped = await chat(port, { model: "local-model", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] });
  assert.equal(capped.status, 429);
  assert.equal(capped.json.error.code, "budget_exceeded");
  assert.equal(upstream.state.hits, 1);
});

test("default mode still sends the configured bearer", async () => {
  const port = await startKillswitch();
  const r = await chat(port, { model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  assert.equal(upstream.state.auths[0], "Bearer sk-test-offline");
});

test("free allowlist forwards only that model and sends no upstream key", async () => {
  delete process.env.OPENAI_API_KEY;
  process.env.BLOCKRUN_API = "must-not-be-sent";
  process.env.KILLSWITCH_FREE_MODELS = "nvidia/nemotron-3.5-bolt";
  process.env.KILLSWITCH_MAX_COST_REQUEST = "0";
  upstream.state.mode = "free";
  const port = await startKillswitch();

  const blocked = await chat(port, { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, "model_not_allowed");
  assert.equal(upstream.state.hits, 0);

  const ok = await chat(port, {
    model: "nvidia/nemotron-3.5-bolt",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-free-model"), "true");
  assert.equal(ok.json.model, "nvidia/nemotron-3.5-bolt");
  assert.equal(upstream.state.hits, 1);
  assert.equal(upstream.state.auths[0], "");
  assert.equal(upstream.state.bodies[0].model, "nvidia/nemotron-3.5-bolt");
  const lines = readLedger(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].veto_reason, "model_not_allowed");
  assert.equal(lines[1].cost_usd, 0);
  delete process.env.BLOCKRUN_API;
});

test("missing API key still refuses to start when no free allowlist is set", () => {
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => createServer(), /Upstream API key missing/);
});

test("unreachable upstream returns 502 upstream_unreachable", async () => {
  const spare = http.createServer();
  const deadPort = await listen(spare);
  await close(spare);
  process.env.KILLSWITCH_UPSTREAM_BASE_URL = `http://127.0.0.1:${deadPort}/v1`;
  const port = await startKillswitch();
  const r = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "upstream_unreachable");
  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].metered, "held_estimate");
  assert.equal(lines[0].cost_usd, 0.5);
});

test("clientResponseHeaders copies payment headers and strips hop-by-hop and secrets", () => {
  const upstream = new Headers();
  upstream.set("WWW-Authenticate", 'Payment id="chal"');
  upstream.set("Payment-Receipt", "receipt-abc");
  upstream.set("PAYMENT-REQUIRED", 'Payment id="chal"');
  upstream.set("PAYMENT-RESPONSE", "settle-abc");
  upstream.set("X-Payment-Required", "also-required");
  upstream.set("X-Payment-Response", "pay-resp");
  upstream.set("X-Payment-Id", "pay-id");
  upstream.set("Content-Type", "text/plain");
  upstream.set("Authorization", "Bearer leaked");
  upstream.set("Connection", "close");
  upstream.set("Keep-Alive", "timeout=5");
  upstream.set("Transfer-Encoding", "chunked");
  upstream.set("Proxy-Authenticate", "Basic");
  upstream.append("Set-Cookie", "session=should-not-leak");
  const out = clientResponseHeaders(upstream, {
    "content-type": "application/json",
    "cache-control": "no-cache",
  });
  assert.equal(out["WWW-Authenticate"], 'Payment id="chal"');
  assert.equal(out["Payment-Receipt"], "receipt-abc");
  assert.equal(out["PAYMENT-REQUIRED"], 'Payment id="chal"');
  assert.equal(out["PAYMENT-RESPONSE"], "settle-abc");
  assert.equal(out["X-Payment-Required"], "also-required");
  assert.equal(out["X-Payment-Response"], "pay-resp");
  assert.equal(out["X-Payment-Id"], "pay-id");
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["cache-control"], "no-cache");
  assert.equal(out["Content-Type"], undefined);
  assert.equal(out["Authorization"], undefined);
  assert.equal(out["authorization"], undefined);
  assert.equal(out["Set-Cookie"], undefined);
  assert.equal(out["set-cookie"], undefined);
  assert.equal(out["Connection"], undefined);
  assert.equal(out["connection"], undefined);
  assert.equal(out["Transfer-Encoding"], undefined);
  assert.equal(out["Proxy-Authenticate"], undefined);
});

test("upstreamRequestHeaders injects Bearer apiKey and copies payment headers", () => {
  const base = upstreamRequestHeaders("sk-test-offline", "req-1", {});
  assert.equal(base.authorization, "Bearer sk-test-offline");
  assert.equal(base["content-type"], "application/json");
  assert.equal(base["x-killswitch-request-id"], "req-1");

  const paid = upstreamRequestHeaders("sk-test-offline", "req-1", {
    "x-payment": "pay-payload",
    "payment-signature": "sig-1",
    "x-payment-signature": "sig-2",
    "x-payment-extra": "extra",
    authorization: "Payment cred-abc",
    cookie: "session=no",
    connection: "close",
  });
  assert.equal(paid.authorization, "Payment cred-abc");
  assert.equal(paid["X-Payment"], "pay-payload");
  assert.equal(paid["Payment-Signature"], "sig-1");
  assert.equal(paid["X-Payment-Signature"], "sig-2");
  assert.equal(paid["X-Payment-Extra"], "extra");
  assert.equal(paid.cookie, undefined);
  assert.equal(paid.connection, undefined);

  const secondKey = upstreamRequestHeaders("sk-test-offline", "req-1", {
    authorization: "Bearer sk-other",
    "x-payment": "pay-payload",
  });
  assert.equal(secondKey.authorization, "Bearer sk-test-offline");
  assert.equal(secondKey["X-Payment"], "pay-payload");

  const sameKey = upstreamRequestHeaders("sk-test-offline", "req-1", {
    authorization: "Bearer sk-test-offline",
    "x-payment": "pay-payload",
  });
  assert.equal(sameKey.authorization, "Bearer sk-test-offline");

  const signature = upstreamRequestHeaders("sk-test-offline", "req-1", {
    authorization: "sig-blob",
    "x-payment": "pay-payload",
  });
  assert.equal(signature.authorization, "sig-blob");
});

function seedLedger(lines) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", "spend-ledger.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function spentLine(agoMs, costUsd, totalTokens = 0, model = "gpt-4o") {
  return { timestamp: new Date(Date.now() - agoMs).toISOString(), model, prompt_tokens: 0,
    completion_tokens: 0, total_tokens: totalTokens, cost_usd: costUsd, allowed: true, veto_reason: null,
    request_id: "seed" };
}

test("two overlapping allows: the second sees the first call's hold and is refused", async () => {
  // $4.20 already spent this hour against the $5.00 default; o1 with
  // max_tokens 8000 holds 8000 * $60/1M = $0.48 per call, plus the request
  // bytes as prompt tokens at $15/1M.
  seedLedger([spentLine(10 * 60_000, 4.2)]);
  upstream.state.delayMs = 300;
  const port = await startKillswitch();
  const body = { model: "o1", max_tokens: 8000, messages: [] };
  const [a, b] = await Promise.all([chat(port, body), chat(port, body)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 429]);
  const refused = a.status === 429 ? a : b;
  assert.equal(refused.json.error.code, "budget_exceeded");
  const held = (8000 * 60 + bodyBytes(body) * 15) / 1_000_000;
  assert.equal(refused.json.error.spent_usd, Math.round((4.2 + held) * 10000) / 10000);
  assert.equal(upstream.state.hits, 1);
  const h = await health(port);
  assert.equal(h.in_flight, 0);
});

test("overlapping token holds: 35,000-token calls allow at 75,000 and refuse at 110,000", async () => {
  // 5,000 tokens already in the last minute; default limit 100,000 tokens/min.
  seedLedger([spentLine(10_000, 0.001, 5000, "gpt-4o-mini")]);
  upstream.state.delayMs = 300;
  const port = await startKillswitch();
  const body = { model: "gpt-4o-mini", max_tokens: 35000, messages: [] };
  const results = await Promise.all([chat(port, body), chat(port, body), chat(port, body)]);
  const ok = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status === 429);
  assert.equal(ok.length, 2);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].json.error.code, "budget_exceeded");
  // spent_usd carries the minute tokens seen by the third check: 5,000 plus
  // two holds of 35,000 and the request bytes.
  assert.equal(refused[0].json.error.spent_usd, 5000 + 2 * (35000 + bodyBytes(body)));
  assert.equal(upstream.state.hits, 2);
});

test("a call without max_tokens is checked at the per-request cap", async () => {
  // $4.60 spent; the missing max_tokens counts as the $0.50 cap: 4.60 + 0.50 > 5.00.
  seedLedger([spentLine(10 * 60_000, 4.6)]);
  const port = await startKillswitch();
  const r = await chat(port, { model: "gpt-4o-mini", messages: [] });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "budget_exceeded");
  assert.equal(upstream.state.hits, 0);
});

test("a 200 JSON body with no usage keeps the held estimate and survives a restart", async () => {
  upstream.state.mode = "nousage";
  const port = await startKillswitch();
  const body = { model: "o1", max_tokens: 1000, messages: [] };
  const r = await chat(port, body);
  assert.equal(r.status, 200);
  const held = (1000 * 60 + bodyBytes(body) * 15) / 1_000_000;
  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].metered, "held_estimate");
  assert.equal(lines[0].total_tokens, 1000 + bodyBytes(body));
  assert.ok(Math.abs(lines[0].cost_usd - held) < 1e-12, `cost_usd ${lines[0].cost_usd}`);
  assert.ok(Math.abs((await health(port)).hour_usd - held) < 1e-12);

  await close(servers.pop());
  const port2 = await startKillswitch();
  assert.ok(Math.abs((await health(port2)).hour_usd - held) < 1e-12);
});

test("a stream that ends at [DONE] with no usage event keeps the held estimate", async () => {
  upstream.state.mode = "stream-nousage";
  const port = await startKillswitch();
  const body = { model: "gpt-4o", max_tokens: 2000, stream: true, messages: [] };
  const r = await chat(port, body);
  assert.equal(r.status, 200);
  assert.match(r.text, /data: \[DONE\]/);
  const held = (2000 * 10 + bodyBytes(body) * 2.5) / 1_000_000;
  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].metered, "held_estimate");
  assert.equal(lines[0].total_tokens, 2000 + bodyBytes(body));
  assert.ok(Math.abs(lines[0].cost_usd - held) < 1e-12, `cost_usd ${lines[0].cost_usd}`);
});

test("usage replaces the hold with the real cost; a 402 challenge releases it with no line", async () => {
  const port = await startKillswitch();
  const r = await chat(port, { model: "gpt-4o-mini", max_tokens: 4000, messages: [] });
  assert.equal(r.status, 200);
  const lines = readLedger(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].metered, "usage");
  assert.equal(lines[0].total_tokens, 1500);

  upstream.state.mode = "402";
  const c = await chat(port, { model: "gpt-4o-mini", max_tokens: 4000, messages: [] });
  assert.equal(c.status, 402);
  assert.equal(readLedger(dir).length, 1);
  const h = await health(port);
  assert.equal(h.in_flight, 0);
  const real = (1000 * 0.15 + 500 * 0.6) / 1_000_000;
  assert.ok(Math.abs(h.hour_usd - real) < 1e-12, `hour_usd ${h.hour_usd}`);
});

for (const stream of [false, true]) {
  test(`served model telemetry and privacy (stream=${stream})`, async () => {
    upstream.state.mode = stream ? "stream" : "ok";
    upstream.state.servedModel = "substituted-model";
    const port = await startKillswitch();
    const r = await chat(port, {model: "gpt-4o-mini", stream, max_tokens: 100, messages: [{role:"user",content:"PRIVATE_PROMPT"}]});
    assert.equal(r.status, 200);
    const row = readLedger(dir)[0];
    assert.equal(row.requested_model, "gpt-4o-mini");
    assert.equal(row.served_model, "substituted-model");
    assert.equal(row.model_mismatch, true);
    assert.equal(row.model, row.requested_model);
    assert.ok(!JSON.stringify(row).includes("PRIVATE_PROMPT"));
    assert.ok(!("choices" in row));
  });
}
test("same or absent served model is not a mismatch", async () => {
  const port = await startKillswitch();
  await chat(port, {model:"gpt-4o-mini",max_tokens:100,messages:[]});
  upstream.state.mode = "nousage";
  await chat(port, {model:"gpt-4o-mini",max_tokens:100,messages:[]});
  const [a,b] = readLedger(dir);
  assert.equal(a.model_mismatch,false);
  assert.equal(b.served_model,null);
  assert.equal(b.model_mismatch,false);
});
test("custom rates drive admission and settled accounting", async () => {
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({"custom-model":{in:0.55,out:2.19}});
  process.env.KILLSWITCH_MAX_COST_REQUEST = "0.01";
  const port = await startKillswitch();
  assert.equal((await chat(port,{model:"custom-model",max_tokens:1000,messages:[]})).status,200);
  assert.equal(readLedger(dir)[0].cost_usd,(1000*0.55+500*2.19)/1e6);
  assert.equal((await chat(port,{model:"unknown-model",max_tokens:1000,messages:[]})).status,429);
});
test("malformed model rates fail startup", () => {
  for (const value of ['null','[]','{"x":{"in":-1,"out":2}}','{"x":{"in":"1","out":2}}','{"x":{"in":1}}','{"x":{"in":1,"out":2,"typo":3}}','{']) {
    process.env.KILLSWITCH_MODEL_RATES = value;
    assert.throws(() => createServer(), /rates/i);
  }
});
test("verified provider models avoid unknown fallback", () => {
  // Highest routed endpoint price; exact values live in test/pricing-rows.test.mjs.
  assert.ok(Math.abs(costUsd("deepseek/deepseek-r1-0528",1e6,1e6) - 2.857) < 1e-9);
  assert.ok(Math.abs(costUsd("google/gemini-2.5-flash",1e6,1e6) - 6.3) < 1e-9);
  assert.ok(Math.abs(costUsd("anthropic/claude-sonnet-4.5",1e6,1e6) - 31.35) < 1e-9);
  assert.equal(costUsd("toString",1e6,1e6),75);
});

test("config model rates merge with env per exact id, env wins", async () => {
  fs.writeFileSync("config.yaml", JSON.stringify({model_rates:{"custom":{in:1,out:2},"gpt-4o-mini":{in:4,out:5}}}));
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({custom:{in:0,out:0}});
  const port = await startKillswitch();
  await chat(port,{model:"custom",max_tokens:100,messages:[]});
  await chat(port,{model:"gpt-4o-mini",max_tokens:100,messages:[]});
  const rows = readLedger(dir);
  assert.equal(rows[0].cost_usd,0);
  assert.equal(rows[1].cost_usd,0.0065);
});
test("rate overrides survive budget replay", async () => {
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({custom:{in:10,out:20}});
  process.env.KILLSWITCH_MAX_USD_HOUR = "0.025";
  const port = await startKillswitch();
  assert.equal((await chat(port,{model:"custom",max_tokens:100,messages:[]})).status,200);
  assert.equal(readLedger(dir)[0].cost_usd,0.02);
  const port2 = await startKillswitch();
  assert.equal((await chat(port2,{model:"custom",max_tokens:1000,messages:[]})).status,429);
});
test("request cannot supply operator model rates", async () => {
  const port = await startKillswitch();
  assert.equal((await chat(port,{model:"unknown",max_tokens:10000,model_rates:{unknown:{in:0,out:0}},messages:[]})).status,429);
  assert.equal(upstream.state.hits,0);
});
test("invalid served model is unknown, headers are not evidence", async () => {
  upstream.state.servedModel = {content:"DO_NOT_LOG"};
  upstream.state.extraHeaders = {"x-served-model":"claimed-by-header"};
  const port = await startKillswitch();
  await chat(port,{model:"gpt-4o-mini",max_tokens:100,messages:[]});
  const row = readLedger(dir)[0];
  assert.equal(row.served_model,null);
  assert.equal(row.model_mismatch,false);
  assert.ok(!JSON.stringify(row).includes("DO_NOT_LOG"));
});

test("explicit zero override removes a no-max-token hold, paid free-list call retains rates", async () => {
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({custom:{in:0,out:0}});
  const port = await startKillswitch();
  assert.equal((await chat(port,{model:"custom",messages:[]})).status,200);
  assert.equal(readLedger(dir)[0].cost_usd,0);
  process.env.KILLSWITCH_FREE_MODELS = "paid-custom";
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({"paid-custom":{in:15,out:60}});
  const paidPort = await startKillswitch();
  assert.equal((await chat(paidPort,{model:"paid-custom",max_tokens:10000,messages:[]},{"X-Payment":"synthetic"})).status,429);
});
test("served model is captured on a stream without usage", async () => {
  upstream.state.mode = "stream-nousage";
  upstream.state.servedModel = "different";
  const port = await startKillswitch();
  await chat(port,{model:"gpt-4o-mini",stream:true,max_tokens:100,messages:[]});
  const row = readLedger(dir)[0];
  assert.equal(row.served_model,"different");
  assert.equal(row.model_mismatch,true);
  assert.equal(row.metered,"held_estimate");
});
test("binding policy accepts env rates without extending the shared schema", async () => {
  fs.writeFileSync("config.yaml",JSON.stringify({schema:"twzrd.binding_policy.v1",compute:{}}));
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({custom:{in:1,out:2}});
  const port = await startKillswitch();
  await chat(port,{model:"custom",max_tokens:100,messages:[]});
  assert.equal(readLedger(dir)[0].cost_usd,0.002);
});

test("an expensive override never changes the fixed fallback for unrelated models", () => {
  const rates = parseModelRates({expensive:{in:100,out:200}});
  assert.equal(costUsd("expensive",1e6,1e6,[],rates),300);
  assert.equal(costUsd("unknown",1e6,1e6,[],rates),75);
  assert.equal(costUsd("constructor",1e6,1e6,[],rates),75);
});
