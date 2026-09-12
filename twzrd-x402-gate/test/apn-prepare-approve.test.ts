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
  runApnCompatFixtures, type FixtureResult,
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
    assert.equal(f.op.requirements.network, BASE);
    assert.equal(f.op.selectedOffer.resolved.assetTransferMethod, "eip3009");
    assert.equal(f.sidecar.offerHash, f.op.selectedOffer.offerHash);
    assert.equal(f.sidecar.operationId, f.op.operationId);
    assert.equal(f.decision.approval.reputationScored, false, `${f.name}: never claim Solana reputation on Base`);
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
    assert.equal(v.decision, "unavailable");
    assert.equal(v.reason_code, "NETWORK_NOT_SCORED");
    assert.equal(A.intelCalls.filter((u) => u.includes("/v1/intel/merchant_card/")).length, 1);
    assert.equal(A.intelCalls.length, 1, "only merchant_card may be called on an unscored network");
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
    assert.equal(B.intelCalls.length, 1);
  }

  // C. strict / all-local: no network call, no authorization, record still honest.
  {
    assert.equal(C.decision.proceed, false);
    assert.deepEqual(C.counters, { approveCalls: 0, authorizations: 0, broadcasts: 0, spendAtomic: "0" });
    assert.equal(C.intelCalls.length, 0, "strict mode must not make any network call");
    const v = verifyBound(C, signer.publicKeyPem);
    assert.equal(v.decision, "unavailable", "an unscored network is never a block in the record");
    assert.equal(v.reason_code, "NETWORK_NOT_SCORED");
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
