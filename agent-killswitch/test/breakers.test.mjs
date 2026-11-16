// Offline unit tests for the opt-in breakers (src/breakers.ts) and their
// configuration. The proxy-level vectors are in halt-vectors.test.mjs; the
// cross-reader proof (a breaker's .pause halts the payment gate) is in
// binding-plane.test.mjs. Run with `npm test` (builds dist first).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyUpstreamOutcome,
  MAX_UPSTREAM_FAILURE_COOLDOWN_MS,
  RequestRateLimiter,
  UpstreamFailureBreaker,
} from "../dist/breakers.js";
import { loadConfig } from "../dist/config.js";

const answered = (status) => ({ status, usage: null, outcome: "answered" });
const FAIL = { kind: "failure", detail: "upstream_status_503" };
const OK = { kind: "success" };
const NEUTRAL = { kind: "neutral" };

test("classifyUpstreamOutcome: what counts as an upstream failure", () => {
  const cases = [
    // [result, paid, expected]
    [null, false, { kind: "failure", detail: "upstream_error" }],
    [{ status: 504, usage: null, outcome: "timeout" }, false, { kind: "failure", detail: "upstream_timeout" }],
    [{ status: 502, usage: null, outcome: "unreachable" }, false, { kind: "failure", detail: "upstream_unreachable" }],
    [answered(200), false, { kind: "success" }],
    [answered(204), true, { kind: "success" }],
    [answered(500), false, { kind: "failure", detail: "upstream_status_500" }],
    [answered(503), true, { kind: "failure", detail: "upstream_status_503" }],
    // Unpaid non-2xx below 500: the upstream is up (a 402 challenge, a 400, a 429).
    [answered(402), false, { kind: "neutral" }],
    [answered(400), false, { kind: "neutral" }],
    [answered(429), false, { kind: "neutral" }],
    // Any non-2xx to a request that carried a payment credential.
    [answered(402), true, { kind: "failure", detail: "paid_request_status_402" }],
    [answered(429), true, { kind: "failure", detail: "paid_request_status_429" }],
    [answered(301), true, { kind: "failure", detail: "paid_request_status_301" }],
  ];
  for (const [result, paid, expected] of cases) {
    assert.deepEqual(classifyUpstreamOutcome(result, paid), expected, JSON.stringify({ result, paid }));
  }
});

test("UpstreamFailureBreaker: consecutive failures trip it; a 2xx resets the count; neutral answers do neither", () => {
  const b = new UpstreamFailureBreaker(3, 60_000);
  assert.equal(b.state(false), "closed");
  assert.equal(b.observe(b.ticket(), FAIL), null);
  assert.equal(b.observe(b.ticket(), FAIL), null);
  assert.equal(b.observe(b.ticket(), OK), null, "a 2xx resets the count");
  assert.equal(b.consecutiveFailures, 0);
  assert.equal(b.observe(b.ticket(), FAIL), null);
  assert.equal(b.observe(b.ticket(), NEUTRAL), null, "neutral neither counts nor resets");
  assert.equal(b.consecutiveFailures, 1);
  assert.equal(b.observe(b.ticket(), FAIL), null);
  assert.deepEqual(b.observe(b.ticket(), FAIL), {
    event: "trip",
    consecutiveFailures: 3,
    detail: "upstream_status_503",
  });
  assert.equal(b.state(true), "open", "tripped with a pause in force");
  assert.equal(b.state(false), "half_open", "tripped with no pause in force");
});

test("UpstreamFailureBreaker: half-open, one failure re-trips and one 2xx closes", () => {
  const b = new UpstreamFailureBreaker(5, 60_000);
  for (let i = 0; i < 4; i++) b.observe(b.ticket(), FAIL);
  assert.equal(b.observe(b.ticket(), FAIL).event, "trip");

  // Half-open: a neutral answer leaves it half-open.
  assert.equal(b.observe(b.ticket(), NEUTRAL), null);
  assert.equal(b.state(false), "half_open");
  // One failure, not five, re-trips.
  assert.deepEqual(b.observe(b.ticket(), { kind: "failure", detail: "upstream_timeout" }), {
    event: "retrip",
    consecutiveFailures: 1,
    detail: "upstream_timeout",
  });
  // Half-open again after that pause: one 2xx closes it.
  assert.equal(b.observe(b.ticket(), OK), null);
  assert.equal(b.state(false), "closed");
  // Closed again: the full threshold applies.
  for (let i = 0; i < 4; i++) assert.equal(b.observe(b.ticket(), FAIL), null);
  assert.equal(b.observe(b.ticket(), FAIL).event, "trip");
});

test("UpstreamFailureBreaker: a call sent before a trip cannot re-trip or close it when it ends", () => {
  const b = new UpstreamFailureBreaker(2, 60_000);
  const early = [b.ticket(), b.ticket(), b.ticket(), b.ticket()];
  assert.equal(b.observe(early[0], FAIL), null);
  assert.equal(b.observe(early[1], FAIL).event, "trip");
  // In flight when it tripped: ignored, whatever the answer.
  assert.equal(b.observe(early[2], FAIL), null, "a stale failure does not re-trip");
  assert.equal(b.observe(early[3], OK), null);
  assert.equal(b.state(false), "half_open", "a stale success does not close it");
  // A call sent while half-open decides.
  assert.equal(b.observe(b.ticket(), OK), null);
  assert.equal(b.state(false), "closed");
});

test("RequestRateLimiter: a sliding 60 s count", () => {
  const r = new RequestRateLimiter(3);
  assert.equal(r.windowMs, 60_000);
  r.record(0);
  r.record(10);
  r.record(20);
  assert.equal(r.full(59_999), true, "all three are inside the window");
  assert.equal(r.count(60_000), 2, "a request leaves the window 60 s after it was forwarded");
  assert.equal(r.full(60_000), false);
  r.record(60_000);
  assert.equal(r.full(60_005), true);
  assert.equal(r.count(120_020), 0);
});

test("breaker constructors refuse an off value: the proxy builds them only when a setting is above 0", () => {
  assert.throws(() => new UpstreamFailureBreaker(0, 1000), /threshold/);
  assert.throws(() => new UpstreamFailureBreaker(1.5, 1000), /threshold/);
  assert.throws(() => new UpstreamFailureBreaker(3, 0), /cooldownMs/);
  assert.throws(() => new RequestRateLimiter(0), /limit/);
});

// --- configuration -------------------------------------------------------

const ORIGINAL_CWD = process.cwd();
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-breaker-config-"));
  process.chdir(dir);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("KILLSWITCH_") || k === "TWZRD_STATE_DIR") delete process.env[k];
  }
  process.env.OPENAI_API_KEY = "sk-test-offline";
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("KILLSWITCH_")) delete process.env[k];
  }
});

function writeConfig(text) {
  const p = path.join(dir, "config.yaml");
  fs.writeFileSync(p, text);
  return p;
}

test("config: both breakers are off by default", () => {
  const cfg = loadConfig(path.join(dir, "absent.yaml"));
  assert.equal(cfg.maxRequestsPerMinute, 0);
  assert.equal(cfg.upstreamFailureThreshold, 0);
  assert.equal(cfg.upstreamFailureCooldownMs, 60_000);
});

test("config: legacy YAML keys, and env overrides them", () => {
  const p = writeConfig(
    [
      "upstream:",
      "  failure_threshold: 5",
      "  failure_cooldown_ms: 30000",
      "limits:",
      "  max_requests_per_minute: 120",
    ].join("\n"),
  );
  let cfg = loadConfig(p);
  assert.equal(cfg.maxRequestsPerMinute, 120);
  assert.equal(cfg.upstreamFailureThreshold, 5);
  assert.equal(cfg.upstreamFailureCooldownMs, 30_000);

  process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "60";
  process.env.KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD = "0";
  process.env.KILLSWITCH_UPSTREAM_FAILURE_COOLDOWN_MS = "1000";
  cfg = loadConfig(p);
  assert.equal(cfg.maxRequestsPerMinute, 60);
  assert.equal(cfg.upstreamFailureThreshold, 0, "env 0 turns the file's breaker off");
  assert.equal(cfg.upstreamFailureCooldownMs, 1000);

  process.env.KILLSWITCH_MAX_REQUESTS_MINUTE = "";
  assert.equal(loadConfig(p).maxRequestsPerMinute, 120, "an empty variable is unset");
});

test("config: legacy YAML refuses anything but a literal whole number, at startup", () => {
  const bad = ['"120"', "'5'", "1.5", "true", "-1", "~", "[1]", ".inf"];
  for (const [section, key] of [
    ["limits", "max_requests_per_minute"],
    ["upstream", "failure_threshold"],
    ["upstream", "failure_cooldown_ms"],
  ]) {
    for (const value of bad) {
      const p = writeConfig(`${section}:\n  ${key}: ${value}\n`);
      assert.throws(
        () => loadConfig(p),
        new RegExp(`^Error: ${section}\\.${key} must be a whole number`),
        `${section}.${key}: ${value} must be refused`,
      );
    }
  }
  assert.throws(() => loadConfig(writeConfig("upstream:\n  failure_cooldown_ms: 0\n")), /failure_cooldown_ms must be a whole number from 1 to 86400000/);
  assert.throws(
    () => loadConfig(writeConfig(`upstream:\n  failure_cooldown_ms: ${MAX_UPSTREAM_FAILURE_COOLDOWN_MS + 1}\n`)),
    /from 1 to 86400000/,
  );
  assert.equal(
    loadConfig(writeConfig(`upstream:\n  failure_cooldown_ms: ${MAX_UPSTREAM_FAILURE_COOLDOWN_MS}\n`)).upstreamFailureCooldownMs,
    MAX_UPSTREAM_FAILURE_COOLDOWN_MS,
  );
  // A quoted number names its type, so the operator sees why it was refused.
  assert.throws(() => loadConfig(writeConfig('limits:\n  max_requests_per_minute: "120"\n')), /got the string '120'/);
});

test("config: env values are ASCII digits only", () => {
  for (const [name, bad] of [
    ["KILLSWITCH_MAX_REQUESTS_MINUTE", ["1e3", "12.0", " 12", "12 ", "-1", "+5", "0x10", "12abc", "１２"]],
    ["KILLSWITCH_UPSTREAM_FAILURE_THRESHOLD", ["1e1", "3.5", "-3", "three"]],
    ["KILLSWITCH_UPSTREAM_FAILURE_COOLDOWN_MS", ["0", "86400001", "6e4", "60000ms"]],
  ]) {
    for (const value of bad) {
      for (const k of Object.keys(process.env)) if (k.startsWith("KILLSWITCH_")) delete process.env[k];
      process.env[name] = value;
      assert.throws(
        () => loadConfig(path.join(dir, "absent.yaml")),
        new RegExp(`^Error: ${name} must be a whole number`),
        `${name}=${JSON.stringify(value)} must be refused`,
      );
    }
  }
});

test("config: twzrd.binding_policy.v1 compute keys, validated the same way", () => {
  const policy = (extra) =>
    writeConfig(["schema: twzrd.binding_policy.v1", "compute:", ...extra.map((l) => `  ${l}`)].join("\n"));
  const cfg = loadConfig(
    policy(["max_requests_per_minute: 90", "upstream_failure_threshold: 4", "upstream_failure_cooldown_ms: 15000"]),
  );
  assert.equal(cfg.maxRequestsPerMinute, 90);
  assert.equal(cfg.upstreamFailureThreshold, 4);
  assert.equal(cfg.upstreamFailureCooldownMs, 15_000);

  assert.throws(() => loadConfig(policy(['max_requests_per_minute: "90"'])), /compute\.max_requests_per_minute must be a whole number/);
  assert.throws(() => loadConfig(policy(["upstream_failure_threshold: 2.5"])), /compute\.upstream_failure_threshold must be a whole number/);
  assert.throws(() => loadConfig(policy(["upstream_failure_cooldown_ms: 0"])), /compute\.upstream_failure_cooldown_ms must be a whole number from 1/);
  // A misspelt key is still refused rather than silently leaving a breaker off.
  assert.throws(() => loadConfig(policy(["max_request_per_minute: 90"])), /Unknown compute key 'max_request_per_minute'/);
});
