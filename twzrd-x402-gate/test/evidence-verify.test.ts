/**
 * Verification tests: a foreign operator must reach the SAME verdict we do,
 * offline and deterministically. No network, no clock dependence, no fixtures
 * fetched from anywhere.
 */
import assert from "node:assert/strict";

import { ADOPTION_PROOF_SELLER, runGateAdoptionProof } from "../src/adoption-proof.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { exportEvidenceBundle, exportEvidenceBundleFromAdoptionProof } from "../src/evidence-bundle.js";
import { buildOutcomeAttestation } from "../src/outcome-attestation.js";
import { resourceBindLeafHash } from "../src/resource-bind.js";
import {
  looksSelfAuthored,
  maskSecretsInText,
  scanForSecretValues,
  validateEvidenceBundle,
  verifyBundleLinkage,
  verifyEvidenceBundle,
  verifyScrubClean,
} from "../src/evidence-verify.js";

const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);
const hasCode = (r: { errors: Array<{ code: string }> }, c: string) => codes(r).includes(c);

async function baseBundle() {
  return exportEvidenceBundleFromAdoptionProof({
    integration: "acme-ops-agent-v1",
    runId: "00000000-0000-4000-8000-0000000000aa",
  });
}

async function run() {
  /* ---------------- 1. value scanning: shape, not key name ---------------- */
  const cases: Array<[string, unknown]> = [
    ["pem_block", { note: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----" }],
    ["jwt", { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N" }],
    ["bearer_token", { h: "Bearer sk_live_abcdefghijklmnop" }],
    ["env_assignment", { note: "TWZRD_API_KEY=abc123" }],
    ["home_path", { note: "/home/twzrd/wzrd-final/x" }],
    ["long_hex", { note: "a".repeat(64) }],
    ["evm_address", { note: "0x3803A1a1b2C3d4E5f60718293A4b5C6d7E8f9012" }],
    ["base58_pubkey", { innocuous: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk" }],
    ["base58_secret_key", { innocuous: "5".repeat(88) }],
  ];
  for (const [kind, value] of cases) {
    const found = scanForSecretValues(value);
    assert.ok(found.some((f) => f.kind === kind), `scanner must catch ${kind}`);
    assert.ok(
      found.every((f) => !JSON.stringify(f).includes("BEGIN PRIVATE")),
      "a finding must never echo the secret it found",
    );
  }
  // The whole point: an innocuous KEY NAME is no defence.
  assert.equal(verifyScrubClean({ innocuous: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk" }).clean, false);

  /* ---- 2. ordinary bundle content must NOT trip the scanner ------------- */
  for (const clean of [
    { exportedAt: "2026-09-02T03:33:25.913Z" },
    { runId: "00000000-0000-4000-8000-00000000dead" },
    { schema: "twzrd.evidence_bundle.v1", proofKind: "local_deterministic_harness" },
    { verdict: "warn", reason: "twzrd_can_spend_false", outcome: "blocked_never_signed" },
    { acceptanceDoc: "docs/strategy/gate-adoption-operator-proof.md" },
    { resource: "https://merchant.example/twzrd-adoption-proof" },
  ]) {
    assert.equal(verifyScrubClean(clean).clean, true, `false positive on ${JSON.stringify(clean)}`);
  }

  /* ---- 3. masking is the same rule set the scanner enforces ------------- */
  const masked = maskSecretsInText("payTo=sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk done");
  assert.ok(masked.removed.includes("base58_pubkey"));
  assert.equal(masked.text.includes("sLJ4une"), false);
  assert.equal(verifyScrubClean({ x: masked.text }).clean, true);

  /* ---------------- 4. schema validation --------------------------------- */
  const good = await baseBundle();
  assert.equal(validateEvidenceBundle(good).ok, true, JSON.stringify(codes(validateEvidenceBundle(good))));
  assert.equal(validateEvidenceBundle("nope").ok, false);
  assert.ok(hasCode(validateEvidenceBundle({ ...good, schema: "v2" }), "schema_mismatch"));
  assert.ok(hasCode(validateEvidenceBundle({ ...good, packageVersion: "" }), "invalid_field"));
  assert.ok(hasCode(validateEvidenceBundle({ ...good, lineage: "totally_external" }), "lineage_invalid"));
  assert.ok(hasCode(validateEvidenceBundle({ ...good, bind: { leaf_hash: "zz" } }), "bind_leaf_malformed"));
  assert.ok(hasCode(
    validateEvidenceBundle({ ...good, outcomeAttestation: { outcome: "vibes" } }), "outcome_invalid"));

  /* ---- 5. self-contradiction is REJECTED, not merely noted -------------- */
  const refusedButSigned = { ...good, decision: { ...good.decision, approved: false, signerInvocations: 3 } };
  const r1 = validateEvidenceBundle(refusedButSigned);
  assert.equal(r1.ok, false, "approved:false + signerInvocations>0 must not validate");
  assert.ok(hasCode(r1, "refused_but_signed"));

  assert.ok(hasCode(validateEvidenceBundle(
    { ...good, outcomeAttestation: { outcome: "settled" } }), "outcome_contradicts_decision"));
  assert.ok(hasCode(validateEvidenceBundle({
    ...good,
    decision: { ...good.decision, signerInvocations: 1 },
    outcomeAttestation: { outcome: "blocked_never_signed" },
  }), "outcome_contradicts_signer"));

  // Signer provenance is required for traceability; the real export supplies it.
  assert.ok(hasCode(
    validateEvidenceBundle({ ...good, decision: { ...good.decision, signerProvenance: undefined } }),
    "signer_provenance_missing"));
  assert.equal(good.decision.signerProvenance?.step, "block_path");

  /* ---------------- 6. lineage honesty ----------------------------------- */
  assert.equal(looksSelfAuthored("twzrd-dogfood-internal-ci-"), true);
  assert.equal(looksSelfAuthored("acme-ops-agent-v1"), false);

  // Hand-forged document (bypassing the producer's coercion) must still fail.
  const forged = { ...good, attribution: { integration: "twzrd-dogfood-internal-ci-", runId: "x" },
    lineage: "external_candidate" };
  assert.equal(validateEvidenceBundle(forged).ok, false);
  assert.ok(hasCode(validateEvidenceBundle(forged), "lineage_forged"));

  assert.ok(hasCode(validateEvidenceBundle({ ...good, externalRunEligible: true }), "external_run_asserted"));
  assert.ok(hasCode(validateEvidenceBundle({ ...good, note: "verified EXTERNAL_RUN" }), "external_run_asserted"));
  // ...but the disclaimer list itself may name it.
  assert.equal(validateEvidenceBundle(good).ok, true);

  /* ---------------- 7. bind + receipt linkage ---------------------------- */
  const link = (b: unknown, id: string) =>
    verifyBundleLinkage(b).checks.find((c) => c.id === id)!;

  // Absent inputs must read "unchecked", never "verified".
  assert.equal(link(good, "bind_leaf_recomputed").status, "unchecked");

  const transcript = await runGateAdoptionProof({
    integration: "acme-ops-agent-v1", runId: "00000000-0000-4000-8000-0000000000bb",
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

  const signer = createLocalDecisionSigner();
  const att = await buildOutcomeAttestation({
    decisionId: "dec-evidence-1",
    counterparty: ADOPTION_PROOF_SELLER,
    verdict: "block",
    outcome: "blocked_never_signed",
    timestampUnix: 1_767_225_600,
    intentHash: null, payer: null, settlementTx: null, preflightId: 1,
  }, signer);

  const full = exportEvidenceBundle({
    attribution: { integration: "acme-ops-agent-v1", runId: "00000000-0000-4000-8000-0000000000bb" },
    transcript,
    requirements: req,
    decision: {
      verdict: "block", approved: false, signerInvocations: 0,
      decisionId: "dec-evidence-1", preflightId: 1,
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

  assert.equal(link(full, "bind_leaf_recomputed").status, "verified");
  assert.equal(link(full, "bind_strength_level").status, "verified");
  assert.equal(link(full, "receipt_binds_bind").status, "verified");

  // TEETH: a bind leaf lifted from a DIFFERENT offer must fail, not pass.
  const otherLeaf = resourceBindLeafHash({ ...req, amount: "999999" });
  assert.notEqual(otherLeaf, leafHash);
  assert.equal(link({ ...full, bind: { ...full.bind, leaf_hash: otherLeaf } }, "bind_leaf_recomputed").status, "failed");
  // A receipt anchored to a different bind must fail too.
  assert.equal(link({ ...full, receipt: { ...full.receipt, leaf_hash: otherLeaf } }, "receipt_binds_bind").status, "failed");
  // strength/evidence_level pairs outside resource-bind.ts's own mapping are forged.
  assert.equal(link({ ...full, bind: { ...full.bind, evidence_level: "tx_included" } }, "bind_strength_level").status, "failed");
  // A resource_bound receipt with nothing to anchor to is not "unchecked" — it is wrong.
  assert.equal(link({ ...full, bind: undefined }, "receipt_binds_bind").status, "failed");

  /* ---------------- 8. outcome attestation ------------------------------- */
  assert.equal(link(full, "outcome_leaf_recomputed").status, "verified");
  assert.equal(link(full, "outcome_signature").status, "verified");
  assert.equal(link(full, "outcome_binds_decision").status, "verified");

  // Tampered preimage: the leaf no longer describes it.
  const tampered = { ...full, outcomeAttestation: {
    ...full.outcomeAttestation!, preimage: { ...att.preimage, counterparty: "someone-else" } } };
  assert.equal(link(tampered, "outcome_leaf_recomputed").status, "failed");

  // A signature from a different key must not verify against the published one.
  const other = await buildOutcomeAttestation(
    { decisionId: "dec-evidence-1", counterparty: ADOPTION_PROOF_SELLER, verdict: "block",
      outcome: "blocked_never_signed", timestampUnix: 1_767_225_601,
      intentHash: null, payer: null, settlementTx: null, preflightId: 1 },
    createLocalDecisionSigner());
  assert.equal(link({ ...full, outcomeAttestation: {
    ...full.outcomeAttestation!, signature: other.signature } }, "outcome_signature").status, "failed");

  // Attestation for a different decision must not silently pass.
  assert.equal(link({ ...full, decision: { ...full.decision, decisionId: "dec-other" } },
    "outcome_binds_decision").status, "failed");

  /* ---------------- 9. end-to-end report + claim labelling ---------------- */
  const report = verifyEvidenceBundle(full);
  assert.equal(report.validation.ok, true, JSON.stringify(codes(report.validation)));
  assert.equal(report.scrub.clean, true, JSON.stringify(report.scrub.violations));
  assert.equal(report.linkage.ok, true);
  assert.equal(report.ok, true);

  // Deterministic: same bytes in, same digest out (no clock, no network).
  assert.equal(report.bundleDigest, verifyEvidenceBundle(full).bundleDigest);
  assert.match(report.bundleDigest, /^[0-9a-f]{64}$/);

  const label = (c: string) => report.claims.find((x) => x.claim === c)?.label;
  assert.equal(label("scrub_clean"), "MACHINE_VERIFIED");
  assert.equal(label("well_formed_v1"), "MACHINE_VERIFIED");
  assert.equal(label("lineage_honest"), "MACHINE_VERIFIED");
  assert.equal(label("redactions_derived"), "MACHINE_VERIFIED");
  assert.equal(label("bind_leaf_recomputed"), "MACHINE_VERIFIED");
  assert.equal(label("receipt_binds_bind"), "MACHINE_VERIFIED");
  assert.equal(label("outcome_leaf_recomputed"), "MACHINE_VERIFIED");

  // Verifying a signature against the key the SAME document supplies proves
  // self-consistency, not authenticity — a forger rewrites both. It is only
  // promoted when the caller anchors on an independently published key.
  assert.equal(verifyBundleLinkage(full).checks.find((c) => c.id === "outcome_signature")?.selfAnchored, true);
  assert.equal(label("outcome_signature"), "ASSERTED");
  const anchored = verifyEvidenceBundle(full, {
    expectedOutcomePubkeyB58: full.outcomeAttestation!.signing_pubkey!,
  });
  assert.equal(anchored.claims.find((c) => c.claim === "outcome_signature")?.label, "MACHINE_VERIFIED");

  // The two that must NEVER be promoted, however green everything else is.
  assert.equal(label("signer_never_invoked"), "ASSERTED",
    "a document cannot prove a signer was never called");
  assert.equal(label("external_adoption"), "ASSERTED",
    "no locally produced bundle is external adoption evidence");
  assert.equal(label("transcript_assertions"), "ASSERTED");

  // A bundle that fails ANY of the three layers must not report ok.
  assert.equal(verifyEvidenceBundle(refusedButSigned).ok, false);
  assert.equal(verifyEvidenceBundle({ ...full, leaked: "/home/twzrd/.ssh/id_ed25519" }).ok, false);

  console.log("evidence-verify.test.ts: ALL PASSED (9 sections)");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
