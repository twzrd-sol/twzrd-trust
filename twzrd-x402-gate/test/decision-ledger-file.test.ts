import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./helpers/tmpdir.js";
import {
  createFileDecisionLedger,
  DECISION_LEDGER_SCHEMA_VERSION,
  MPP_FULFILLMENT_LEDGER_SCHEMA_VERSION,
  sharedFileDecisionLedger,
  type MppFulfillmentLedgerInput,
} from "../src/decision-ledger-file.js";

const path = join(tempDir("twzrd-decision-ledger-"), "decisions.jsonl");
const signalListenersBefore = process.listenerCount("SIGTERM");
const ledger = createFileDecisionLedger(path);
assert.equal(ledger, sharedFileDecisionLedger(path), "public and shared constructors reuse one writer");
assert.equal(
  process.listenerCount("SIGTERM"),
  signalListenersBefore,
  "signal hooks are opt-in",
);
const row = ledger.record({
  decision_id: "decision-test-1",
  at_unix_ms: 1,
  outcome: "error",
  reason_codes: ["twzrd_fail_closed"],
  policy_version: "test-policy",
  input: {
    pay_to: "seller",
    resource: "https://merchant.example/private?token=secret",
    amount_micro: "1000",
  },
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
  assert.equal(
    JSON.stringify(row).includes("secret"),
    false,
    "raw query data is never logged",
  );
  const unsafeInput = {
    resource_origin: "https://seller.example/private?token=must-not-survive",
    http_status: 200,
    payment_method: "tempo",
    payment_intent: "charge",
    challenge_id: "buyer@example.com challenge-1",
    paid_to: "0x1111111111111111111111111111111111111111",
    network: "eip155:42431",
    asset: "0x2222222222222222222222222222222222222222",
    amount_atomic: "1000000",
    receipt_state: "valid_format",
    receipt_status: "success",
    receipt_method: "tempo",
    receipt_reference: `0x${"a".repeat(64)}`,
    receipt_timestamp: "2026-11-05T23:00:00Z",
    requested_model: "private buyer@example.com",
    seller_reported_model: "qwen3-coder-30b",
    seller_reported_model_matches_request: true,
    gate: {
      disposition: "allow",
      intentHash: `tiv1:${"b".repeat(64)}`,
      reasonCodes: ["reputation_unchecked"],
    },
    prompt: "private user prompt",
    raw_receipt_header: "secret credential bytes",
    response_body: "private seller response",
  } as MppFulfillmentLedgerInput;
  const fulfillment = ledger.recordMppFulfillment(unsafeInput);
  await ledger.flush();
  assert.equal(
    fulfillment.schema_version,
    MPP_FULFILLMENT_LEDGER_SCHEMA_VERSION,
  );
  assert.equal(fulfillment.record_type, "mpp_fulfillment");
  assert.equal(fulfillment.resource_origin, "https://seller.example");
  assert.match(fulfillment.challenge_id_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal("challenge_id" in fulfillment, false, "raw seller challenge ids are not retained");
  assert.equal(fulfillment.requested_model, null, "free-form model strings are not retained");
  assert.equal(fulfillment.gate?.intentHash, `tiv1:${"b".repeat(64)}`);
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    rows.length,
    2,
    "decision and fulfillment share one append-only file",
  );
  assert.deepEqual(rows[0], JSON.parse(JSON.stringify(row)));
  assert.deepEqual(rows[1], JSON.parse(JSON.stringify(fulfillment)));
  assert.equal(
    readFileSync(path, "utf8").includes("must-not-survive"),
    false,
    "origin query is removed",
  );
  assert.equal(
    readFileSync(path, "utf8").includes("payment-receipt"),
    false,
    "raw receipt headers are not logged",
  );
  assert.equal(readFileSync(path, "utf8").includes("private user prompt"), false);
  assert.equal(readFileSync(path, "utf8").includes("credential bytes"), false);
  assert.equal(readFileSync(path, "utf8").includes("private seller response"), false);
  assert.equal(readFileSync(path, "utf8").includes("buyer@example.com"), false);
  assert.equal(fulfillment.response_bytes, null);
  assert.equal(fulfillment.body_sha256, null);
  assert.equal(fulfillment.receipt_reference_chain_verified, null);
  const digest = "ab".repeat(32);
  const keptInput: MppFulfillmentLedgerInput & { response_body?: string } = {
    ...unsafeInput,
    response_bytes: 8,
    body_sha256: digest,
    receipt_reference_chain_verified: false,
    receipt_reference_finalized_slot: 12,
    receipt_reference_mismatch: true,
    receipt_reference_unverified_reason: "verifier_error",
    receipt_reference_purchase_bound: null,
    receipt_reference_purchase_bound_reason: "not a token",
    receipt_reference_local_acceptance: false,
    receipt_reference_refusal_reason: "amount_mismatch",
    response_body: "still private",
  };
  const kept = ledger.recordMppFulfillment(keptInput);
  const dropped = ledger.recordMppFulfillment({
    ...unsafeInput,
    body_sha256: "NOT-A-DIGEST",
    response_bytes: 2_000_000,
    receipt_reference_finalized_slot: -1,
  });
  await ledger.flush();
  assert.equal(kept.schema_version, MPP_FULFILLMENT_LEDGER_SCHEMA_VERSION);
  assert.equal(kept.response_bytes, 8);
  assert.equal(kept.body_sha256, digest);
  assert.equal(kept.receipt_reference_chain_verified, false);
  assert.equal(kept.receipt_reference_finalized_slot, 12);
  assert.equal(kept.receipt_reference_mismatch, true);
  assert.equal(kept.receipt_reference_unverified_reason, "verifier_error");
  assert.equal(kept.receipt_reference_purchase_bound, null);
  assert.equal(kept.receipt_reference_purchase_bound_reason, null);
  assert.equal(kept.receipt_reference_local_acceptance, false);
  assert.equal(kept.receipt_reference_refusal_reason, "amount_mismatch");
  assert.equal(dropped.body_sha256, null);
  assert.equal(dropped.response_bytes, null);
  assert.equal(dropped.receipt_reference_finalized_slot, null);
  const written = readFileSync(path, "utf8");
  assert.equal(written.includes(digest), true, "the body digest is retained");
  assert.equal(written.includes("still private"), false, "the response body is not retained");
  assert.equal(written.includes("NOT-A-DIGEST"), false);
  console.log("decision-ledger-file: all assertions passed");
}
void run();
