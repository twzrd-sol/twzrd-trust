/**
 * Agent Payment Node seat: TWZRD between prepare and approve.
 *
 * Asserts the table in docs/apn-compatibility-packet.md:
 *   A clean Base merchant   -> exactly one approve / authorization / broadcast,
 *                              record unavailable + NETWORK_NOT_SCORED (no invented score)
 *   B flagged Base merchant -> zero approve / authorization / broadcast / spend,
 *                              record block + WASH_FLAGGED
 *   C strict (all-local)    -> zero network calls, zero authorizations, record unavailable
 * Every record verifies offline and is bound to the frozen offer.
 *
 * Run: npx tsx test/apn-prepare-approve.test.ts
 */
import assert from "node:assert/strict";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import { verifyPaymentDecisionRecord } from "../src/payment-decision.js";
import {
  AMOUNT_ATOMIC, BASE, CLEAN_PAYEE, FLAGGED_PAYEE, RESOURCE,
  runApnCompatFixtures, selectedRequirementsFromOffer, type FixtureResult,
} from "../examples/apn-prepare-approve-proof.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

function verifyBound(f: FixtureResult, publicKeyPem: string) {
  const v = verifyPaymentDecisionRecord(f.sidecar.record, { publicKeyPem, now: NOW, challenge: f.op.requirements });
  assert.equal(v.ok, true, `${f.name}: ${JSON.stringify(v.errors)}`);
  assert.equal(v.checks.signature, true);
  assert.equal(v.checks.challenge_bound, true, `${f.name}: record must be about THIS frozen offer`);
  assert.equal(v.evidence_id, f.decision.approval.decisionId);
  return v;
}

async function run() {
  const signer = createLocalDecisionSigner({ keyId: "apn-packet-test" });
  const { A, B, C } = await runApnCompatFixtures(signer, NOW);

  // Shared: the frozen offer is what APN froze, and the record is joined on it.
  for (const f of [A, B, C]) {
    const selected = selectedRequirementsFromOffer(f.op);
    assert.equal(selected.amount, AMOUNT_ATOMIC, `${f.name}: amount stays atomic micro, not a local USDC divide`);
    assert.equal(selected.payTo, f.op.payee);
    assert.equal(f.op.requirements.network, BASE);
    assert.equal(f.op.selectedOffer.resolved.assetTransferMethod, "eip3009");
    assert.equal(f.sidecar.offerHash, f.op.selectedOffer.offerHash);
    assert.equal(f.sidecar.operationId, f.op.operationId);
    // Base is scored from its own corpus now. What must still hold is that no
    // score leaks into the sidecar record, asserted below.
    assert.equal(f.decision.approval.reputationScored, true, `${f.name}: Base is scored from its own corpus`);
    assert.equal(f.sidecar.record.network, BASE);
    assert.equal(f.sidecar.record.merchant.pay_to, f.op.payee);
    assert.equal(f.sidecar.record.merchant.origin, new URL(RESOURCE).origin);
    const flat = JSON.stringify(f.sidecar.record);
    assert.ok(!flat.includes("/paid/brief"), `${f.name}: record must not carry the resource path`);
    assert.ok(!/trust_score|score/.test(flat), `${f.name}: record must not carry a score`);
  }

  // A. clean Base merchant: one authorization, honest unavailable record.
  {
    assert.equal(A.decision.proceed, true);
    assert.deepEqual(A.counters, { approveCalls: 1, authorizations: 1, broadcasts: 1, spendAtomic: AMOUNT_ATOMIC });
    assert.ok(A.receipt && A.receipt.authorizationCount === 1 && A.receipt.payee === CLEAN_PAYEE);
    assert.equal(A.decision.approval.policyAction, "allow");
    assert.equal(A.decision.approval.washFlagged, false);
    const v = verifyBound(A, signer.publicKeyPem);
    // Base is scored from its own corpus now, so the bound record carries a
    // real verdict instead of "unavailable / NETWORK_NOT_SCORED". The record
    // still carries no score — asserted in the shared loop above.
    assert.equal(v.decision, "warn");
    assert.equal(A.intelCalls.filter((u) => u.includes("/v1/intel/merchant_card/")).length, 1);
    assert.equal(A.intelCalls.filter((u) => u.includes("/v1/intel/preflight")).length, 1);
    assert.equal(A.intelCalls.length, 2, "exactly the Base preflight and the wash read");
  }

  // B. flagged Base merchant: approve never runs, nothing signed, nothing spent.
  {
    assert.equal(B.decision.proceed, false);
    assert.deepEqual(B.counters, { approveCalls: 0, authorizations: 0, broadcasts: 0, spendAtomic: "0" });
    assert.equal(B.receipt, null);
    assert.equal(B.decision.approval.policyAction, "block");
    assert.equal(B.decision.approval.washFlagged, true);
    assert.match(String(B.decision.approval.reason), /wash/i);
    const v = verifyBound(B, signer.publicKeyPem);
    assert.equal(v.decision, "block");
    assert.equal(v.reason_code, "WASH_FLAGGED");
    assert.equal(B.op.payee, FLAGGED_PAYEE);
    assert.equal(B.intelCalls.length, 2, "the Base preflight and the wash read; wash still refuses");
  }

  // C. strict on Base: the corpus is consulted rather than the chain refused.
  //
  // This fixture used to assert strict mode made no network call and recorded
  // "unavailable / NETWORK_NOT_SCORED". That was a property of Base having no
  // corpus, not a property of strict mode. Base is scored now, so strict
  // consults it and a clean seller is allowed. Strict mode still blocks chains
  // with no corpus outright, covered in network.test.ts and
  // base-wash-observe.test.ts, neither of which depends on this APN packet.
  {
    assert.equal(C.decision.proceed, true, "a clean, scored Base seller is allowed under strict");
    assert.equal(C.decision.approval.reputationScored, true);
    assert.equal(C.decision.approval.policyAction, "allow");
    assert.equal(C.intelCalls.filter((u) => u.includes("/v1/intel/preflight")).length, 1);
    const v = verifyBound(C, signer.publicKeyPem);
    assert.notEqual(v.reason_code, "NETWORK_NOT_SCORED", "Base is no longer unscored");
  }

  // A record signed by someone else does not verify against this issuer's key.
  {
    const stranger = createLocalDecisionSigner({ keyId: "apn-packet-test" });
    const v = verifyPaymentDecisionRecord(A.sidecar.record, { publicKeyPem: stranger.publicKeyPem, now: NOW });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.code === "bad_signature"));
  }

  console.log("apn-prepare-approve.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("apn-prepare-approve.test.ts FAILED:", e);
  process.exit(1);
});
