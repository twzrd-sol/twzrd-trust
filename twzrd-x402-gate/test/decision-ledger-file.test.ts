import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileDecisionLedger, DECISION_LEDGER_SCHEMA_VERSION } from "../src/decision-ledger-file.js";

const path = join(mkdtempSync(join(tmpdir(), "twzrd-decision-ledger-")), "decisions.jsonl");
const signalListenersBefore = process.listenerCount("SIGTERM");
const ledger = createFileDecisionLedger(path);
assert.equal(process.listenerCount("SIGTERM"), signalListenersBefore, "signal hooks are opt-in");
const row = ledger.record({
  decision_id: "decision-test-1",
  at_unix_ms: 1,
  outcome: "error",
  reason_codes: ["twzrd_fail_closed"],
  policy_version: "test-policy",
  input: { pay_to: "seller", resource: "https://merchant.example/private?token=secret", amount_micro: "1000" },
  signer_invocations: 0,
  latency_ms: 12,
  error: { code: "ECONNRESET" },
  settlement: { status: "failed" },
});
async function run() {
  await ledger.flush();
  assert.equal(row.schema_version, DECISION_LEDGER_SCHEMA_VERSION);
  assert.equal(row.outcome, "error", "gate errors are decision records too");
  assert.equal(row.input.resource_origin, "https://merchant.example");
  assert.equal(row.input.pay_to, "seller");
  assert.equal(row.input.amount_micro, "1000");
  assert.equal(JSON.stringify(row).includes("secret"), false, "raw query data is never logged");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(JSON.stringify(row)));
  console.log("decision-ledger-file: all assertions passed");
}
void run();
