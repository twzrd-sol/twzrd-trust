import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../dist/index.js";
import { loadConfig } from "../dist/config.js";
import { checkPauseSwitch } from "../dist/gate.js";

const ORIGINAL_CWD = process.cwd();

/** Stub upstream: 200 with usage, or `state.status` with an error body. `state.headers` go on every answer. */
function startUpstream() {
  const state = { hits: 0, status: 200, headers: {} };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.hits++;
      if (state.status !== 200) {
        res.writeHead(state.status, { "content-type": "application/json", ...state.headers });
        res.end(JSON.stringify({ error: { message: `stub ${state.status}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...state.headers });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
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

async function chat(port, body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

let dir;
let upstream;
let servers;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-binding-test-"));
  process.chdir(dir);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("KILLSWITCH_") || k === "TWZRD_STATE_DIR") delete process.env[k];
  }
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

test("loadConfig parses twzrd.binding_policy.v1 and ignores payment section errors", () => {
  const policyPath = path.join(dir, "binding-policy.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "schema: twzrd.binding_policy.v1",
      "state_dir: ./shared-state",
      "compute:",
      "  max_tokens_per_minute: 42000",
      "  max_usd_per_hour: 1.25",
      "  max_usd_per_day: 9.5",
      "  max_cost_per_request_usd: 0.15",
      "  port: 4099",
      "payment:",
      "  max_spend_usdc: '0.25'",
      "  allow_networks: [solana, base]",
    ].join("\n"),
  );
  const cfg = loadConfig(policyPath);
  assert.equal(cfg.maxTokensPerMinute, 42000);
  assert.equal(cfg.maxUsdPerHour, 1.25);
  assert.equal(cfg.maxUsdPerDay, 9.5);
  assert.equal(cfg.maxCostPerRequestUsd, 0.15);
  assert.equal(cfg.port, 4099);
  assert.equal(cfg.killFilePath, path.resolve(dir, "shared-state", ".kill"));
  assert.equal(cfg.pauseFilePath, path.resolve(dir, "shared-state", ".pause"));
  assert.equal(cfg.ledgerPath, path.resolve(dir, "shared-state", "spend-ledger.jsonl"));
});

test("loadConfig fails closed on unknown compute keys in twzrd.binding_policy.v1", () => {
  const policyPath = path.join(dir, "bad-binding.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "schema: twzrd.binding_policy.v1",
      "compute:",
      "  max_usd_per_typo: 1.0",
    ].join("\n"),
  );
  assert.throws(() => loadConfig(policyPath), /unknown compute key/i);
});

test("legacy enable_api_endpoint accepts only a literal YAML boolean", () => {
  const configPath = path.join(dir, "config.yaml");
  for (const value of ["off", "no", '"false"']) {
    fs.writeFileSync(configPath, `kill_switch:\n  enable_api_endpoint: ${value}\n`);
    assert.throws(
      () => loadConfig(configPath),
      /kill_switch\.enable_api_endpoint must be a boolean/i,
      `${value} must not become a truthy API flag`,
    );
  }

  fs.writeFileSync(configPath, "kill_switch:\n  enable_api_endpoint: false\n");
  assert.equal(loadConfig(configPath).enableKillApi, false);
});

test("active .pause sentinel vetoes with 429 payment_gate_halt and surfaces decision_id", async () => {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const until = Date.now() + 60_000;
  fs.writeFileSync(
    path.join(dir, "data", ".pause"),
    JSON.stringify({
      schema: "twzrd.pause_sentinel.v1",
      until_unix_ms: until,
      reason: "twzrd_wash_flagged",
      decision_id: "dec_pause_123",
    }),
  );
  const port = await startKillswitch();

  const r = await chat(port);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.type, "killswitch_veto");
  assert.equal(r.json.error.code, "payment_gate_halt");
  assert.equal(r.json.error.decision_id, "dec_pause_123");
  assert.match(r.json.error.message, /twzrd_wash_flagged/);
  assert.equal(upstream.state.hits, 0);

  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.paused, true);
  assert.equal(h.pause_decision_id, "dec_pause_123");
});

test("expired .pause sentinel allows compute requests through without manual unlink", async () => {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "data", ".pause"),
    JSON.stringify({
      schema: "twzrd.pause_sentinel.v1",
      until_unix_ms: Date.now() - 1000,
      reason: "twzrd_wash_flagged",
      decision_id: "dec_expired_1",
    }),
  );
  const port = await startKillswitch();

  const r = await chat(port);
  assert.equal(r.status, 200);
  assert.equal(upstream.state.hits, 1);

  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.paused, false);
});

test("corrupt .pause sentinel fails closed with 429 payment_gate_halt", async () => {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", ".pause"), "{truncated-json");
  const port = await startKillswitch();

  const state = checkPauseSwitch(path.join(dir, "data", ".pause"));
  assert.equal(state.paused, true);
  assert.equal(state.corrupt, true);

  const r = await chat(port);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "payment_gate_halt");
  assert.match(r.json.error.message, /corrupt_pause_sentinel/);
  assert.equal(upstream.state.hits, 0);
});

test("cross-reader conformance: Seat 1 payment refusal writes .pause and halts agent-killswitch compute proxy", async () => {
  const {
    parseBindingPolicy,
    bindingPolicyToGateConfig,
    twzrdApprovePayment,
    resolveConfig,
  } = await import("../../twzrd-x402-gate/dist/index.js");

  const policyPath = path.join(dir, "binding-policy.yaml");
  fs.writeFileSync(
    policyPath,
    [
      "schema: twzrd.binding_policy.v1",
      "state_dir: ./data",
      "compute:",
      "  max_tokens_per_minute: 50000",
      "  max_usd_per_hour: 5.0",
      "  max_usd_per_day: 25.0",
      "  max_cost_per_request_usd: 0.5",
      "payment:",
      "  max_spend_usdc: '0.25'",
      "  allow_networks: [solana]",
      "  preflight_min_score: 50",
      "  trip_pause_on_block_ms: 60000",
    ].join("\n"),
  );
  process.env.KILLSWITCH_CONFIG = policyPath;
  const port = await startKillswitch();

  // 1. Before any payment refusal, compute proxy forwards normally
  const ok1 = await chat(port);
  assert.equal(ok1.status, 200);
  assert.equal(upstream.state.hits, 1);

  // 2. Seat 1 evaluates a payment under the same binding policy and blocks it
  const parsed = parseBindingPolicy({
    schema: "twzrd.binding_policy.v1",
    state_dir: "./data",
    payment: {
      max_spend_usdc: "0.25",
      allow_networks: ["solana"],
      preflight_min_score: 50,
      trip_pause_on_block_ms: 60000,
    },
  });
  const gateCfg = resolveConfig({
    ...bindingPolicyToGateConfig(parsed, dir),
    intelBase: "https://intel.example",
    refuseWashFlagged: false,
    fetch: async () =>
      new Response(
        JSON.stringify({
          readiness_card: { decision: "block", trust_score: 5, can_spend: false },
        }),
        { status: 200 },
      ),
  });
  const approval = await twzrdApprovePayment(
    {
      sellerWallet: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
      priceUsdc: 0.05,
      chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
    gateCfg,
  );
  assert.equal(approval.approved, false);

  // 3. Compute proxy immediately sees .pause and vetoes with 429 payment_gate_halt + matching decision_id
  const halted = await chat(port);
  assert.equal(halted.status, 429);
  assert.equal(halted.json.error.code, "payment_gate_halt");
  assert.equal(halted.json.error.decision_id, approval.decisionId);
  assert.equal(upstream.state.hits, 1, "upstream must not be called while payment gate pause is active");
});

test("Hole 5: hitting the cap in agent-killswitch writes .pause for the cap window and halts the payment gate", async () => {
  const { twzrdApprovePayment, resolveConfig } = await import(
    "../../twzrd-x402-gate/dist/index.js"
  );

  process.env.KILLSWITCH_MAX_USD_HOUR = "0.01";
  process.env.KILLSWITCH_MAX_COST_REQUEST = "0.05";
  const port = await startKillswitch();

  // Request without max_tokens is estimated at $0.05 > $0.01 hourly limit -> budget_exceeded
  const beforeMs = Date.now();
  const vetoed = await chat(port, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  assert.equal(vetoed.status, 429);
  assert.equal(vetoed.json.error.code, "budget_exceeded");
  assert.equal(upstream.state.hits, 0);

  // .pause file was written with the 1h hourly cap window
  const pauseFile = path.join(dir, "data", ".pause");
  assert.equal(fs.existsSync(pauseFile), true, "hitting budget_exceeded must write .pause");
  const pauseState = checkPauseSwitch(pauseFile);
  assert.equal(pauseState.paused, true);
  assert.equal(pauseState.reason, "budget_exceeded");
  assert.ok(
    pauseState.untilUnixMs >= beforeMs + 3_600_000 - 1000,
    "hourly cap breach must write a 1h .pause window",
  );

  // Payment gate immediately sees ./data/.pause and halts before hitting intel
  let intelHits = 0;
  const approval = await twzrdApprovePayment(
    {
      sellerWallet: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
      priceUsdc: 0.001,
      chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
    resolveConfig({
      stateDir: path.join(dir, "data"),
      fetch: async () => {
        intelHits += 1;
        return new Response("{}", { status: 200 });
      },
    }),
  );
  assert.equal(approval.approved, false);
  assert.match(approval.reason, /^twzrd_payment_paused/);
  assert.equal(intelHits, 0, "payment gate must halt on killswitch-written .pause before hitting intel");
});

// --- the opt-in breakers write the same .pause the gate reads ---------------

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Stub x402 seller and fallback board on 127.0.0.1. `/paid` and `/route`
 * answer an unpaid request 402 with an invoice and a paid one (any
 * x-payment header) 200; a paid `/route` names `/paid` as the url to call.
 * `/top` is the free peek. `hits` lists every request in order.
 */
function startSeller() {
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      const paid = typeof req.headers["x-payment"] === "string";
      hits.push(paid ? `${pathname} (paid)` : pathname);
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (pathname === "/top") return json(200, { top: [] });
      if (pathname !== "/paid" && pathname !== "/route") return json(404, {});
      if (!paid) return json(402, { accepts: [{ payTo: SELLER, amount: "10000", network: "solana", asset: USDC }] });
      if (pathname === "/route") return json(200, { url: `http://127.0.0.1:${server.address().port}/paid` });
      return json(200, { ok: true });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })),
  );
}

/** A loopback URL nothing listens on: calling it fails the way a dead origin does. */
async function deadOrigin() {
  const s = http.createServer();
  const port = await listen(s);
  await close(s);
  return `http://127.0.0.1:${port}/paid`;
}

/** A payer that pays any 402 it is handed (by retrying with x-payment) and counts it. */
function countingPayWrap(paid) {
  return (guarded) => async (input, init) => {
    const r = await guarded(input, init);
    if (r.status !== 402) return r;
    paid.n += 1;
    return guarded(input, { ...init, headers: { ...(init?.headers ?? {}), "x-payment": "stub-signed-payment" } });
  };
}

/** Intel stub: a clean, fully covered merchant card and an allowing preflight. */
function intelStub(calls) {
  return async (input) => {
    calls.n += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/merchant_card/")) return Response.json({ wash_flagged: false, wash_confidence: "full" });
    return Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true, seller_wallet: SELLER } });
  };
}

/** Run `fn` with a global fetch that refuses anything but 127.0.0.1: these tests use no network. */
async function loopbackOnly(fn) {
  const real = globalThis.fetch;
  const strays = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1") {
      strays.push(url.origin);
      return Promise.reject(new Error(`no network in this test: ${url.origin}`));
    }
    return real(input, init);
  };
  let result;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(strays, [], "a call left 127.0.0.1");
  return result;
}

for (const breaker of [
  {
    name: "upstream-failure breaker",
    reason: "upstream_failure_breaker",
    env: { KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD: "2" },
    async trip(port) {
      upstream.state.status = 503;
      assert.equal((await chat(port)).status, 503);
      assert.equal((await chat(port)).status, 503);
    },
  },
  {
    name: "request-rate limit",
    reason: "request_rate_limit",
    env: { KILLSWITCH_MAX_REQUESTS_MINUTE: "1" },
    async trip(port) {
      assert.equal((await chat(port)).status, 200);
      assert.equal((await chat(port)).json.error.code, "request_rate_limit");
    },
  },
]) {
  test(`cross-reader: the .pause the ${breaker.name} writes in a shared TWZRD_STATE_DIR halts twzrd-x402-gate payments, the board fallback included`, async () => {
    const { createTwzrdPayingFetch, TwzrdWashAbortError, twzrdApprovePayment, resolveConfig } = await import(
      "../../twzrd-x402-gate/dist/index.js"
    );
    const stateDir = path.join(dir, "shared-state");
    process.env.TWZRD_STATE_DIR = stateDir;
    Object.assign(process.env, breaker.env);
    const seller = await startSeller();
    servers.push(seller.server);
    const dead = await deadOrigin();

    await loopbackOnly(async () => {
      const paid = { n: 0 };
      const intelCalls = { n: 0 };
      const pay = createTwzrdPayingFetch({
        fetch: intelStub(intelCalls),
        rawFetch: (input, init) => globalThis.fetch(input, init),
        wrapPay: countingPayWrap(paid),
        topUrl: `${seller.base}/top`,
        routeUrl: `${seller.base}/route`,
        deliveryCapture: false,
      });

      // Controls, before any trip: the seller is paid, and a dead origin falls back to the board.
      assert.equal((await pay(`${seller.base}/paid`)).status, 200);
      assert.equal(paid.n, 1);
      assert.equal((await pay(dead)).status, 200);
      assert.equal(paid.n, 3, "the fallback paid the board's invoice, then the seller it named");
      assert.deepEqual(seller.hits, ["/paid", "/paid (paid)", "/top", "/route", "/route (paid)", "/paid", "/paid (paid)"]);

      const port = await startKillswitch();
      await breaker.trip(port);
      const pause = checkPauseSwitch(path.join(stateDir, ".pause"));
      assert.equal(pause.paused, true);
      assert.equal(pause.reason, breaker.reason);

      const halted = (e) =>
        e instanceof TwzrdWashAbortError && e.message === `[twzrd] twzrd_payment_paused (${breaker.reason})`;
      seller.hits.length = 0;
      const lookups = intelCalls.n;
      await assert.rejects(() => pay(`${seller.base}/paid`), halted);
      await assert.rejects(() => pay(dead), halted);
      assert.equal(paid.n, 3, "nothing is paid after the trip");
      assert.deepEqual(seller.hits, ["/paid", "/top", "/route"], "the fallback reached the board's 402 and stopped there");
      assert.equal(intelCalls.n, lookups, "no wash lookup for a payment that cannot happen");

      const approval = await twzrdApprovePayment(
        { sellerWallet: SELLER, priceUsdc: 0.01, chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: USDC },
        resolveConfig({ fetch: intelStub(intelCalls) }),
      );
      assert.equal(approval.approved, false);
      assert.match(approval.reason, new RegExp(`^twzrd_payment_paused \\(${breaker.reason}\\)$`));
      assert.equal(intelCalls.n, lookups, "Seat 1 halts before it asks intel");
    });
  });
}

test("receipts pass through: a V7 receipt in Payment-Receipt reaches the client byte for byte and still verifies; a changed one is refused by the verifier, not the proxy", async () => {
  const { verifyReceiptBinding } = await import("../../twzrd-x402-gate/dist/index.js");
  const fixture = new URL("../../twzrd-x402-gate/test/fixtures/intel-receipt-v7.json", import.meta.url);
  const receipt = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const control = verifyReceiptBinding(receipt);
  assert.equal(control.ok, true, "control: the fixture verifies under the pinned issuer key");
  assert.equal(control.version, "v7");
  const changed = structuredClone(receipt);
  changed.preimage.score += 1;

  // Both breakers on: the pass-through does not depend on them.
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "3";
  process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "10";
  const port = await startKillswitch();
  const throughProxy = async (r) => {
    const sent = Buffer.from(JSON.stringify(r)).toString("base64url");
    upstream.state.headers = { "Payment-Receipt": sent };
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": "stub-signed-payment" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.arrayBuffer();
    assert.equal(res.status, 200);
    const got = res.headers.get("payment-receipt");
    assert.equal(got, sent, "the header arrives byte for byte");
    return verifyReceiptBinding(JSON.parse(Buffer.from(got, "base64url").toString("utf8")));
  };
  assert.deepEqual(await throughProxy(receipt), control);
  const refused = await throughProxy(changed);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "receipt.leaf does not match the leaf recomputed from the receipt's fields");
  assert.equal(upstream.state.hits, 2);
});
