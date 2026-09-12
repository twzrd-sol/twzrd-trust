import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGateAdoptionProof } from "../src/adoption-proof.js";
import { CLIENT_VERSION } from "../src/version.js";
import {
  EVIDENCE_BUNDLE_SCHEMA,
  exportEvidenceBundle,
  exportEvidenceBundleFromAdoptionProof,
  scrubForEvidence,
  writeEvidenceBundle,
} from "../src/evidence-bundle.js";
import { resourceBindLeafHash } from "../src/resource-bind.js";
import { verifyScrubClean } from "../src/evidence-verify.js";

async function run() {
  const transcript = await runGateAdoptionProof({
    integration: "gate-adoption-proof",
    runId: "bundle-test-run",
  });

  const bundle = exportEvidenceBundle({
    attribution: { integration: "gate-adoption-proof", runId: "bundle-test-run" },
    transcript,
    bind: { strength: "refuse", evidence_level: "unbound", leaf_hash: null },
    receipt: { fact_type: "none" },
    ledger: { spendRows: 0, lastHash: "genesis", verdicts: [{ outcome: "block", signer_invocations: 0 }] },
    outcomeAttestation: { outcome: "blocked_never_signed", leaf: "aa", signing_pubkey: null },
  });

  assert.equal(bundle.schema, EVIDENCE_BUNDLE_SCHEMA);
  assert.equal(bundle.package, "twzrd-x402-gate");
  assert.equal(bundle.packageVersion, CLIENT_VERSION);
  assert.equal(bundle.attribution.integration, "gate-adoption-proof");
  assert.equal(bundle.attribution.runId, "bundle-test-run");
  assert.equal(bundle.lineage, "dogfood");
  assert.equal(bundle.decision.signerInvocations, 0);
  assert.equal(bundle.decision.approved, false);
  assert.equal(bundle.transcript?.ok, true);
  assert.equal(bundle.transcript?.stepCount, 2);
  assert.ok(bundle.notExternalRunProof.includes("twzrd_dogfood_or_ci"));
  // The bundle must disclaim the server-side join, exactly as its source
  // transcript does. Dropping that line made the summary claim MORE than
  // the artifact it summarizes.
  assert.ok(bundle.notExternalRunProof.includes("this_bundle_alone_without_server_side_join"));

  // redactions[] is DERIVED, never asserted: it is a receipt of removals.
  assert.equal(bundle.redactionsDerived, true);
  assert.ok(Array.isArray(bundle.redactions));
  for (const entry of bundle.redactions) assert.match(entry, /^[a-z0-9_]+@/);

  // Signer count must be traceable to a specific step of a specific transcript,
  // and the whole-run sum published so one step's 0 cannot stand in for the run.
  assert.equal(bundle.decision.signerProvenance?.source, "transcript_step");
  assert.equal(bundle.decision.signerProvenance?.step, "block_path");
  assert.equal(bundle.decision.signerProvenance?.stepsTotal, 2);
  assert.equal(bundle.decision.signerProvenance?.allStepsSignerInvocations, 0);

  // The offer is published in the exact projection resourceBindLeafHash eats,
  // so bind.leaf_hash stops being an unverifiable pass-through blob.
  assert.ok(bundle.requirements, "requirements projection must be published");
  assert.equal(typeof resourceBindLeafHash(bundle.requirements!), "string");
  assert.equal(bundle.outcomeAttestation?.outcome, "blocked_never_signed");
  assert.equal(bundle.ledger.spendRows, 0);

  const leaked = exportEvidenceBundle({
    attribution: { integration: "acme-ops-agent-v1", runId: "op-1" },
    decision: { verdict: "block", approved: false, signerInvocations: 0 },
    receipt: {
      fact_type: "resource_bound",
      privateKey: "SHOULD_NOT_APPEAR",
    } as never,
  });
  assert.equal(leaked.lineage, "external_candidate");
  assert.equal(
    JSON.stringify(leaked).includes("SHOULD_NOT_APPEAR"),
    false,
    "private keys must be stripped",
  );

  // REGRESSION: a wallet under an innocuous key name used to survive the
  // name-only redactor while the bundle still claimed it was clean. The gate's
  // own refuse reason carries payTo=<base58>, so this is not hypothetical.
  const leakyText = exportEvidenceBundle({
    attribution: { integration: "acme-ops-agent-v1", runId: "op-2" },
    decision: {
      verdict: "block",
      approved: false,
      signerInvocations: 0,
      reason: "[twzrd] blocked payTo=sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
    },
  });
  assert.equal(
    JSON.stringify(leakyText).includes("sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk"),
    false,
    "a base58 wallet in free text must not survive the scrub",
  );
  assert.ok(leakyText.redactions.includes("base58_pubkey@decision.reason"));
  assert.equal(verifyScrubClean(leakyText).clean, true);

  // Confirmed defect: adoption-proof lets an explicit lineage flag override
  // isInternalIntegration(), so an id tripping five internal predicates can
  // still claim external_candidate. The bundle layer refuses and records it.
  const forged = exportEvidenceBundle({
    attribution: { integration: "twzrd-dogfood-internal-ci-", runId: "op-3" },
    lineage: "external_candidate",
    decision: { verdict: "block", approved: false, signerInvocations: 0 },
  });
  assert.equal(forged.lineage, "dogfood", "self-authored run cannot claim external lineage");
  assert.equal(forged.lineageCoerced?.from, "external_candidate");
  assert.equal(forged.lineageCoerced?.to, "dogfood");

  // The scrubber reports what it removed, and never invents a removal.
  const nothing = scrubForEvidence({ a: "plain", b: { c: 1 } });
  assert.deepEqual(nothing.redactions, []);
  const something = scrubForEvidence({ outer: { apiKey: "x", note: "/home/someone/.ssh/id" } });
  assert.ok(something.redactions.includes("secret_key_name@outer.apiKey"));
  assert.ok(something.redactions.includes("home_path@outer.note"));

  assert.throws(() =>
    exportEvidenceBundle({
      attribution: { integration: "", runId: "x" },
      decision: { verdict: "block", approved: false, signerInvocations: 0 },
    }),
  );

  const fromHarness = await exportEvidenceBundleFromAdoptionProof({
    integration: "demo-commerce-kit",
    runId: "00000000-0000-4000-8000-000000000099",
  });
  assert.equal(fromHarness.decision.signerInvocations, 0);
  assert.equal(fromHarness.lineage, "dogfood");

  const dir = mkdtempSync(join(tmpdir(), "twzrd-bundle-"));
  const path = join(dir, "bundle.json");
  writeEvidenceBundle(fromHarness, path);
  const read = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(read.schema, EVIDENCE_BUNDLE_SCHEMA);
  assert.equal(read.packageVersion, CLIENT_VERSION);

  console.log("evidence-bundle.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
