// Offline tests: two proxy copies pointed at one JSONL ledger must see each
// other's spends without a restart. Before the tail-read fix each copy
// replayed once at startup and counted only its own memory, so two copies
// could spend up to twice the cap. A temp file stands in for the operator's
// data dir; nothing leaves 127.0.0.1. Run with `npm test` (builds dist first).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../dist/ledger.js";
import { createServer } from "../dist/index.js";

const ORIGINAL_CWD = process.cwd();

function tempLedgerPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-tailread-"));
  return { dir, file: path.join(dir, "spend.jsonl") };
}

function allowedLine(overrides = {}) {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      model: "gpt-4o-mini",
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
      cost_usd: 0.5,
      allowed: true,
      veto_reason: null,
      request_id: "x",
      ...overrides,
    }) + "\n"
  );
}

const ledgerDirs = [];

afterEach(() => {
  for (const dir of ledgerDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two copies on one ledger file see each other's spends without a restart", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const a = new Ledger(file);
  const b = new Ledger(file);
  assert.equal(a.load(), 0);
  assert.equal(b.load(), 0);
  a.append({
    timestamp: new Date().toISOString(),
    model: "gpt-4o-mini",
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    cost_usd: 0.5,
    allowed: true,
    veto_reason: null,
    request_id: "a-1",
  });
  // Copy B must see copy A's spend at the very next budget check.
  const w = b.window();
  assert.equal(w.hourUsd, 0.5);
  assert.equal(w.minuteTokens, 20);
});

test("a torn line is not applied until its newline arrives", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const a = new Ledger(file);
  const b = new Ledger(file);
  assert.equal(a.load(), 0);
  assert.equal(b.load(), 0);
  const full = allowedLine();
  const torn = full.slice(0, 40); // cut mid-object; no newline
  fs.writeFileSync(file, torn, "utf8");
  assert.equal(b.window().hourUsd, 0); // nothing to count, no crash
  fs.appendFileSync(file, full.slice(40), "utf8");
  assert.equal(b.window().hourUsd, 0.5); // completed line now counted
});

test("lines older than the 48 h retention window are not applied", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const b = new Ledger(file);
  assert.equal(b.load(), 0);
  const stale = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
  fs.appendFileSync(file, allowedLine({ timestamp: stale }), "utf8");
  assert.equal(b.window().hourUsd, 0);
});

test("a copy's own append is counted exactly once", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const a = new Ledger(file);
  assert.equal(a.load(), 0);
  a.append({
    timestamp: new Date().toISOString(),
    model: "gpt-4o-mini",
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    cost_usd: 0.5,
    allowed: true,
    veto_reason: null,
    request_id: "a-1",
  });
  assert.equal(a.window().hourUsd, 0.5); // not 1.0 and not 0.0
  a.append({
    timestamp: new Date().toISOString(),
    model: "gpt-4o-mini",
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    cost_usd: 0.25,
    allowed: true,
    veto_reason: null,
    request_id: "a-2",
  });
  assert.equal(a.window().hourUsd, 0.75);
});

test("a veto written by one copy is not spend for another copy", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const a = new Ledger(file);
  const b = new Ledger(file);
  assert.equal(a.load(), 0);
  assert.equal(b.load(), 0);
  fs.appendFileSync(file, allowedLine({ allowed: false, cost_usd: 0, veto_reason: "budget_exceeded" }), "utf8");
  assert.equal(b.window().hourUsd, 0);
});

// Two servers on one working directory share the default ./data/spend-ledger.jsonl.
let dir2;
let upstream;
let servers;

beforeEach(async () => {
  dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-tailread-srv-"));
  process.chdir(dir2);
  for (const k of Object.keys(process.env)) if (k.startsWith("KILLSWITCH_")) delete process.env[k];
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_API_KEY = "sk-test-offline";
  process.env.KILLSWITCH_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  servers = [];
});

afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await new Promise((r) => upstream.close(r));
  servers = [];
  upstream = null;
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(dir2, { recursive: true, force: true });
  dir2 = null;
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("/healthz on a second copy reflects the first copy's upstream spend", async () => {
  const a = createServer();
  const b = createServer();
  servers.push(a, b);
  const [pa, pb] = await Promise.all([listen(a), listen(b)]);
  const res = await fetch(`http://127.0.0.1:${pa}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const hb = await fetch(`http://127.0.0.1:${pb}/healthz`);
  const body = await hb.json();
  assert.equal(body.ok, true);
  assert.ok(body.hour_usd > 0, `second copy must see the first copy's spend, got hour_usd=${body.hour_usd}`);
});

test("a multi-byte UTF-8 character split across reads is not corrupted", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const b = new Ledger(file);
  assert.equal(b.load(), 0);
  const full = allowedLine({ model: "star-\u{1F31F}-model" }); // 🌟 U+1F31F, 4 bytes in UTF-8
  const fullBuf = Buffer.from(full, "utf8");
  const emojiAt = fullBuf.indexOf(Buffer.from([0xf0, 0x9f, 0x8c, 0x9f]));
  assert.ok(emojiAt > 0, "emoji must appear in the line");
  const cut = emojiAt + 2; // inside the 4-byte sequence
  fs.writeFileSync(file, fullBuf.subarray(0, cut));
  assert.equal(b.window().hourUsd, 0); // torn line: not counted, not corrupted
  fs.appendFileSync(file, fullBuf.subarray(cut));
  assert.equal(b.window().hourUsd, 0.5); // completed line parses and counts
});

test("a line a peer appends while we write is not skipped by our next check", () => {
  const { dir, file } = tempLedgerPath();
  ledgerDirs.push(dir);
  const a = new Ledger(file);
  const b = new Ledger(file);
  assert.equal(a.load(), 0);
  assert.equal(b.load(), 0);
  // B appended before A ever looked; A appends now; B appends again right after.
  fs.appendFileSync(file, allowedLine({ cost_usd: 0.5, request_id: "b1" }), "utf8");
  a.append({
    timestamp: new Date().toISOString(),
    model: "gpt-4o-mini",
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    cost_usd: 0.25,
    allowed: true,
    veto_reason: null,
    request_id: "a1",
  });
  fs.appendFileSync(file, allowedLine({ cost_usd: 0.75, request_id: "b2" }), "utf8");
  // A's cursor must not have absorbed B's lines: all three must count.
  assert.equal(a.window().hourUsd, 1.5);
});
