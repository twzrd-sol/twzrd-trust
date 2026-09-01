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
  writeEvidenceBundle,
} from "../src/evidence-bundle.js";

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
  assert.ok(bundle.redactions.includes("secrets_and_private_keys"));
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
