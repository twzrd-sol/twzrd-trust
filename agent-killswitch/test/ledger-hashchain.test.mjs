import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, verifyLedgerChain, GENESIS_HASH } from "../dist/ledger.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-hash-"));
const file = path.join(tmp, "ledger.jsonl");

test("chain: append produces genesis-linked hashes", () => {
  const ledger = new Ledger(file);
  ledger.append({ timestamp: "2026-01-01T00:00:00.000Z", model: "gpt-4o", prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost_usd: 0.01, allowed: true, veto_reason: null, request_id: "a" });
  ledger.append({ timestamp: "2026-01-01T00:01:00.000Z", model: "gpt-4o", prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost_usd: 0.02, allowed: true, veto_reason: null, request_id: "b" });
  const r = verifyLedgerChain(file);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 2);
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].prev_hash, GENESIS_HASH);
  assert.equal(lines[1].prev_hash, lines[0].hash);
  assert.equal(r.finalHash, lines[1].hash);
});

test("chain: tamper breaks verification", () => {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const obj = JSON.parse(lines[1]);
  obj.cost_usd = 999;
  lines[1] = JSON.stringify(obj);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const r = verifyLedgerChain(file);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
});

test("chain: legacy pre-chain line tolerated", () => {
  const f2 = path.join(tmp, "legacy.jsonl");
  fs.writeFileSync(f2, JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", model: "gpt-4o", prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_usd: 0.001, allowed: true, veto_reason: null, request_id: "old" }) + "\n");
  const r = verifyLedgerChain(f2);
  assert.equal(r.ok, true);
});
