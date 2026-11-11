// Offline tests for the ledger hash chain (src/chain.ts) and the
// `verify-ledger` command. Temp files only; no network, no keys, no spend.
// Run with `npm test` (builds dist first).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../dist/index.js";
import { Ledger } from "../dist/ledger.js";
import { FORK_WINDOW, GENESIS, lastCompleteLine, verifyLedgerFile } from "../dist/chain.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "killswitch-chain-"));
  dirs.push(dir);
  return path.join(dir, "spend.jsonl");
}

function row(n, overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    model: "gpt-4o-mini",
    prompt_tokens: 10,
    completion_tokens: 10,
    total_tokens: 20,
    cost_usd: 0.01 * n,
    allowed: true,
    veto_reason: null,
    request_id: `r-${n}`,
    ...overrides,
  };
}

/** Raw lines of the file, without the final empty string after the last newline. */
function lines(file) {
  const text = fs.readFileSync(file, "utf8");
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function writeLines(file, ls) {
  fs.writeFileSync(file, ls.map((l) => l + "\n").join(""), "utf8");
}

function ledgerWith(n) {
  const file = tempFile();
  const ledger = new Ledger(file);
  for (let i = 1; i <= n; i++) ledger.append(row(i));
  return file;
}

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, "verify-ledger", ...args], {
    encoding: "utf8",
    // No API key and no config: the audit must not need either.
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("rows the proxy writes form a chain from genesis", () => {
  const file = ledgerWith(3);
  const ls = lines(file);
  assert.equal(ls.length, 3);
  assert.equal(JSON.parse(ls[0]).prev, GENESIS);
  assert.equal(JSON.parse(ls[1]).prev, sha256(ls[0]));
  assert.equal(JSON.parse(ls[2]).prev, sha256(ls[1]));
  const r = verifyLedgerFile(file, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.chained, 3);
  assert.deepEqual(r.breaks, []);
  assert.equal(r.head, sha256(ls[2]));
  assert.equal(r.head_line, 3);
});

test("the caller cannot choose prev", () => {
  const file = tempFile();
  new Ledger(file).append(row(1, { prev: "f".repeat(64) }));
  assert.equal(JSON.parse(lines(file)[0]).prev, GENESIS);
});

test("chained rows still count toward the spend windows", () => {
  const file = ledgerWith(2); // 0.01 + 0.02
  const fresh = new Ledger(file);
  assert.equal(fresh.load(), 2);
  assert.equal(Math.round(fresh.window().hourUsd * 100) / 100, 0.03);
});

test("two copies on one file stay one linear chain", () => {
  const file = tempFile();
  const a = new Ledger(file);
  const b = new Ledger(file);
  a.load();
  b.load();
  for (let i = 1; i <= 6; i++) (i % 2 ? a : b).append(row(i));
  const r = verifyLedgerFile(file, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.chained, 6);
  assert.deepEqual(r.forks, []);
});

test("rows written before the chain existed are reported and the first chained row commits to them", () => {
  const file = tempFile();
  const legacy = [JSON.stringify(row(1)), JSON.stringify(row(2))];
  writeLines(file, legacy);
  new Ledger(file).append(row(3));
  assert.equal(JSON.parse(lines(file)[2]).prev, sha256(legacy[1]));
  const r = verifyLedgerFile(file, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.legacy, 2);
  assert.equal(r.chained, 1);
});

test("a row without prev from an older copy is committed to by the next row; strict refuses it", () => {
  const file = ledgerWith(1);
  fs.appendFileSync(file, JSON.stringify(row(2)) + "\n");
  new Ledger(file).append(row(3));
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unchained, [2]);
  assert.equal(verifyLedgerFile(file, { strict: true }).ok, false);
});

test("editing a row breaks the link of the row after it", () => {
  const file = ledgerWith(4);
  const ls = lines(file);
  const edited = JSON.parse(ls[1]);
  edited.cost_usd = 0; // erase a spend
  ls[1] = JSON.stringify(edited);
  writeLines(file, ls);
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, false);
  assert.deepEqual(r.breaks.map((b) => b.line), [3]);
});

test("removing a row breaks the link of the row that followed it", () => {
  const file = ledgerWith(4);
  const ls = lines(file);
  ls.splice(1, 1);
  writeLines(file, ls);
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, false);
  assert.deepEqual(r.breaks.map((b) => b.line), [2]);
});

test("swapping two rows breaks the chain", () => {
  const file = ledgerWith(4);
  const ls = lines(file);
  [ls[1], ls[2]] = [ls[2], ls[1]];
  writeLines(file, ls);
  assert.equal(verifyLedgerFile(file).ok, false);
});

test("a line replaced by garbage breaks the next link", () => {
  const file = ledgerWith(3);
  const ls = lines(file);
  ls[1] = "{not json";
  writeLines(file, ls);
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unparseable, [2]);
  assert.deepEqual(r.breaks.map((b) => b.line), [3]);
});

test("limit, stated: dropping the newest row or rewriting every hash verifies; only a recorded head catches it", () => {
  const file = ledgerWith(4);
  const recorded = verifyLedgerFile(file).head;

  const ls = lines(file);
  writeLines(file, ls.slice(0, 3));
  const dropped = verifyLedgerFile(file, { strict: true });
  assert.equal(dropped.ok, true);
  assert.notEqual(dropped.head, recorded);

  // Rewrite every row with lower costs and recompute every prev.
  let prev = GENESIS;
  const forged = ls.map((l) => {
    const o = JSON.parse(l);
    o.cost_usd = 0;
    o.prev = prev;
    const out = JSON.stringify(o);
    prev = sha256(out);
    return out;
  });
  writeLines(file, forged);
  const rewritten = verifyLedgerFile(file, { strict: true });
  assert.equal(rewritten.ok, true);
  assert.notEqual(rewritten.head, recorded);
});

test("two copies appending at the same moment fork; strict refuses the fork", () => {
  const file = ledgerWith(2);
  const ls = lines(file);
  // A peer computed its prev before row 2 landed: it names row 1.
  fs.appendFileSync(file, JSON.stringify({ ...row(3), prev: sha256(ls[0]) }) + "\n");
  new Ledger(file).append(row(4)); // commits to the peer's row
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, true);
  assert.deepEqual(r.forks, [3]);
  assert.deepEqual(r.breaks, []);
  assert.equal(verifyLedgerFile(file, { strict: true }).ok, false);
});

test("a prev that names a line further back than the fork window is a break", () => {
  const file = ledgerWith(FORK_WINDOW + 3);
  const first = lines(file)[0];
  fs.appendFileSync(file, JSON.stringify({ ...row(99), prev: sha256(first) }) + "\n");
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, false);
  assert.deepEqual(r.breaks.map((b) => b.line), [FORK_WINDOW + 4]);
});

test("a torn tail is reported, not checked, and does not crash", () => {
  const file = ledgerWith(2);
  fs.appendFileSync(file, '{"timestamp":"2026-');
  const r = verifyLedgerFile(file, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.torn_tail, true);
  assert.equal(r.head_line, 2);
});

test("a row appended onto a torn tail stays in the chain as one unparseable line", () => {
  const file = ledgerWith(1);
  fs.appendFileSync(file, '{"timestamp":"2026-'); // a crashed writer's fragment
  const ledger = new Ledger(file);
  ledger.append(row(2)); // lands on the fragment's line, as before this change
  ledger.append(row(3)); // commits to that whole line
  const r = verifyLedgerFile(file);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unparseable, [2]);
  assert.equal(r.chained, 2);
  assert.deepEqual(r.breaks, []);
});

test("the tail reader handles a line longer than its read chunk and skips empty lines", () => {
  const file = tempFile();
  const long = JSON.stringify(row(1, { model: "m".repeat(200 * 1024) }));
  fs.writeFileSync(file, long + "\n\n\n");
  const fd = fs.openSync(file, "r");
  try {
    assert.equal(lastCompleteLine(fd, fs.fstatSync(fd).size).toString("utf8"), long);
  } finally {
    fs.closeSync(fd);
  }
  new Ledger(file).append(row(2));
  assert.equal(JSON.parse(lines(file).at(-1)).prev, sha256(long));
  assert.equal(verifyLedgerFile(file).ok, true);
});

test("a ledger written by twzrd-x402-gate verifies under the same convention", async () => {
  const { createFileSpendLedger } = await import("../../twzrd-x402-gate/dist/index.js");
  const file = tempFile();
  const gateLedger = createFileSpendLedger(file);
  gateLedger.record("scope-a", 1000n, Date.now());
  gateLedger.record("scope-a", 2500n, Date.now());
  gateLedger.record("scope-b", 7n, Date.now());
  const r = verifyLedgerFile(file, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.chained, 3);
});

test("rows written through the HTTP proxy, allowed and vetoed, form a strict chain", async () => {
  const file = tempFile();
  const dir = path.dirname(file);
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-stub",
        model: "gpt-4o-mini",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("KILLSWITCH_")) delete process.env[k];
  Object.assign(process.env, {
    OPENAI_API_KEY: "sk-test-offline",
    KILLSWITCH_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    KILLSWITCH_LEDGER_PATH: file,
    KILLSWITCH_KILL_FILE: path.join(dir, ".kill"),
    KILLSWITCH_CONFIG: path.join(dir, "absent.yaml"),
  });
  const server = createServer();
  try {
    const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
    const call = (max_tokens) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", max_tokens, messages: [{ role: "user", content: "hi" }] }),
      });
    assert.equal((await call(10)).status, 200);
    assert.equal((await call(10)).status, 200);
    // Over the token limit: vetoed (last, because a budget veto also writes .pause).
    assert.equal((await call(1_000_000)).status, 429);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const rows = lines(file).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.allowed), [true, true, false]);
  const r = verifyLedgerFile(file, { strict: true });
  assert.equal(r.ok, true);
  assert.equal(r.chained, 3);
});

test("verify-ledger CLI: exit 0 intact, 1 broken, 2 missing or bad arguments, no API key needed", () => {
  const file = ledgerWith(3);
  const ok = cli([file]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^OK: every chained row commits to the line before it/m);
  assert.match(ok.stdout, new RegExp(`head ${verifyLedgerFile(file).head} \\(line 3\\)`));

  const json = cli([file, "--json"]);
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.file, file);

  const ls = lines(file);
  ls.splice(1, 1);
  writeLines(file, ls);
  const broken = cli([file]);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /BROKEN at line 2/);

  assert.equal(cli([path.join(path.dirname(file), "nope.jsonl")]).code, 2);
  assert.equal(cli([file, "--frobnicate"]).code, 2);
  assert.equal(cli([file, file]).code, 2);
});

test("verify-ledger CLI: --strict turns a fork into exit 1", () => {
  const file = ledgerWith(2);
  fs.appendFileSync(file, JSON.stringify({ ...row(3), prev: sha256(lines(file)[0]) }) + "\n");
  assert.equal(cli([file]).code, 0);
  const strict = cli([file, "--strict"]);
  assert.equal(strict.code, 1);
  assert.match(strict.stdout, /forks \(two copies appended at once\) at lines 3/);
});

test("verify-ledger CLI: the default path follows KILLSWITCH_LEDGER_PATH, then TWZRD_STATE_DIR", () => {
  const file = ledgerWith(1);
  assert.equal(cli([], { KILLSWITCH_LEDGER_PATH: file }).code, 0);
  const stateDir = path.dirname(file);
  fs.renameSync(file, path.join(stateDir, "spend-ledger.jsonl"));
  assert.equal(cli([], { TWZRD_STATE_DIR: stateDir }).code, 0);
});
