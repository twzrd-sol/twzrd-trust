// MPP session management passthrough and flat per-request pricing.
// Offline: a stub seller on 127.0.0.1:0 stands in for an MPP session seller.
// No API key, no network, no spend. Run with `npm test` (builds dist first).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, SESSION_MANAGEMENT_MODEL } from "../dist/index.js";
import { createBudgetGate } from "../dist/api.js";
import { evaluateSessionManagement, requestEstimate, writePauseSwitch } from "../dist/gate.js";
import { costUsd, parseModelRates, pessimisticRequestCostUsd, priceFor } from "../dist/pricing.js";
import { paymentCredentialAction, sessionManagementKind } from "../dist/proxy.js";
import { runVerifyLedger } from "../dist/chain.js";

const SELLER_MODEL = "infer-mpp/twzrd-coder";
// 750 base units of a 6-decimal stablecoin.
const VOUCHER_USD = 0.00075;
const ORIGINAL_CWD = process.cwd();

/** An MPP credential as mppx serializes it: `Payment <base64url(JSON)>`. */
function paymentAuth(action, extra = {}) {
  const credential = {
    challenge: { id: "challenge-1", method: "tempo", intent: "session" },
    payload: { action, channelId: "0x" + "ab".repeat(32), cumulativeAmount: "3750", signature: "0x01", ...extra },
  };
  return `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;
}

/**
 * Stub MPP session seller. Management credentials (close/topUp) get 204 and
 * a receipt; a request with no credential gets a 402 challenge; a paid chat
 * request gets 200, usage (unless `noUsage`) and a receipt.
 */
function startSeller() {
  const state = { hits: [], noUsage: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const auth = req.headers.authorization ?? "";
      state.hits.push({ body, auth, headers: { ...req.headers } });
      const action = paymentCredentialAction({ authorization: auth });
      if (action === "close" || action === "topUp") {
        res.writeHead(204, { "payment-receipt": `receipt-${action}` });
        res.end();
        return;
      }
      if (!/^payment\s/i.test(auth)) {
        res.writeHead(402, { "content-type": "application/json", "www-authenticate": 'Payment id="challenge-1"' });
        res.end(JSON.stringify({ error: { message: "Payment required" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "payment-receipt": "receipt-voucher" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-seller",
          model: SELLER_MODEL,
          choices: [{ message: { role: "assistant", content: "ok" } }],
          ...(state.noUsage ? {} : { usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } }),
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function post(port, { body, headers = {} } = {}) {
  const init = { method: "POST", headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: res.status, text, json, headers: res.headers };
}

async function health(port) {
  return (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
}

let dir;
let seller;
let servers;

function ledgerFile() {
  return path.join(dir, "spend-ledger.jsonl");
}

function readLedger() {
  if (!fs.existsSync(ledgerFile())) return [];
  return fs.readFileSync(ledgerFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-session-"));
  process.chdir(dir);
  for (const k of Object.keys(process.env)) if (k.startsWith("KILLSWITCH_")) delete process.env[k];
  seller = await startSeller();
  process.env.OPENAI_API_KEY = "sk-test-offline";
  process.env.KILLSWITCH_UPSTREAM_BASE_URL = `http://127.0.0.1:${seller.port}/v1`;
  process.env.KILLSWITCH_LEDGER_PATH = ledgerFile();
  process.env.KILLSWITCH_KILL_FILE = path.join(dir, ".kill");
  process.env.KILLSWITCH_PAUSE_FILE = path.join(dir, ".pause");
  process.env.KILLSWITCH_MODEL_RATES = JSON.stringify({ [SELLER_MODEL]: { in: 0, out: 0, per_request: VOUCHER_USD } });
  servers = [];
});

afterEach(async () => {
  for (const s of servers) await close(s);
  await close(seller.server);
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startKillswitch() {
  const server = createServer();
  servers.push(server);
  return listen(server);
}

const chatBody = { model: SELLER_MODEL, max_tokens: 64, messages: [{ role: "user", content: "write a haiku" }] };

// --- flat per-request pricing ---------------------------------------------

test("parseModelRates accepts {in, out, per_request} and keeps {in, out} rows unchanged", () => {
  const rates = parseModelRates({
    flat: { in: 0, out: 0, per_request: VOUCHER_USD },
    both: { in: 1, out: 2, per_request: 0.01 },
    tokens: { in: 1, out: 2 },
  });
  assert.deepEqual({ ...rates.flat }, { inputPerMTok: 0, outputPerMTok: 0, perRequestUsd: VOUCHER_USD });
  assert.deepEqual({ ...rates.both }, { inputPerMTok: 1, outputPerMTok: 2, perRequestUsd: 0.01 });
  assert.deepEqual({ ...rates.tokens }, { inputPerMTok: 1, outputPerMTok: 2 });
  assert.equal(Object.hasOwn(rates.tokens, "perRequestUsd"), false);
});

test("parseModelRates refuses a bad per_request and still requires in and out", () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "0.00075", null, {}]) {
    assert.throws(() => parseModelRates({ m: { in: 0, out: 0, per_request: bad } }), /per_request must be a finite nonnegative number/);
  }
  assert.throws(() => parseModelRates({ m: { per_request: VOUCHER_USD } }), /in\/out must be finite nonnegative numbers/);
  assert.throws(() => parseModelRates({ m: { in: 0, per_request: VOUCHER_USD } }), /in\/out/);
  assert.throws(() => parseModelRates({ m: { in: 0, out: 0, per_request: VOUCHER_USD, extra: 1 } }), /in\/out/);
  assert.throws(() => parseModelRates({ m: { in: 0, out: 0, perRequestUsd: VOUCHER_USD } }), /in\/out/);
});

test("a flat-only row holds and costs exactly its flat amount, whatever the size or credential", () => {
  const rates = parseModelRates({ [SELLER_MODEL]: { in: 0, out: 0, per_request: VOUCHER_USD } });
  const cap = 0.5;
  for (const zeroPriceModels of [null, [], [SELLER_MODEL]]) {
    for (const maxTokens of [0, 64, 256, 100_000, null]) {
      for (const prompt of [null, { bytes: 120, textOnly: true }, { bytes: 120, textOnly: false }, { bytes: 5_000_000, textOnly: false }]) {
        const est = requestEstimate(SELLER_MODEL, maxTokens, cap, zeroPriceModels, rates, prompt);
        assert.equal(est.usd, VOUCHER_USD, JSON.stringify({ zeroPriceModels, maxTokens, prompt }));
      }
    }
    assert.equal(costUsd(SELLER_MODEL, 0, 0, zeroPriceModels, rates), VOUCHER_USD);
    assert.equal(costUsd(SELLER_MODEL, 40_000, 12_000, zeroPriceModels, rates), VOUCHER_USD);
    assert.equal(pessimisticRequestCostUsd(SELLER_MODEL, 256, zeroPriceModels, rates), VOUCHER_USD);
  }
  // Unbounded output still counts unbounded tokens (the per-minute limit refuses it); dollars stay flat.
  const inf = requestEstimate(SELLER_MODEL, Number.POSITIVE_INFINITY, cap, [], rates, null);
  assert.equal(inf.tokens, Number.POSITIVE_INFINITY);
  assert.equal(inf.usd, VOUCHER_USD);
  // Tokens are still counted for the per-minute limit.
  assert.equal(requestEstimate(SELLER_MODEL, 64, cap, [], rates, { bytes: 100, textOnly: true }).tokens, 164);
});

test("a token row with a flat part adds the flat amount; the per-request-cap floor still applies", () => {
  const rates = parseModelRates({ both: { in: 1, out: 2, per_request: 0.01 } });
  const tokenUsd = (1000 * 2 + 100 * 1) / 1_000_000;
  const bounded = requestEstimate("both", 1000, 0.5, null, rates, { bytes: 100, textOnly: true });
  assert.equal(bounded.usd, tokenUsd + 0.01);
  const unbounded = requestEstimate("both", 1000, 0.5, null, rates, { bytes: 100, textOnly: false });
  assert.equal(unbounded.usd, 0.5);
  const noMax = requestEstimate("both", null, 0.5, null, rates, { bytes: 100, textOnly: true });
  assert.equal(noMax.usd, 0.5);
  assert.equal(costUsd("both", 1000, 500, null, rates), (1000 * 1 + 500 * 2) / 1_000_000 + 0.01);
});

test("a $0 row without a flat part is still free, and a flat row is not a free row", () => {
  const rates = parseModelRates({ zero: { in: 0, out: 0 }, flat: { in: 0, out: 0, per_request: 0.001 } });
  assert.equal(requestEstimate("zero", 256, 0.5, null, rates, null).usd, 0);
  assert.equal(requestEstimate("zero", null, 0.5, null, rates, null).usd, 0);
  assert.equal(costUsd("zero", 1000, 1000, null, rates), 0);
  // A suffixed id of a flat row is a priced id: listing it as free does not make it $0,
  // and its fallback keeps the flat part.
  assert.equal(priceFor("flat-v2", ["flat-v2"], rates).known, false);
  assert.ok(costUsd("flat-v2", 1000, 0, ["flat-v2"], rates) > 0.001);
  assert.equal(costUsd("flat:nitro", 0, 0, null, rates), 0.001);
});

test("createBudgetGate accepts perRequestUsd, snapshots it, and refuses a bad one", () => {
  const limits = { maxTokensPerMinute: 100_000, maxUsdPerHour: 5, maxUsdPerDay: 25, maxCostPerRequestUsd: 0.5 };
  const modelRates = { [SELLER_MODEL]: { inputPerMTok: 0, outputPerMTok: 0, perRequestUsd: VOUCHER_USD } };
  const gate = createBudgetGate({ ...limits, modelRates });
  modelRates[SELLER_MODEL].perRequestUsd = 0;
  assert.equal(gate.estimate({ model: SELLER_MODEL, maxTokens: 64 }).usd, VOUCHER_USD);
  assert.equal(gate.estimate({ model: SELLER_MODEL, maxTokens: null, zeroPriceModels: [] }).usd, VOUCHER_USD);
  const window = { minuteTokens: 0, hourUsd: 5 - VOUCHER_USD / 2, dayUsd: 0 };
  assert.equal(gate.evaluate({ model: SELLER_MODEL, maxTokens: 64, window }).code, "budget_exceeded");
  for (const bad of [-1, Number.NaN, "0.00075", null]) {
    assert.throws(
      () => createBudgetGate({ ...limits, modelRates: { demo: { inputPerMTok: 0, outputPerMTok: 0, perRequestUsd: bad } } }),
      /modelRates\.demo\.perRequestUsd must be a finite non-negative number/,
    );
  }
  // Without perRequestUsd the row is the 0.2.1 shape.
  const plain = createBudgetGate({ ...limits, modelRates: { demo: { inputPerMTok: 0, outputPerMTok: 0 } } });
  assert.equal(plain.estimate({ model: "demo", maxTokens: 64 }).usd, 0);
});

test("proxy: five paid requests on a flat row ledger 5 x $0.00075 = 3,750 base units; the unpaid 402 ledgers nothing", async () => {
  const port = await startKillswitch();
  const unpaid = await post(port, { body: chatBody });
  assert.equal(unpaid.status, 402);
  assert.match(unpaid.headers.get("www-authenticate") ?? "", /^Payment /);
  assert.equal(readLedger().length, 0);

  for (let i = 0; i < 5; i++) {
    const action = i === 0 ? "open" : "voucher";
    const r = await post(port, { body: chatBody, headers: { authorization: paymentAuth(action, { cumulativeAmount: String(750 * (i + 1)) }) } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("payment-receipt"), "receipt-voucher");
  }
  const lines = readLedger();
  assert.equal(lines.length, 5);
  for (const l of lines) {
    assert.equal(l.allowed, true);
    assert.equal(l.metered, "usage");
    assert.equal(l.cost_usd, VOUCHER_USD);
  }
  const baseUnits = lines.reduce((n, l) => n + Math.round(l.cost_usd * 1_000_000), 0);
  assert.equal(baseUnits, 3750);
  assert.equal((await health(port)).in_flight, 0);
});

test("proxy: a paid flat-row answer without usage ledgers the held flat amount", async () => {
  seller.state.noUsage = true;
  const port = await startKillswitch();
  const r = await post(port, { body: chatBody, headers: { authorization: paymentAuth("voucher") } });
  assert.equal(r.status, 200);
  const [line] = readLedger();
  assert.equal(line.metered, "held_estimate");
  assert.equal(line.cost_usd, VOUCHER_USD);
});

// --- session management passthrough --------------------------------------

test("paymentCredentialAction reads the payload action and nothing else", () => {
  assert.equal(paymentCredentialAction({ authorization: paymentAuth("close") }), "close");
  assert.equal(paymentCredentialAction({ authorization: paymentAuth("topUp") }), "topUp");
  assert.equal(paymentCredentialAction({ authorization: paymentAuth("voucher") }), "voucher");
  assert.equal(paymentCredentialAction({ authorization: paymentAuth("close").replace(/^Payment/, "payment") }), "close");
  // Standard base64 with padding decodes too.
  const std = Buffer.from(JSON.stringify({ challenge: {}, payload: { action: "close" } })).toString("base64");
  assert.equal(paymentCredentialAction({ authorization: `Payment ${std}` }), "close");
  for (const auth of [
    undefined,
    "",
    "Bearer sk-test",
    "Payment",
    "Payment !!!",
    `Payment ${Buffer.from("not json").toString("base64url")}`,
    `Payment ${Buffer.from(JSON.stringify({ payload: "close" })).toString("base64url")}`,
    `Payment ${Buffer.from(JSON.stringify({ payload: ["close"] })).toString("base64url")}`,
    `Payment ${Buffer.from(JSON.stringify({ action: "close" })).toString("base64url")}`,
    `Bearer sk-test, ${paymentAuth("close")}`,
    `Payment ${"A".repeat(64 * 1024)}`,
  ]) {
    assert.equal(paymentCredentialAction({ authorization: auth }), null, String(auth).slice(0, 60));
  }
});

test("sessionManagementKind: close/topUp by credential, empty without one, refuse a bodiless spend", () => {
  assert.equal(sessionManagementKind({ authorization: paymentAuth("close") }, ""), "close");
  assert.equal(sessionManagementKind({ authorization: paymentAuth("topUp") }, JSON.stringify(chatBody)), "topUp");
  assert.equal(sessionManagementKind({}, ""), "empty");
  assert.equal(sessionManagementKind({ authorization: "Bearer sk-x" }, "  \n"), "empty");
  assert.equal(sessionManagementKind({ authorization: paymentAuth("voucher") }, ""), "refuse");
  assert.equal(sessionManagementKind({ authorization: paymentAuth("open") }, ""), "refuse");
  assert.equal(sessionManagementKind({ authorization: "Payment garbage" }, ""), "refuse");
  assert.equal(sessionManagementKind({ "x-payment": "abc" }, ""), "refuse");
  assert.equal(sessionManagementKind({ authorization: paymentAuth("voucher") }, JSON.stringify(chatBody)), null);
  assert.equal(sessionManagementKind({}, JSON.stringify(chatBody)), null);
});

test("evaluateSessionManagement: the kill file refuses all; a pause refuses topUp only", () => {
  const base = { window: { minuteTokens: 0, hourUsd: 9, dayUsd: 9 }, maxUsdPerHour: 5, paused: false, killed: false };
  for (const action of ["close", "topUp", "empty"]) {
    assert.equal(evaluateSessionManagement({ ...base, action }).allowed, true);
    const killed = evaluateSessionManagement({ ...base, action, killed: true, paused: true });
    assert.equal(killed.code, "kill_switch");
    assert.equal(killed.status, 403);
  }
  const paused = { ...base, paused: true, pauseReason: "budget_exceeded", pauseDecisionId: "d-1" };
  assert.equal(evaluateSessionManagement({ ...paused, action: "close" }).allowed, true);
  assert.equal(evaluateSessionManagement({ ...paused, action: "empty" }).allowed, true);
  const topUp = evaluateSessionManagement({ ...paused, action: "topUp" });
  assert.equal(topUp.code, "payment_gate_halt");
  assert.equal(topUp.status, 429);
  assert.equal(topUp.decisionId, "d-1");
});

test("proxy: an empty-body close passes through with no hold, its credential and receipt intact", async () => {
  const port = await startKillswitch();
  const auth = paymentAuth("close");
  const r = await post(port, { headers: { authorization: auth, "x-request-id": "close-1" } });
  assert.equal(r.status, 204);
  assert.equal(r.text, "");
  assert.equal(r.headers.get("payment-receipt"), "receipt-close");
  assert.equal(seller.state.hits.length, 1);
  const hit = seller.state.hits[0];
  assert.equal(hit.body, "");
  assert.equal(hit.auth, auth, "the Payment credential replaces the operator key");
  assert.equal(hit.headers["content-type"], undefined);
  assert.equal(hit.headers["x-killswitch-request-id"], "close-1");

  const lines = readLedger();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].session_action, "close");
  assert.equal(lines[0].model, SESSION_MANAGEMENT_MODEL);
  assert.equal(lines[0].allowed, true);
  assert.equal(lines[0].cost_usd, 0);
  assert.equal(lines[0].request_id, "close-1");
  const h = await health(port);
  assert.equal(h.in_flight, 0);
  assert.equal(h.hour_usd, 0);
});

test("proxy: a topUp passes without a hold and any body it carries is dropped", async () => {
  const port = await startKillswitch();
  const r = await post(port, { body: chatBody, headers: { authorization: paymentAuth("topUp") } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("payment-receipt"), "receipt-topUp");
  assert.equal(seller.state.hits.length, 1);
  assert.equal(seller.state.hits[0].body, "", "no inference body reaches the seller on a management call");
  const [line] = readLedger();
  assert.equal(line.session_action, "topUp");
  assert.equal(line.cost_usd, 0);
});

test("proxy: a close passes a spent hourly budget and its pause, while a voucher request is refused", async () => {
  process.env.KILLSWITCH_MAX_USD_HOUR = "0.001";
  const port = await startKillswitch();
  // The open fits ($0.00075); the next voucher would take the hour to $0.0015, over $0.001.
  assert.equal((await post(port, { body: chatBody, headers: { authorization: paymentAuth("open") } })).status, 200);
  const refused = await post(port, { body: chatBody, headers: { authorization: paymentAuth("voucher") } });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "budget_exceeded");
  assert.ok(fs.existsSync(path.join(dir, ".pause")), "the budget refusal wrote its pause");

  const closed = await post(port, { headers: { authorization: paymentAuth("close") } });
  assert.equal(closed.status, 204);
  const topUp = await post(port, { headers: { authorization: paymentAuth("topUp") } });
  assert.equal(topUp.status, 429);
  assert.equal(topUp.json.error.code, "payment_gate_halt");
  const actions = readLedger().map((l) => [l.session_action ?? null, l.allowed, l.veto_reason]);
  assert.deepEqual(actions, [
    [null, true, null],
    [null, false, "budget_exceeded"],
    ["close", true, null],
    ["topUp", false, "payment_gate_halt"],
  ]);
});

test("proxy: the kill file refuses a close and a topUp before upstream", async () => {
  fs.writeFileSync(path.join(dir, ".kill"), "");
  const port = await startKillswitch();
  for (const action of ["close", "topUp"]) {
    const r = await post(port, { headers: { authorization: paymentAuth(action) } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, "kill_switch");
  }
  const empty = await post(port, {});
  assert.equal(empty.status, 403);
  assert.equal(seller.state.hits.length, 0);
  assert.deepEqual(
    readLedger().map((l) => [l.session_action, l.allowed, l.veto_reason, l.cost_usd]),
    [
      ["close", false, "kill_switch", 0],
      ["topUp", false, "kill_switch", 0],
      ["empty", false, "kill_switch", 0],
    ],
  );
});

test("proxy: a pause (non-budget) lets a close through and refuses a topUp", async () => {
  writePauseSwitch(path.join(dir, ".pause"), { ttlMs: 60_000, reason: "operator_hold", decisionId: "op-1" });
  const port = await startKillswitch();
  assert.equal((await post(port, { headers: { authorization: paymentAuth("close") } })).status, 204);
  const topUp = await post(port, { headers: { authorization: paymentAuth("topUp") } });
  assert.equal(topUp.status, 429);
  assert.equal(topUp.json.error.code, "payment_gate_halt");
  assert.equal(topUp.json.error.decision_id, "op-1");
  assert.equal(seller.state.hits.length, 1);
});

test("proxy: an empty body with no credential is forwarded bodiless, and the seller's 402 challenge comes back", async () => {
  const port = await startKillswitch();
  const r = await post(port, {});
  assert.equal(r.status, 402);
  assert.match(r.headers.get("www-authenticate") ?? "", /^Payment /);
  assert.equal(seller.state.hits.length, 1);
  assert.equal(seller.state.hits[0].body, "");
  assert.equal(seller.state.hits[0].auth, "Bearer sk-test-offline");
  const [line] = readLedger();
  assert.equal(line.session_action, "empty");
  assert.equal(line.cost_usd, 0);
});

test("proxy: an empty body carrying a voucher, an open or an x402 header is refused (400) and never reaches upstream", async () => {
  const port = await startKillswitch();
  for (const headers of [
    { authorization: paymentAuth("voucher") },
    { authorization: paymentAuth("open") },
    { authorization: "Payment not-a-credential" },
    { "x-payment": "eyJ4IjoxfQ" },
    { "payment-signature": "sig" },
  ]) {
    const r = await post(port, { headers });
    assert.equal(r.status, 400, JSON.stringify(headers));
    assert.equal(r.json.error.type, "invalid_request");
  }
  assert.equal(seller.state.hits.length, 0);
  assert.equal(readLedger().length, 0);
});

test("proxy: a full session (402, open, 4 vouchers, close) ledgers 3,750 base units and a verifiable chain", async () => {
  const port = await startKillswitch();
  assert.equal((await post(port, { body: chatBody })).status, 402);
  for (let i = 0; i < 5; i++) {
    const action = i === 0 ? "open" : "voucher";
    assert.equal((await post(port, { body: chatBody, headers: { authorization: paymentAuth(action) } })).status, 200);
  }
  assert.equal((await post(port, { headers: { authorization: paymentAuth("close") } })).status, 204);
  const lines = readLedger();
  assert.equal(lines.length, 6);
  assert.equal(lines.filter((l) => l.session_action === undefined).length, 5);
  assert.equal(lines[5].session_action, "close");
  assert.equal(lines.reduce((n, l) => n + Math.round(l.cost_usd * 1_000_000), 0), 3750);
  const out = [];
  const code = runVerifyLedger(["--strict", ledgerFile()], (line) => out.push(line), (line) => out.push(line));
  assert.equal(code, 0, out.join("\n"));
});
