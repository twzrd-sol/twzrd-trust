import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileDecisionLedger, DECISION_LEDGER_SCHEMA_VERSION } from "../src/decision-ledger-file.js";

const path = join(mkdtempSync(join(tmpdir(), "twzrd-decision-ledger-")), "decisions.jsonl");
const ledger = createFileDecisionLedger(path);
const row = ledger.record({
  decision_id: "decision-test-1",
  at_unix_ms: 1,
  outcome: "error",
  reason_codes: ["twzrd_fail_closed"],
  policy_version: "test-policy",
  input: { pay_to: "seller", amount_micro: "1000" },
  signer_invocations: 0,
  latency_ms: 12,
  error: { code: "ECONNRESET" },
  settlement: { status: "failed" },
});
assert.equal(row.schema_version, DECISION_LEDGER_SCHEMA_VERSION);
assert.equal(row.outcome, "error", "gate errors are decision records too");
assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), row);
console.log("decision-ledger-file: all assertions passed");
