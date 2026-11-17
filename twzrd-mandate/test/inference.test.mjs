// The /v1 route: an OpenAI-compatible upstream behind agent-killswitch, started
// by the sidecar with the mandate's caps and files and nothing from the host
// environment. The upstream here is a loopback stub.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { STATE_FILES, VERSION, startInferenceMeter, startSidecar } from "../dist/index.js";
import { makeRig } from "./helpers.mjs";

const RATES = JSON.stringify({ "test-model": { in: 1000, out: 2000 } });

/** An OpenAI-compatible stub. `usage` is what it reports for the next answers. */
async function startUpstream() {
  const stub = { usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, requests: [], status: 200 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      stub.requests.push({ url: req.url, auth: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(stub.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          ...(stub.usage === undefined ? {} : { usage: stub.usage }),
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.base = `http://127.0.0.1:${server.address().port}/v1`;
  stub.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

async function makeMetered(mandate = {}, env = {}) {
  const rig = await makeRig({ mandate: { maxPerCallUsd: "0.50", hourlyCeilingUsd: "1.00", dailyCeilingUsd: "1.00", ...mandate } });
  const upstream = await startUpstream();
  process.env.MANDATE_TEST_UPSTREAM_KEY = "sk-loopback-test";
  Object.assign(process.env, env);
  let meter;
  let sidecar;
  try {
    meter = await startInferenceMeter({
      runtime: rig.runtime,
      expiresAtMs: rig.expiresAtMs,
      upstreamBaseUrl: upstream.base,
      apiKeyEnv: "MANDATE_TEST_UPSTREAM_KEY",
      modelRatesJson: RATES,
    });
    sidecar = await startSidecar({ runtime: rig.runtime, version: VERSION, port: 0, inference: meter });
  } catch (err) {
    meter?.close();
    await upstream.close();
    await rig.close();
    throw err;
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    delete process.env.MANDATE_TEST_UPSTREAM_KEY;
  }
  const chat = (body = {}) =>
    fetch(`${sidecar.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...body }),
    });
  const spent = () => Number(rig.runtime.status().spend.dayUsd);
  const ledgerLines = () => {
    try {
      return fs.readFileSync(path.join(rig.stateDir, STATE_FILES.toolLedger), "utf8").split("\n").filter((l) => l.includes('"allowed":true')).length;
    } catch {
      return 0;
    }
  };
  /** The meter writes its ledger line after the answer has been sent. Wait for `lines` of them. */
  const recorded = async (lines) => {
    const deadline = Date.now() + 5000;
    while (ledgerLines() < lines && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return ledgerLines();
  };
  return {
    ...rig,
    upstream,
    sidecar,
    chat,
    spent,
    recorded,
    async close() {
      await sidecar.close();
      meter.close();
      await upstream.close();
      await rig.close();
    },
  };
}

test("/v1 is metered: the call is forwarded with the upstream key, billed from usage, and logged", async () => {
  const m = await makeMetered();
  try {
    const resp = await m.chat();
    assert.equal(resp.status, 200, await resp.clone().text());
    assert.equal((await resp.json()).choices[0].message.content, "ok");
    assert.equal(m.upstream.requests.length, 1);
    assert.equal(m.upstream.requests[0].auth, "Bearer sk-loopback-test");
    // 1000 prompt tokens at 1000 USD per million and 500 completion tokens at 2000: the upstream bills 2.00 USD.
    assert.equal(await m.recorded(1), 1);
    assert.equal(m.spent(), 2, "the billed amount is what is recorded");
    // That is over the 1.00 USD day, so the next call is refused before it is forwarded.
    const next = await m.chat();
    await next.arrayBuffer();
    assert.notEqual(next.status, 200);
    assert.equal(m.upstream.requests.length, 1);
    const row = m.runtime.ledger.tail(1)[0];
    assert.deepEqual([row.tool, row.outcome], ["inference", "forwarded"]);
    assert.equal(m.runtime.ledger.verify().ok, true);
  } finally {
    await m.close();
  }
});

test("/v1 over the per-call cap is refused before it is forwarded", async () => {
  const m = await makeMetered();
  try {
    // 400 output tokens at 2000 USD per million is 0.80 USD: over the 0.50 per-call cap.
    const resp = await m.chat({ max_tokens: 400 });
    assert.ok(resp.status >= 400 && resp.status < 500, `status ${resp.status}`);
    assert.equal(m.upstream.requests.length, 0, "an over-cap request reached the upstream");
    assert.equal(m.spent(), 0);
  } finally {
    await m.close();
  }
});

test("/v1 with a malformed usage block: the reserved worst case is recorded, never zero", async () => {
  for (const usage of ["lots", { prompt_tokens: -5, completion_tokens: "x" }, null, undefined, [], { prompt_tokens: "1000", completion_tokens: {} }]) {
    const m = await makeMetered();
    try {
      m.upstream.usage = usage;
      const resp = await m.chat({ max_tokens: 100 });
      await resp.arrayBuffer();
      assert.equal(m.upstream.requests.length, 1);
      assert.equal(await m.recorded(1), 1, `usage ${JSON.stringify(usage)}: nothing was recorded`);
      // 100 output tokens reserve 0.20 USD plus the prompt. A bill the meter cannot read must not be recorded as free.
      assert.ok(m.spent() >= 0.2, `usage ${JSON.stringify(usage)} recorded ${m.spent()}`);
      assert.ok(m.spent() <= 0.5 + 1e-9, `usage ${JSON.stringify(usage)} recorded ${m.spent()}, over the per-call cap`);
    } finally {
      await m.close();
    }
  }
  // An upstream that reports an absurd bill: it is recorded as reported, and nothing more is forwarded.
  const huge = await makeMetered();
  try {
    huge.upstream.usage = { prompt_tokens: 1e12, completion_tokens: 1e12 };
    await (await huge.chat({ max_tokens: 100 })).arrayBuffer();
    assert.equal(await huge.recorded(1), 1);
    assert.ok(huge.spent() > 1);
    const next = await huge.chat({ max_tokens: 100 });
    await next.arrayBuffer();
    assert.notEqual(next.status, 200);
    assert.equal(huge.upstream.requests.length, 1);
  } finally {
    await huge.close();
  }
});

test("/v1 stops on the kill file, on a pause, and when the daily ceiling is reached", async () => {
  const m = await makeMetered();
  try {
    m.runtime.kill("test");
    const killed = await m.chat();
    assert.equal(killed.status, 403);
    assert.equal((await killed.json()).error.code, "kill_switch");
    m.runtime.resume();
    fs.writeFileSync(path.join(m.stateDir, STATE_FILES.pause), "unreadable pause file");
    const paused = await m.chat();
    assert.equal(paused.status, 403);
    assert.equal((await paused.json()).error.code, "payment_gate_halt");
    assert.equal(m.upstream.requests.length, 0);
    m.runtime.resume();
    // Each call reserves about 0.20 USD against a 1.00 USD day. Well before ten calls the meter must refuse.
    m.upstream.usage = { prompt_tokens: 0, completion_tokens: 100, total_tokens: 100 };
    let refused = 0;
    let served = 0;
    for (let i = 0; i < 10; i += 1) {
      const resp = await m.chat({ max_tokens: 100 });
      await resp.arrayBuffer();
      if (resp.status === 200) {
        served += 1;
        await m.recorded(served);
      } else refused += 1;
    }
    assert.ok(refused >= 4, `only ${refused} of 10 calls were refused`);
    assert.ok(m.spent() <= 1.0 + 1e-9, `recorded ${m.spent()} against a 1.00 daily ceiling`);
    assert.equal(m.upstream.requests.length, served);
  } finally {
    await m.close();
  }
});

test("the meter takes its limits from the mandate, not from the host environment", async () => {
  const hostile = {
    KILLSWITCH_MAX_USD_DAY: "100000",
    KILLSWITCH_MAX_USD_HOUR: "100000",
    KILLSWITCH_MAX_COST_REQUEST: "100000",
    KILLSWITCH_KILL_FILE: "/nonexistent/.kill",
    KILLSWITCH_LEDGER_PATH: "/tmp/twzrd-mandate-elsewhere.jsonl",
    KILLSWITCH_FREE_MODELS: "test-model",
    KILLSWITCH_UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1",
  };
  const m = await makeMetered({}, hostile);
  try {
    const over = await m.chat({ max_tokens: 400 });
    assert.ok(over.status >= 400 && over.status < 500, "the host's per-request cap replaced the mandate's");
    m.upstream.usage = { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 };
    const ok = await m.chat({ max_tokens: 100 });
    await ok.arrayBuffer();
    assert.equal(ok.status, 200);
    assert.equal(m.upstream.requests.length, 1, "the host's upstream replaced the configured one");
    assert.equal(await m.recorded(1), 1);
    assert.ok(Math.abs(m.spent() - 0.11) < 1e-9, `the host's free-model list or rates changed the bill: ${m.spent()}`);
    assert.equal(fs.existsSync("/tmp/twzrd-mandate-elsewhere.jsonl"), false);
    m.runtime.kill("test");
    assert.equal((await m.chat()).status, 403);
  } finally {
    await m.close();
  }
});

test("without a key and without free models the meter refuses to start", async () => {
  const rig = await makeRig();
  try {
    delete process.env.MANDATE_TEST_ABSENT_KEY;
    await assert.rejects(
      () => startInferenceMeter({ runtime: rig.runtime, expiresAtMs: rig.expiresAtMs, upstreamBaseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "MANDATE_TEST_ABSENT_KEY", startTimeoutMs: 5000 }),
      /did not start/,
    );
    await assert.rejects(
      () => startInferenceMeter({ runtime: rig.runtime, expiresAtMs: rig.expiresAtMs, upstreamBaseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "BAD NAME; rm" }),
      /not a valid environment variable name/,
    );
  } finally {
    await rig.close();
  }
});
