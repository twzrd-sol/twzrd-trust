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

function startUpstream() {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.hits++;
      res.writeHead(200, { "content-type": "application/json" });
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
