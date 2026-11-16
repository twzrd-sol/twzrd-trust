// Conformance vectors for the proxy's halts: the three spend caps, the opt-in
// upstream-failure breaker and request-rate limit (src/breakers.ts), and what
// each writes to `.pause` and the ledger. The cross-reader proof (a breaker's
// `.pause` halts the payment gate) is in binding-plane.test.mjs.
// Offline: a stub upstream on 127.0.0.1:0. No API key, no network, no spend.
// Run with `npm test` (builds dist first).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { BREAKER_MODEL, createServer } from "../dist/index.js";
import { checkPauseSwitch, writePauseSwitch } from "../dist/gate.js";
import { verifyLedgerFile } from "../dist/chain.js";

const ORIGINAL_CWD = process.cwd();

/**
 * Stub upstream. Each request takes the next step from `state.queue`, or
 * `state.fallback` when the queue is empty. A step is `{ status }`, plus
 * optional `delayMs`, `destroy` (drop the connection), `usage` and `before`
 * (run while the call is in flight, before the answer). A 2xx carries usage
 * and echoes the requested model.
 */
function startUpstream() {
  const state = { hits: 0, queue: [], fallback: { status: 200 }, timers: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.hits++;
      let model = "gpt-4o-mini";
      try {
        model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model ?? model;
      } catch {
        /* bodiless session-management call */
      }
      const step = state.queue.length > 0 ? state.queue.shift() : state.fallback;
      step.before?.();
      if (step.destroy) {
        req.socket.destroy();
        return;
      }
      const send = () => {
        if (res.destroyed) return;
        const ok = step.status >= 200 && step.status < 300;
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            ok
              ? {
                  id: "chatcmpl-stub",
                  model,
                  choices: [{ message: { role: "assistant", content: "ok" } }],
                  usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }
              : { error: { message: `stub ${step.status}` } },
          ),
        );
      };
      if (step.delayMs) state.timers.push(setTimeout(send, step.delayMs));
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

async function readResponse(res) {
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: res.status, json, headers: res.headers };
}

const SMALL = { model: "gpt-4o-mini", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

async function chat(port, { id, body = SMALL, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(id ? { "x-request-id": id } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return readResponse(res);
}

/** An MPP credential as mppx serializes it: `Payment <base64url(JSON)>`. */
function paymentAuth(action) {
  const credential = {
    challenge: { id: "challenge-1", method: "tempo", intent: "session" },
    payload: { action, channelId: "0x" + "ab".repeat(32), cumulativeAmount: "3750", signature: "0x01" },
  };
  return `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;
}

/** A bodiless session-management call: a close or topUp credential, or none. */
async function manage(port, authorization, id) {
  const headers = {};
  if (authorization) headers.authorization = authorization;
  if (id) headers["x-request-id"] = id;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers });
  return readResponse(res);
}

async function health(port) {
  return (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
}

/** Wait until the wall clock is past `unixMs`, the end of a pause. */
function sleepPast(unixMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, unixMs - Date.now()) + 25));
}

let dir;
let upstream;
let servers;

const pauseFile = () => path.join(dir, "data", ".pause");
const ledgerPath = () => path.join(dir, "data", "spend-ledger.jsonl");

function ledgerLines() {
  if (!fs.existsSync(ledgerPath())) return [];
  return fs.readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const tripLines = () => ledgerLines().filter((l) => l.model === BREAKER_MODEL);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-halt-vectors-"));
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
  for (const t of upstream.state.timers) clearTimeout(t);
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

// --- spend caps -----------------------------------------------------------

function seedLedger(lines) {
  const now = Date.now();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    ledgerPath(),
    lines
      .map(({ agoMs, ...extra }) =>
        JSON.stringify({
          timestamp: new Date(now - agoMs).toISOString(),
          model: "gpt-4o",
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          allowed: true,
          veto_reason: null,
          request_id: "seed",
          ...extra,
        }),
      )
      .join("\n") + "\n",
  );
}

for (const cap of [
  {
    name: "tokens per minute",
    env: { KILLSWITCH_MAX_TOKENS_MINUTE: "1000" },
    // 900 tokens in this minute; the call (200 + its bytes) fits alone, not on top.
    seed: [{ agoMs: 5_000, total_tokens: 900 }],
    body: { model: "gpt-4o-mini", max_tokens: 200, messages: [{ role: "user", content: "hi" }] },
    message: /^Token-per-minute limit 1000 would be exceeded$/,
    windowMs: 60_000,
  },
  {
    name: "dollars per hour",
    env: { KILLSWITCH_MAX_USD_HOUR: "5" },
    seed: [{ agoMs: 10 * 60_000, cost_usd: 6 }],
    body: SMALL,
    message: /^Hourly limit \$5\.00 /,
    windowMs: 3_600_000,
  },
  {
    name: "dollars per day",
    env: { KILLSWITCH_MAX_USD_DAY: "25" },
    // Two hours ago: outside the hour, inside the day.
    seed: [{ agoMs: 2 * 3_600_000, cost_usd: 30 }],
    body: SMALL,
    message: /^Daily limit \$25\.00 /,
    windowMs: 86_400_000,
  },
]) {
  test(`spend cap, ${cap.name}: refused 429 budget_exceeded before upstream; .pause for ${cap.windowMs / 1000} s halts what follows`, async () => {
    Object.assign(process.env, cap.env);
    seedLedger(cap.seed);
    const port = await startKillswitch();

    const before = Date.now();
    const r = await chat(port, { id: "cap-1", body: cap.body });
    const after = Date.now();
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, "budget_exceeded");
    assert.match(r.json.error.message, cap.message);
    assert.equal(upstream.state.hits, 0);

    const pause = checkPauseSwitch(pauseFile());
    assert.equal(pause.paused, true);
    assert.equal(pause.reason, "budget_exceeded");
    assert.equal(pause.decisionId, "cap-1");
    assert.ok(pause.untilUnixMs >= before + cap.windowMs && pause.untilUnixMs <= after + cap.windowMs);

    // A call that fits every cap is still refused while the pause is in force.
    const next = await chat(port, { id: "cap-2", body: { ...SMALL, max_tokens: 1 } });
    assert.equal(next.status, 429);
    assert.equal(upstream.state.hits, 0);
    assert.equal((await health(port)).paused, true);
  });
}

// --- breakers: off by default ----------------------------------------------

test("both breakers are off by default: twenty 503s in a row trip nothing, and /healthz has no breakers block", async () => {
  upstream.state.fallback = { status: 503 };
  const port = await startKillswitch();
  for (let i = 0; i < 20; i++) assert.equal((await chat(port)).status, 503);
  assert.equal(upstream.state.hits, 20);
  assert.equal(fs.existsSync(pauseFile()), false);
  const h = await health(port);
  assert.equal(h.paused, false);
  assert.equal("breakers" in h, false);
  assert.deepEqual(ledgerLines(), [], "an answered non-2xx without usage writes no line");
});

// --- upstream-failure breaker ----------------------------------------------

test("upstream-failure breaker: the threshold-th consecutive failure writes .pause for the cooldown and a (breaker) line; the next call is refused before upstream", async () => {
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "3";
  process.env.KILLSWITCH_UPSTREAM_FAILURE_COOLDOWN_MS = "60000";
  upstream.state.fallback = { status: 503 };
  const port = await startKillswitch();
  assert.deepEqual((await health(port)).breakers, {
    upstream_failure: { state: "closed", consecutive_failures: 0, threshold: 3, cooldown_ms: 60000 },
  });

  assert.equal((await chat(port, { id: "f-1" })).status, 503);
  assert.equal((await chat(port, { id: "f-2" })).status, 503);
  assert.equal((await health(port)).breakers.upstream_failure.consecutive_failures, 2);
  assert.equal(fs.existsSync(pauseFile()), false, "below the threshold nothing is written");

  const before = Date.now();
  assert.equal((await chat(port, { id: "f-3" })).status, 503, "the tripping call's own answer is passed through");
  const after = Date.now();
  const pause = checkPauseSwitch(pauseFile());
  assert.equal(pause.paused, true);
  assert.equal(pause.reason, "upstream_failure_breaker");
  assert.equal(pause.decisionId, "f-3");
  assert.ok(pause.untilUnixMs >= before + 60_000 && pause.untilUnixMs <= after + 60_000);

  const halted = await chat(port, { id: "f-4" });
  assert.equal(halted.status, 429);
  assert.equal(halted.json.error.code, "payment_gate_halt");
  assert.equal(halted.json.error.decision_id, "f-3");
  assert.equal(halted.json.error.message, "Payment gate pause active: upstream_failure_breaker");
  assert.equal(upstream.state.hits, 3);
  assert.equal(fs.existsSync(path.join(dir, "data", ".kill")), false, "a breaker never writes .kill");

  const h = await health(port);
  assert.equal(h.paused, true);
  assert.equal(h.pause_reason, "upstream_failure_breaker");
  assert.equal(h.breakers.upstream_failure.state, "open");

  const lines = ledgerLines();
  assert.equal(lines.length, 2, "the 503s wrote nothing; the trip and the refusal wrote one line each");
  const [trip, veto] = lines;
  assert.equal(trip.model, BREAKER_MODEL);
  assert.equal(trip.allowed, false);
  assert.equal(trip.cost_usd, 0);
  assert.equal(trip.total_tokens, 0);
  assert.equal(trip.veto_reason, "upstream_failure_breaker");
  assert.equal(trip.request_id, "f-3");
  assert.deepEqual(trip.breaker, {
    name: "upstream_failure",
    event: "trip",
    reason: "3 consecutive upstream failures; the last was upstream_status_503",
    pause_until_unix_ms: pause.untilUnixMs,
    consecutive_failures: 3,
    threshold: 3,
    cooldown_ms: 60000,
  });
  assert.equal(veto.veto_reason, "payment_gate_halt");
  assert.equal(veto.request_id, "f-4");
  assert.equal("breaker" in veto, false);
  assert.equal(verifyLedgerFile(ledgerPath()).ok, true, "trip lines keep the hash chain whole");
});

test("upstream-failure breaker: half-open after the cooldown; one failure re-trips at once, then one 2xx closes it and the full threshold applies again", async () => {
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "3";
  process.env.KILLSWITCH_UPSTREAM_FAILURE_COOLDOWN_MS = "750";
  upstream.state.fallback = { status: 503 };
  const port = await startKillswitch();

  for (const id of ["a-1", "a-2", "a-3"]) assert.equal((await chat(port, { id })).status, 503);
  let pause = checkPauseSwitch(pauseFile());
  assert.equal(pause.decisionId, "a-3");
  assert.equal((await health(port)).breakers.upstream_failure.state, "open");
  await sleepPast(pause.untilUnixMs);
  assert.equal((await health(port)).breakers.upstream_failure.state, "half_open");

  // Half-open: one failure, not three, re-trips.
  assert.equal((await chat(port, { id: "a-4" })).status, 503);
  pause = checkPauseSwitch(pauseFile());
  assert.equal(pause.paused, true);
  assert.equal(pause.decisionId, "a-4");
  assert.equal((await chat(port, { id: "a-5" })).status, 429);
  assert.equal(upstream.state.hits, 4);

  // Half-open again: one 2xx closes it.
  await sleepPast(pause.untilUnixMs);
  upstream.state.fallback = { status: 200 };
  assert.equal((await chat(port, { id: "a-6" })).status, 200);
  assert.deepEqual((await health(port)).breakers.upstream_failure, {
    state: "closed",
    consecutive_failures: 0,
    threshold: 3,
    cooldown_ms: 750,
  });

  // Closed: two failures do not trip it; the third does.
  upstream.state.fallback = { status: 503 };
  await chat(port, { id: "a-7" });
  await chat(port, { id: "a-8" });
  assert.equal(checkPauseSwitch(pauseFile()).paused, false);
  await chat(port, { id: "a-9" });
  assert.equal(checkPauseSwitch(pauseFile()).decisionId, "a-9");

  assert.deepEqual(
    tripLines().map((l) => [l.request_id, l.breaker.event, l.breaker.consecutive_failures, l.breaker.reason]),
    [
      ["a-3", "trip", 3, "3 consecutive upstream failures; the last was upstream_status_503"],
      ["a-4", "retrip", 1, "a failure while half-open: upstream_status_503"],
      ["a-9", "trip", 3, "3 consecutive upstream failures; the last was upstream_status_503"],
    ],
  );
  assert.equal(verifyLedgerFile(ledgerPath()).ok, true);
});

test("upstream-failure breaker: a timeout (504) and a dropped connection (502) count as failures", async () => {
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "3";
  process.env.KILLSWITCH_UPSTREAM_TIMEOUT_MS = "100";
  upstream.state.queue = [{ status: 200, delayMs: 2_000 }, { destroy: true }, { status: 500 }];
  const port = await startKillswitch();

  const timedOut = await chat(port, { id: "t-1" });
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.json.error.code, "upstream_timeout");
  assert.equal((await health(port)).breakers.upstream_failure.consecutive_failures, 1);
  const dropped = await chat(port, { id: "t-2" });
  assert.equal(dropped.status, 502);
  assert.equal(dropped.json.error.code, "upstream_unreachable");
  assert.equal((await health(port)).breakers.upstream_failure.consecutive_failures, 2);
  assert.equal((await chat(port, { id: "t-3" })).status, 500);

  assert.equal(checkPauseSwitch(pauseFile()).reason, "upstream_failure_breaker");
  assert.deepEqual(
    tripLines().map((l) => [l.request_id, l.breaker.reason]),
    [["t-3", "3 consecutive upstream failures; the last was upstream_status_500"]],
  );
});

test("upstream-failure breaker: any non-2xx to a paid call counts; an unpaid 402, 400 or 429 is neutral; a 2xx resets the count", async () => {
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "2";
  const port = await startKillswitch();
  const paid = { "x-payment": "stub-signed-payment" };
  const failures = async () => (await health(port)).breakers.upstream_failure.consecutive_failures;

  // Unpaid: the upstream is up and answering; none of these count.
  for (const status of [402, 400, 429, 402, 402]) {
    upstream.state.queue.push({ status });
    assert.equal((await chat(port)).status, status);
  }
  assert.equal(await failures(), 0);

  // Paid: any non-2xx counts, and a 2xx resets the count.
  upstream.state.queue.push({ status: 402 }, { status: 200 }, { status: 409 });
  assert.equal((await chat(port, { headers: paid })).status, 402);
  assert.equal(await failures(), 1);
  assert.equal((await chat(port, { headers: paid })).status, 200);
  assert.equal(await failures(), 0);
  assert.equal((await chat(port, { headers: paid })).status, 409);
  assert.equal(await failures(), 1);
  assert.equal(fs.existsSync(pauseFile()), false);

  upstream.state.queue.push({ status: 402 });
  assert.equal((await chat(port, { id: "p-trip", headers: paid })).status, 402);
  assert.equal(checkPauseSwitch(pauseFile()).decisionId, "p-trip");
  assert.equal(tripLines()[0].breaker.reason, "2 consecutive upstream failures; the last was paid_request_status_402");
});

test("MPP: a topUp counts for the upstream-failure breaker; a close and a bodiless call without a credential do not", async () => {
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "2";
  upstream.state.fallback = { status: 503 };
  const port = await startKillswitch();

  for (let i = 0; i < 3; i++) {
    assert.equal((await manage(port, paymentAuth("close"))).status, 503);
    assert.equal((await manage(port, null)).status, 503);
  }
  assert.equal(fs.existsSync(pauseFile()), false, "closes and empty calls never trip it");
  assert.equal((await health(port)).breakers.upstream_failure.consecutive_failures, 0);

  assert.equal((await manage(port, paymentAuth("topUp"), "top-1")).status, 503);
  assert.equal((await manage(port, paymentAuth("topUp"), "top-2")).status, 503);
  const pause = checkPauseSwitch(pauseFile());
  assert.equal(pause.reason, "upstream_failure_breaker");
  assert.equal(pause.decisionId, "top-2");

  // As with any pause: a topUp is refused, a close still goes through.
  upstream.state.fallback = { status: 200 };
  const hits = upstream.state.hits;
  const refused = await manage(port, paymentAuth("topUp"));
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "payment_gate_halt");
  assert.equal((await manage(port, paymentAuth("close"))).status, 200);
  assert.equal(upstream.state.hits, hits + 1);

  const trip = tripLines();
  assert.equal(trip.length, 1);
  assert.equal(trip[0].request_id, "top-2");
  assert.equal(verifyLedgerFile(ledgerPath()).ok, true);
});

test("a trip does not shorten a longer pause, or replace a corrupt sentinel, that landed while the call was in flight", async () => {
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "1";
  process.env.KILLSWITCH_UPSTREAM_FAILURE_COOLDOWN_MS = "60000";
  const port = await startKillswitch();

  // An hourly budget pause lands mid-call.
  let hourUntil = null;
  upstream.state.queue.push({
    status: 503,
    before: () => {
      writePauseSwitch(pauseFile(), { ttlMs: 3_600_000, reason: "budget_exceeded", decisionId: "hour-1" });
      hourUntil = checkPauseSwitch(pauseFile()).untilUnixMs;
    },
  });
  assert.equal((await chat(port, { id: "in-1" })).status, 503);
  let pause = checkPauseSwitch(pauseFile());
  assert.equal(pause.reason, "budget_exceeded");
  assert.equal(pause.decisionId, "hour-1");
  assert.equal(pause.untilUnixMs, hourUntil);
  assert.equal(tripLines().at(-1).breaker.pause_until_unix_ms, null, "the trip wrote no pause");

  // Lift it by hand: the breaker is half-open. A corrupt sentinel lands mid-call.
  fs.rmSync(pauseFile());
  upstream.state.queue.push({ status: 503, before: () => fs.writeFileSync(pauseFile(), "{truncated") });
  assert.equal((await chat(port, { id: "in-2" })).status, 503);
  assert.equal(fs.readFileSync(pauseFile(), "utf8"), "{truncated", "a corrupt sentinel halts until a person removes it");
  const retrip = tripLines().at(-1);
  assert.equal(retrip.request_id, "in-2");
  assert.equal(retrip.breaker.event, "retrip");
  assert.equal(retrip.breaker.pause_until_unix_ms, null);
  const halted = await chat(port);
  assert.equal(halted.status, 429);
  assert.match(halted.json.error.message, /corrupt_pause_sentinel/);
});

// --- request-rate limit ------------------------------------------------------

test("request-rate limit: the call over the limit is refused 429 request_rate_limit before upstream, writes .pause for 60 s, and its veto line records the trip", async () => {
  process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "3";
  const port = await startKillswitch();
  assert.deepEqual((await health(port)).breakers, {
    request_rate: { requests_in_window: 0, limit: 3, window_ms: 60000 },
  });

  for (const id of ["r-1", "r-2", "r-3"]) assert.equal((await chat(port, { id })).status, 200);
  assert.equal((await health(port)).breakers.request_rate.requests_in_window, 3);

  const before = Date.now();
  const over = await chat(port, { id: "r-4" });
  const after = Date.now();
  assert.equal(over.status, 429);
  // As the token-per-minute refusal carries tokens in spent_usd/limit_usd, this one carries requests.
  assert.deepEqual(over.json.error, {
    type: "killswitch_veto",
    code: "request_rate_limit",
    message: "Request-rate limit of 3 per 60 s reached; requests are paused for 60 s",
    spent_usd: 3,
    limit_usd: 3,
  });
  assert.equal(upstream.state.hits, 3);

  const pause = checkPauseSwitch(pauseFile());
  assert.equal(pause.reason, "request_rate_limit");
  assert.equal(pause.decisionId, "r-4");
  assert.ok(pause.untilUnixMs >= before + 60_000 && pause.untilUnixMs <= after + 60_000);

  const halted = await chat(port, { id: "r-5" });
  assert.equal(halted.status, 429);
  assert.equal(halted.json.error.code, "payment_gate_halt");
  assert.equal(halted.json.error.decision_id, "r-4");
  assert.equal(upstream.state.hits, 3);
  assert.equal(fs.existsSync(path.join(dir, "data", ".kill")), false, "a breaker never writes .kill");

  const lines = ledgerLines();
  assert.deepEqual(
    lines.map((l) => [l.request_id, l.allowed, l.veto_reason ?? null]),
    [
      ["r-1", true, null],
      ["r-2", true, null],
      ["r-3", true, null],
      ["r-4", false, "request_rate_limit"],
      ["r-5", false, "payment_gate_halt"],
    ],
  );
  assert.deepEqual(lines[3].breaker, {
    name: "request_rate",
    event: "trip",
    reason: "3 requests forwarded in the last 60 s; the limit is 3",
    pause_until_unix_ms: pause.untilUnixMs,
    requests_in_window: 3,
    limit: 3,
    window_ms: 60000,
  });
  assert.equal("breaker" in lines[4], false);
  assert.equal(verifyLedgerFile(ledgerPath()).ok, true);
});

test("request-rate limit: chat completions and topUps share the window; closes are not counted", async () => {
  process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "3";
  const port = await startKillswitch();

  for (let i = 0; i < 5; i++) assert.equal((await manage(port, paymentAuth("close"))).status, 200);
  assert.equal((await health(port)).breakers.request_rate.requests_in_window, 0);
  assert.equal((await chat(port)).status, 200);
  assert.equal((await manage(port, paymentAuth("topUp"))).status, 200);
  assert.equal((await chat(port)).status, 200);
  assert.equal((await health(port)).breakers.request_rate.requests_in_window, 3);

  const over = await manage(port, paymentAuth("topUp"), "top-over");
  assert.equal(over.status, 429);
  assert.equal(over.json.error.code, "request_rate_limit");
  const line = ledgerLines().find((l) => l.request_id === "top-over");
  assert.equal(line.session_action, "topUp");
  assert.equal(line.veto_reason, "request_rate_limit");
  assert.equal(line.breaker.name, "request_rate");
  assert.equal(checkPauseSwitch(pauseFile()).reason, "request_rate_limit");
  // A close still goes through the pause, as with any pause.
  assert.equal((await manage(port, paymentAuth("close"))).status, 200);
});

test("why the request-rate limit exists: at the default limits, tokens per minute does not stop a loop of small $0 calls", async () => {
  process.env.KILLSWITCH_FREE_MODELS = "local/tiny";
  const body = { model: "local/tiny", messages: [{ role: "user", content: "hi" }] };
  let port = await startKillswitch();
  const N = 120;

  // Answered with usage: each line records 15 tokens (the hold was its ~60 bytes).
  for (let i = 0; i < N; i++) assert.equal((await chat(port, { body })).status, 200);
  // Answered without usage (here a 429): the hold is released and nothing is
  // written, so the minute window never grows at all.
  upstream.state.fallback = { status: 429 };
  for (let i = 0; i < N; i++) assert.equal((await chat(port, { body })).status, 429);
  assert.equal(upstream.state.hits, 2 * N, "every call reached the upstream");
  const lines = ledgerLines();
  assert.equal(lines.length, N, "the 429 answers wrote no line");
  assert.equal(lines.reduce((sum, l) => sum + l.total_tokens, 0), 15 * N, "1,800 of the default 100,000 tokens a minute");
  assert.equal(lines.every((l) => l.cost_usd === 0), true);

  // The request-rate limit is what stops it.
  process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "60";
  port = await startKillswitch();
  const hits = upstream.state.hits;
  for (let i = 0; i < 60; i++) assert.equal((await chat(port, { body })).status, 429, "the upstream's own 429");
  const stopped = await chat(port, { body });
  assert.equal(stopped.json.error.code, "request_rate_limit");
  assert.equal(upstream.state.hits, hits + 60);
});

// --- a pause that cannot be written -------------------------------------------

const ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** Point .pause into a directory this process cannot write; ledger and kill file stay writable. */
function lockedPauseDir() {
  const locked = path.join(dir, "locked");
  fs.mkdirSync(locked);
  process.env.KILLSWITCH_PAUSE_FILE = path.join(locked, ".pause");
  fs.chmodSync(locked, 0o555);
  return { file: path.join(locked, ".pause"), unlock: () => fs.chmodSync(locked, 0o755) };
}

test(
  "a rate trip whose .pause cannot be written is held in memory: this process refuses until it ends, and /healthz says so",
  { skip: ROOT && "root ignores directory permissions" },
  async () => {
    const locked = lockedPauseDir();
    try {
      process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "1";
      const port = await startKillswitch();
      assert.equal((await chat(port, { id: "h-1" })).status, 200);

      const over = await chat(port, { id: "h-2" });
      assert.equal(over.status, 429);
      assert.equal(over.json.error.code, "request_rate_limit");
      assert.equal(fs.existsSync(locked.file), false);
      const line = ledgerLines().find((l) => l.request_id === "h-2");
      assert.equal(line.breaker.pause_write_failed, true);
      assert.ok(line.breaker.pause_until_unix_ms > Date.now() + 50_000);

      const held = await chat(port, { id: "h-3" });
      assert.equal(held.status, 429);
      assert.equal(held.json.error.code, "payment_gate_halt");
      assert.equal(held.json.error.decision_id, "h-2");
      assert.equal(
        held.json.error.message,
        "Payment gate pause active: request_rate_limit (held in memory: the pause file could not be written)",
      );
      assert.equal(upstream.state.hits, 1);

      const h = await health(port);
      assert.equal(h.paused, true);
      assert.equal(h.pause_held_in_memory, true);
      assert.equal(h.pause_reason, "request_rate_limit");
      assert.equal(h.pause_decision_id, "h-2");
      assert.equal(h.pause_until_unix_ms, line.breaker.pause_until_unix_ms);
    } finally {
      locked.unlock();
    }
  },
);

test(
  "an upstream trip whose .pause cannot be written is held in memory, ends on time, and the breaker goes half-open",
  { skip: ROOT && "root ignores directory permissions" },
  async () => {
    const locked = lockedPauseDir();
    try {
      process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "1";
      process.env.KILLSWITCH_UPSTREAM_FAILURE_COOLDOWN_MS = "750";
      upstream.state.queue.push({ status: 503 });
      const port = await startKillswitch();
      assert.equal((await chat(port, { id: "u-1" })).status, 503);
      const trip = tripLines()[0];
      assert.equal(trip.breaker.pause_write_failed, true);

      assert.equal((await chat(port)).status, 429);
      assert.equal(upstream.state.hits, 1);
      assert.equal((await health(port)).breakers.upstream_failure.state, "open");

      await sleepPast(trip.breaker.pause_until_unix_ms);
      const h = await health(port);
      assert.equal(h.paused, false);
      assert.equal(h.breakers.upstream_failure.state, "half_open");
      assert.equal((await chat(port)).status, 200, "the stub's fallback answers 200");
      assert.equal((await health(port)).breakers.upstream_failure.state, "closed");
    } finally {
      locked.unlock();
    }
  },
);
