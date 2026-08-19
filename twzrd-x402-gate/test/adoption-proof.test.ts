/**
 * Gate adoption proof harness — focused regression.
 * Run: npx tsx test/adoption-proof.test.ts
 */
import assert from "node:assert/strict";

import {
  ADOPTION_PROOF_SELLER,
  ADOPTION_TRANSCRIPT_SCHEMA,
  runGateAdoptionProof,
} from "../src/adoption-proof.js";
import { CLIENT_VERSION } from "../src/version.js";

async function run() {
  const t = await runGateAdoptionProof({
    integration: "gate-adoption-proof",
    runId: "test-run-fixed-id",
  });

  assert.equal(t.schema, ADOPTION_TRANSCRIPT_SCHEMA);
  assert.equal(t.package, "twzrd-x402-gate");
  assert.equal(t.packageVersion, CLIENT_VERSION);
  assert.equal(t.mode, "no_spend");
  assert.equal(t.proofKind, "local_deterministic_harness");
  assert.equal(t.lineage, "dogfood");
  assert.equal(t.ok, true, `assertions failed: ${JSON.stringify(t.assertions)}`);

  assert.equal(t.steps.length, 2);
  const block = t.steps[0];
  const allow = t.steps[1];
  assert.equal(block.name, "block_path");
  assert.equal(block.abort, true);
  assert.equal(block.decisionEmitted, true);
  assert.equal(block.signerInvocations, 0);
  assert.equal(block.selectedRequirements.payTo, ADOPTION_PROOF_SELLER);
  // Hook-derived evidence (not mere harness echo of selectedRequirements):
  assert.equal(block.hookPayTo, ADOPTION_PROOF_SELLER, "onDecision.payTo must be hook-derived");
  assert.equal(
    block.preflightSellerWallet,
    ADOPTION_PROOF_SELLER,
    "preflight POST body seller_wallet must come from hook path",
  );
  assert.ok(
    typeof block.reason === "string" && block.reason.includes(ADOPTION_PROOF_SELLER),
    "abort reason must include fixture payTo",
  );
  assert.equal(block.preflightAttribution.integration, "gate-adoption-proof");
  assert.equal(block.preflightAttribution.runId, "test-run-fixed-id");
  assert.equal(block.preflightAttribution.client, `twzrd-x402-gate/${CLIENT_VERSION}`);

  assert.equal(allow.name, "allow_path");
  assert.equal(allow.abort, false);
  assert.equal(allow.approved, true);
  assert.equal(allow.signerInvocations, 0);
  assert.equal(allow.decisionEmitted, true);
  assert.equal(allow.hookPayTo, ADOPTION_PROOF_SELLER);
  assert.equal(allow.preflightSellerWallet, ADOPTION_PROOF_SELLER);

  assert.ok(t.assertions.selectedRequirementReachedHook);
  assert.ok(t.assertions.decisionEmitted);
  assert.ok(t.assertions.blockedPathNeverInvokesSigner);
  assert.ok(t.assertions.allowPathNeverInvokesSigner);
  assert.ok(t.assertions.attributionSurfaced);

  assert.ok(t.notExternalRunProof.includes("package_download_counts"));
  assert.ok(t.notExternalRunProof.includes("preflight_hits_alone"));
  assert.equal(t.acceptanceDoc, "docs/strategy/gate-adoption-operator-proof.md");

  // external_candidate lineage when operator-style integration id is used
  const ext = await runGateAdoptionProof({
    integration: "acme-ops-agent-v1",
    runId: "op-run-1",
  });
  assert.equal(ext.lineage, "external_candidate");
  assert.equal(ext.ok, true);

  console.log("adoption-proof.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
