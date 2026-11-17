// Offline tests for the rules that keep spend on the ledger: what counts as
// an upstream usage block, what the proxy does when the ledger cannot be
// written, appending after an unterminated last line, which bodiless
// requests skip the hold, and which guards share holds.
// A stub upstream on 127.0.0.1:0; no API key, no network, no spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../dist/index.js";
import { Ledger } from "../dist/ledger.js";
import { sessionManagementKind } from "../dist/proxy.js";
import { createToolGuard } from "../dist/tool-guard.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ks-integrity-${tag}-`));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function cfgFor(dir, upstreamPort, overrides = {}) {
  return {
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: "sk-test-offline",
    freeModels: [],
    modelRates: Object.freeze({}),
    upstreamTimeoutMs: 60000,
    maxTokensPerMinute: 10_000_000,
    maxUsdPerHour: 1,
    maxUsdPerDay: 5,
    maxCostPerRequestUsd: 0.5,
    maxRequestsPerMinute: 0,
    upstreamFailureThreshold: 0,
    upstreamFailureCooldownMs: 60000,
    killFilePath: path.join(dir, ".kill"),
    pauseFilePath: path.join(dir, ".pause"),
    enableKillApi: false,
    ledgerPath: path.join(dir, "spend-ledger.jsonl"),
    port: 0,
    ...overrides,
  };
}

/** Stub upstream: answers 200 with whatever `state.respond` builds. */
async function startUpstream() {
  const state = { hits: 0, headers: [], respond: null };
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      state.hits++;
      state.headers.push({ ...req.headers });
      state.respond(res);
    });
  });
  const port = await listen(server);
  return { state, server, port };
}

function jsonAnswer(usage) {
  return (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const body = { id: "chatcmpl-stub", choices: [{ message: { role: "assistant", content: "hi" } }] };
    if (usage !== undefined) body.usage = usage;
    res.end(JSON.stringify(body));
  };
}

function streamAnswer(usageJson) {
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write(`data: {"choices":[],"usage":${usageJson}}\n\n`);
    res.end("data: [DONE]\n\n");
  };
}

async function post(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

function ledgerLines(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

const CHAT = { model: "gpt-4o-mini", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

const UNUSABLE_USAGE = [
  ["an empty object", {}],
  ["true", true],
  ["a string", "none"],
  ["a negative count", { prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 }],
  ["null counts", { prompt_tokens: null, completion_tokens: null, total_tokens: null }],
  ["a string count", { prompt_tokens: "10", completion_tokens: 5, total_tokens: 15 }],
  ["a fractional count", { prompt_tokens: 10.5, completion_tokens: 5, total_tokens: 15 }],
  ["a count past the safe-integer range", { prompt_tokens: 1e308, completion_tokens: 1e308, total_tokens: 1 }],
  ["a missing completion count", { prompt_tokens: 10, total_tokens: 10 }],
];

for (const [label, usage] of UNUSABLE_USAGE) {
  test(`a 2xx whose usage block is ${label} settles the held estimate, like a 2xx with no usage`, async () => {
    const dir = tmpDir("usage");
    const up = await startUpstream();
    up.state.respond = jsonAnswer(usage);
    const cfg = cfgFor(dir, up.port);
    const proxy = createServer(cfg);
    const port = await listen(proxy);
    try {
      const res = await post(port, CHAT);
      assert.equal(res.status, 200);
      const allowed = ledgerLines(cfg.ledgerPath).filter((l) => l.allowed);
      assert.equal(allowed.length, 1);
      assert.equal(allowed[0].metered, "held_estimate");
      assert.equal(typeof allowed[0].cost_usd, "number");
      assert.ok(Number.isFinite(allowed[0].cost_usd) && allowed[0].cost_usd > 0);
      assert.ok(!fs.readFileSync(cfg.ledgerPath, "utf8").includes('"cost_usd":null'));
    } finally {
      await close(proxy);
      await close(up.server);
    }
  });
}

test("a stream whose usage event has unusable counts settles the held estimate", async () => {
  const dir = tmpDir("usage-stream");
  const up = await startUpstream();
  up.state.respond = streamAnswer('{"prompt_tokens":-5,"completion_tokens":"x","total_tokens":-5}');
  const cfg = cfgFor(dir, up.port);
  const proxy = createServer(cfg);
  const port = await listen(proxy);
  try {
    const res = await post(port, { ...CHAT, stream: true });
    assert.equal(res.status, 200);
    const allowed = ledgerLines(cfg.ledgerPath).filter((l) => l.allowed);
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].metered, "held_estimate");
    assert.ok(allowed[0].cost_usd > 0);
  } finally {
    await close(proxy);
    await close(up.server);
  }
});

test("a well-formed usage block is still priced from its counts", async () => {
  const dir = tmpDir("usage-ok");
  const up = await startUpstream();
  up.state.respond = jsonAnswer({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 });
  const cfg = cfgFor(dir, up.port);
  const proxy = createServer(cfg);
  const port = await listen(proxy);
  try {
    assert.equal((await post(port, CHAT)).status, 200);
    const allowed = ledgerLines(cfg.ledgerPath).filter((l) => l.allowed);
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].metered, "usage");
    assert.equal(allowed[0].prompt_tokens, 1000);
    assert.equal(allowed[0].completion_tokens, 50);
    assert.equal(allowed[0].total_tokens, 1050);
  } finally {
    await close(proxy);
    await close(up.server);
  }
});

test(
  "the proxy stops forwarding while the ledger cannot be written, and records the spend once it can",
  { skip: process.getuid?.() === 0 ? "file modes do not bind root" : false },
  async () => {
    const dir = tmpDir("unwritable");
    const up = await startUpstream();
    up.state.respond = jsonAnswer({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 });
    const cfg = cfgFor(dir, up.port);
    fs.writeFileSync(cfg.ledgerPath, "");
    fs.chmodSync(cfg.ledgerPath, 0o444);
    const proxy = createServer(cfg);
    const port = await listen(proxy);
    try {
      // The first call is forwarded; its settlement cannot be written.
      assert.equal((await post(port, CHAT)).status, 200);
      assert.equal(up.state.hits, 1);
      assert.equal(ledgerLines(cfg.ledgerPath).length, 0);

      // The proxy pauses on that failure, and refuses in its usual shape.
      assert.ok(fs.existsSync(cfg.pauseFilePath), "a failed settlement write must pause");
      const second = await post(port, CHAT);
      assert.equal(second.status, 429);
      assert.equal(second.json.error.code, "payment_gate_halt");
      assert.equal(up.state.hits, 1);

      // Clearing the pause file does not resume while the ledger is unwritable.
      fs.rmSync(cfg.pauseFilePath);
      const third = await post(port, CHAT);
      assert.equal(third.status, 429);
      assert.equal(third.json.error.code, "payment_gate_halt");
      assert.equal(up.state.hits, 1);

      // Writable again: the next call writes the owed settlement and is still
      // refused; the one after it is forwarded.
      fs.chmodSync(cfg.ledgerPath, 0o644);
      const fourth = await post(port, CHAT);
      assert.equal(fourth.status, 429);
      assert.equal(up.state.hits, 1);
      const settled = ledgerLines(cfg.ledgerPath).filter((l) => l.allowed);
      assert.equal(settled.length, 1);
      assert.ok(settled[0].cost_usd > 0);

      assert.equal((await post(port, CHAT)).status, 200);
      assert.equal(up.state.hits, 2);
      assert.equal(ledgerLines(cfg.ledgerPath).filter((l) => l.allowed).length, 2);
    } finally {
      fs.chmodSync(cfg.ledgerPath, 0o644);
      await close(proxy);
      await close(up.server);
    }
  },
);

test("Ledger.append after an unterminated last line writes a whole line every reader counts", () => {
  const dir = tmpDir("torn");
  const ledgerPath = path.join(dir, "spend-ledger.jsonl");
  const now = new Date().toISOString();
  const whole = { timestamp: now, model: "m", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0.1, allowed: true, veto_reason: null, request_id: "a" };
  fs.writeFileSync(ledgerPath, JSON.stringify(whole) + "\n" + '{"timestamp":"' + now + '","model":"m","cost_u');

  const writer = new Ledger(ledgerPath);
  writer.load();
  writer.append({ ...whole, cost_usd: 0.25, request_id: "b" });

  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n");
  assert.equal(lines.at(-1), "");
  assert.equal(JSON.parse(lines.at(-2)).request_id, "b");

  assert.ok(Math.abs(writer.window().hourUsd - 0.35) < 1e-9, "the writing instance counts its own line");
  const reader = new Ledger(ledgerPath);
  reader.load();
  assert.ok(Math.abs(reader.window().hourUsd - 0.35) < 1e-9, "a fresh reader counts the line");
});

function paymentCredential(action) {
  return "Payment " + Buffer.from(JSON.stringify({ payload: { action } }), "utf8").toString("base64url");
}

test("a close or topUp credential skips the hold only when no other payment header rides with it", () => {
  const close_ = paymentCredential("close");
  const topUp = paymentCredential("topUp");
  assert.equal(sessionManagementKind({ authorization: close_ }, ""), "close");
  assert.equal(sessionManagementKind({ authorization: topUp }, ""), "topUp");
  for (const header of ["x-payment", "payment-signature", "x-payment-signature"]) {
    assert.equal(sessionManagementKind({ authorization: close_, [header]: "v" }, ""), "refuse", header);
    assert.equal(sessionManagementKind({ authorization: topUp, [header]: "v" }, ""), "refuse", header);
    // With a body it is an ordinary chat call: the hold, pause and limits apply.
    assert.equal(sessionManagementKind({ authorization: close_, [header]: "v" }, '{"model":"m"}'), null, header);
  }
});

test("a bodiless close credential with another payment header is refused before upstream", async () => {
  const dir = tmpDir("close");
  const up = await startUpstream();
  up.state.respond = (res) => {
    res.writeHead(204);
    res.end();
  };
  const cfg = cfgFor(dir, up.port, { apiKey: "" });
  const proxy = createServer(cfg);
  const port = await listen(proxy);
  try {
    const mixed = await post(port, undefined, { authorization: paymentCredential("close"), "x-payment": "signed" });
    assert.equal(mixed.status, 400);
    assert.equal(up.state.hits, 0);
    const plain = await post(port, undefined, { authorization: paymentCredential("close") });
    assert.equal(plain.status, 204);
    assert.equal(up.state.hits, 1);
  } finally {
    await close(proxy);
    await close(up.server);
  }
});

function guardOn(dir, ledgerPath) {
  return createToolGuard({
    ledgerPath,
    killFilePath: path.join(dir, ".kill"),
    pauseFilePath: path.join(dir, ".pause"),
    allowedTools: ["search"],
    maxCostPerCallUsd: 1,
    maxUsdPerHour: 1.5,
    maxUsdPerDay: 1.5,
  });
}

test("guards on a ledger and on a hard link to it share holds", () => {
  const dir = tmpDir("hardlink");
  const ledgerPath = path.join(dir, "ledger.jsonl");
  const alias = path.join(dir, "alias.jsonl");
  fs.writeFileSync(ledgerPath, "");
  fs.linkSync(ledgerPath, alias);
  const first = guardOn(dir, ledgerPath).authorize({ tool: "search", worstCaseUsd: 1 });
  assert.equal(first.allowed, true);
  const second = guardOn(dir, alias).authorize({ tool: "search", worstCaseUsd: 1 });
  assert.equal(second.allowed, false);
  assert.equal(second.code, "budget_exceeded");
  first.hold.release();
});

for (const order of ["target first", "link first"]) {
  test(`guards on a ledger and on a symlink made before the ledger exists share holds (${order})`, () => {
    const dir = tmpDir("early-symlink");
    const ledgerPath = path.join(dir, "ledger.jsonl");
    const alias = path.join(dir, "alias.jsonl");
    fs.symlinkSync(ledgerPath, alias);
    const paths = order === "target first" ? [ledgerPath, alias] : [alias, ledgerPath];
    const first = guardOn(dir, paths[0]).authorize({ tool: "search", worstCaseUsd: 1 });
    assert.equal(first.allowed, true);
    const second = guardOn(dir, paths[1]).authorize({ tool: "search", worstCaseUsd: 1 });
    assert.equal(second.allowed, false);
    assert.equal(second.code, "budget_exceeded");
    first.hold.release();
  });
}
