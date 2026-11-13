/**
 * Offline evidence verification: the consistency rules read what the outcome
 * attestation SIGNS, not the unsigned copy printed beside it.
 *
 * The leaf (and so the signature) commits to preimage.outcome and
 * preimage.verdict. The bundle's `decision` and the top-level
 * `outcomeAttestation.outcome` are plain JSON. A bundle could say
 * "blocked, never signed" in those unsigned fields, carry a genuine signed
 * attestation that says "allow, settled" for the same decision id, and pass
 * every check: the leaf recomputed, the signature verified, the ids matched.
 *
 * Run: npx tsx --test test/evidence-verify-preimage.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ADOPTION_PROOF_SELLER, runGateAdoptionProof } from "../src/adoption-proof.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { exportEvidenceBundle } from "../src/evidence-bundle.js";
import { buildOutcomeAttestation, type DecisionOutcomeFields } from "../src/outcome-attestation.js";
import { resourceBindLeafHash } from "../src/resource-bind.js";
import { validateEvidenceBundle, verifyBundleLinkage, verifyEvidenceBundle } from "../src/evidence-verify.js";

const DECISION_ID = "dec-preimage-1";
const PAYER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const SETTLEMENT_TX = "5".repeat(64);

const BLOCKED: DecisionOutcomeFields = {
  decisionId: DECISION_ID,
  counterparty: ADOPTION_PROOF_SELLER,
  verdict: "block",
  outcome: "blocked_never_signed",
  timestampUnix: 1_767_225_600,
  intentHash: null,
  payer: null,
  settlementTx: null,
  preflightId: 1,
};

/** A genuine attestation for the same decision id that says the payment went through. */
const SETTLED: DecisionOutcomeFields = {
  ...BLOCKED,
  verdict: "allow",
  outcome: "settled",
  payer: PAYER,
  settlementTx: SETTLEMENT_TX,
};

type Decision = { verdict: "allow" | "warn" | "block"; approved: boolean; signerInvocations: number };

const REFUSED: Decision = { verdict: "block", approved: false, signerInvocations: 0 };

/**
 * A bundle whose unsigned fields say `decision` and `printedOutcome`, around an
 * attestation genuinely signed over `signed`.
 */
async function bundle(signed: DecisionOutcomeFields, decision: Decision, printedOutcome: string) {
  const transcript = await runGateAdoptionProof({
    integration: "acme-ops-agent-v1",
    runId: "00000000-0000-4000-8000-0000000000cc",
  });
  const req = {
    payTo: ADOPTION_PROOF_SELLER,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: "1000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    resource: "https://merchant.example/twzrd-adoption-proof",
    scheme: "exact",
  };
  const leafHash = resourceBindLeafHash(req);
  const att = await buildOutcomeAttestation(signed, createLocalDecisionSigner());
  const exported = exportEvidenceBundle({
    attribution: { integration: "acme-ops-agent-v1", runId: "00000000-0000-4000-8000-0000000000cc" },
    transcript,
    requirements: req,
    decision: {
      ...decision,
      decisionId: DECISION_ID,
      preflightId: 1,
      signerProvenance: {
        source: "transcript_step", step: "block_path",
        transcriptSchema: transcript.schema, stepsCounted: 1,
        stepsTotal: transcript.steps.length, allStepsSignerInvocations: 0,
      },
    },
    bind: { strength: "soft", evidence_level: "client_stamped", leaf_hash: leafHash, fact_type: "resource_bound" },
    receipt: { fact_type: "resource_bound", leaf_hash: leafHash, ack_pay: false },
    outcomeAttestation: {
      outcome: att.preimage.outcome, leaf: att.leaf,
      signing_pubkey: att.signing_pubkey, preimage: att.preimage, signature: att.signature,
    },
    ledger: { spendRows: 0, verdicts: [{ outcome: "block", signer_invocations: 0 }] },
  });
  // The unsigned copy is set by hand, as a forger would: the producer may not
  // let these two differ, a JSON editor does.
  return {
    ...exported,
    outcomeAttestation: { ...exported.outcomeAttestation!, outcome: printedOutcome },
  };
}

/** Error-severity codes only: warnings (a partial signer count) never fail a bundle. */
const codes = (b: unknown) =>
  validateEvidenceBundle(b).errors.filter((e) => e.severity === "error").map((e) => e.code);
const check = (b: unknown, id: string) => verifyBundleLinkage(b).checks.find((c) => c.id === id)!;
const claim = (report: ReturnType<typeof verifyEvidenceBundle>, name: string) =>
  report.claims.find((c) => c.claim === name)?.label;

test("an honest blocked bundle still verifies", async () => {
  const honest = await bundle(BLOCKED, REFUSED, "blocked_never_signed");
  assert.deepEqual(codes(honest), []);
  assert.equal(check(honest, "outcome_leaf_recomputed").status, "verified");
  assert.equal(check(honest, "outcome_signature").status, "verified");
  assert.equal(check(honest, "outcome_binds_decision").status, "verified");
  const report = verifyEvidenceBundle(honest, {
    expectedOutcomePubkeyB58: honest.outcomeAttestation.signing_pubkey!,
  });
  assert.equal(report.validation.ok, true);
  assert.equal(report.linkage.ok, true);
  assert.equal(report.ok, true);
  assert.equal(claim(report, "internally_consistent"), "MACHINE_VERIFIED");
});

test("a settled attestation inside a blocked bundle is refused", async () => {
  const forged = await bundle(SETTLED, REFUSED, "blocked_never_signed");

  // The attestation itself is genuine: that is what made the bundle pass.
  assert.equal(check(forged, "outcome_leaf_recomputed").status, "verified");
  assert.equal(check(forged, "outcome_signature").status, "verified");

  const found = codes(forged);
  assert.ok(found.includes("outcome_contradicts_preimage"), JSON.stringify(found));
  assert.ok(found.includes("outcome_contradicts_decision"), JSON.stringify(found));

  const binds = check(forged, "outcome_binds_decision");
  assert.equal(binds.status, "failed");
  assert.match(binds.detail, /settled/);
  assert.equal(verifyBundleLinkage(forged).ok, false);

  const report = verifyEvidenceBundle(forged, {
    expectedOutcomePubkeyB58: forged.outcomeAttestation.signing_pubkey!,
  });
  assert.equal(report.validation.ok, false);
  assert.equal(report.linkage.ok, false);
  assert.equal(report.ok, false);
  assert.equal(claim(report, "internally_consistent"), "REFUTED");
});

test("the printed outcome must be the signed outcome, even when the decision agrees with the signature", async () => {
  // Decision and signature both say allow/settled; only the printed copy lies.
  const relabelled = await bundle(SETTLED, { verdict: "allow", approved: true, signerInvocations: 1 }, "expired_unused");
  assert.ok(codes(relabelled).includes("outcome_contradicts_preimage"));
  assert.equal(check(relabelled, "outcome_binds_decision").status, "failed");
  assert.equal(verifyEvidenceBundle(relabelled).ok, false);
});

test("the signed verdict must be the bundle's verdict", async () => {
  // Signed "block, never signed"; the bundle reports the decision as a warn.
  const softened = await bundle(BLOCKED, { verdict: "warn", approved: false, signerInvocations: 0 }, "blocked_never_signed");
  assert.ok(codes(softened).includes("outcome_contradicts_decision"));
  const binds = check(softened, "outcome_binds_decision");
  assert.equal(binds.status, "failed");
  assert.match(binds.detail, /verdict/);
});

test("a signed 'never signed' beside an approval or a signer call is refused", async () => {
  const approved = await bundle(BLOCKED, { verdict: "block", approved: true, signerInvocations: 0 }, "blocked_never_signed");
  assert.ok(codes(approved).includes("outcome_contradicts_decision"));
  assert.equal(check(approved, "outcome_binds_decision").status, "failed");

  const signedOnce = await bundle(BLOCKED, { verdict: "block", approved: false, signerInvocations: 1 }, "blocked_never_signed");
  assert.ok(codes(signedOnce).includes("outcome_contradicts_signer"));
  assert.equal(check(signedOnce, "outcome_binds_decision").status, "failed");
});
