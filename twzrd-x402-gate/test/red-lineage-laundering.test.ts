/**
 * RED TEAM — blast radius of the already-confirmed forgeable-lineage defect.
 *
 * Known: adoption-proof.ts:217-219 makes isInternalIntegration() a DEFAULT, not
 * a GUARD (`opts.lineage ?? (isInternalIntegration(...) ? … : …)`). This file
 * does not re-litigate that; it measures how far a forged lineage travels.
 *
 * Answer: all the way into the evidence bundle an operator publishes, because
 * evidence-bundle.ts repeats the same one-line override TWICE and never
 * re-derives lineage from the integration id it was handed.
 *
 * `DEFECT:` assertions encode CURRENT behavior. Run:
 *   npx tsx test/red-lineage-laundering.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isInternalIntegration, runGateAdoptionProof } from "../src/adoption-proof.js";
import {
  exportEvidenceBundle,
  exportEvidenceBundleFromAdoptionProof,
} from "../src/evidence-bundle.js";

/** Trips five separate internal predicates at once: twzrd-, dogfood, internal, ci-, test-. */
const SCREAMS_INTERNAL = "twzrd-dogfood-internal-ci-test-harness";

async function run() {
  // The id is unambiguously internal by the package's own classifier.
  assert.equal(isInternalIntegration(SCREAMS_INTERNAL), true, "fixture sanity");
  for (const marker of ["twzrd-", "dogfood", "internal", "ci-", "test-"]) {
    assert.ok(SCREAMS_INTERNAL.includes(marker), `fixture trips predicate ${marker}`);
  }

  /* ---------- DEFECT #21 (high): the transcript accepts the forgery ---------- */
  // SHOULD BE: an explicit lineage that contradicts isInternalIntegration() is
  // rejected, or is recorded alongside the derived value as a claimed-vs-derived
  // pair so a verifier can see the disagreement.
  const honest = await runGateAdoptionProof({ integration: SCREAMS_INTERNAL, runId: "r-honest" });
  assert.equal(honest.lineage, "dogfood", "with no override the classifier is correct");

  const forged = await runGateAdoptionProof({
    integration: SCREAMS_INTERNAL, runId: "r-forged", lineage: "external_candidate",
  });
  assert.equal(forged.lineage, "external_candidate",
    "DEFECT: one flag overrides five internal predicates");
  assert.equal(forged.ok, true, "DEFECT: and the transcript still self-reports ok:true");
  assert.equal(forged.integration, SCREAMS_INTERNAL,
    "the contradicting evidence is present in the same object and simply not consulted");

  /* ---------- DEFECT #22 (high): the forgery LAUNDERS into the evidence bundle ---------- */
  // exportEvidenceBundleFromAdoptionProof (evidence-bundle.ts:198) copies
  // `transcript.lineage` straight through, and exportEvidenceBundle
  // (evidence-bundle.ts:139-142) repeats the identical `opts.lineage ?? … ??
  // derive` shape. So the derived value is only ever a third fallback and is
  // never compared against the two claims ahead of it.
  // SHOULD BE: the bundle re-derives from attribution.integration and refuses
  // (or flags) a lineage that contradicts it.
  {
    const bundle = await exportEvidenceBundleFromAdoptionProof({
      integration: SCREAMS_INTERNAL, runId: "r-forged", lineage: "external_candidate",
    });
    assert.equal(bundle.attribution.integration, SCREAMS_INTERNAL);
    assert.equal(bundle.lineage, "external_candidate",
      "DEFECT: a published bundle labels a self-authored dogfood run as an external candidate");
    assert.equal(isInternalIntegration(bundle.attribution.integration), true,
      "DEFECT: the bundle carries, unused, the exact field that disproves its own lineage");

    // The bundle's own disqualifier list names dogfood/CI as not-external...
    assert.ok(bundle.notExternalRunProof.includes("twzrd_dogfood_or_ci"),
      "the bundle asserts dogfood/CI does not count as external");
    // ...but nothing in the export path evaluates it, so it is decorative text.
    assert.equal(bundle.lineage, "external_candidate",
      "DEFECT: that disqualifier is unenforced — the run it describes is labelled external anyway");
  }

  // The direct export has the same hole, with no transcript involved at all.
  {
    const direct = exportEvidenceBundle({
      attribution: { integration: SCREAMS_INTERNAL, runId: "r-direct" },
      lineage: "external_candidate",
    });
    assert.equal(direct.lineage, "external_candidate",
      "DEFECT: exportEvidenceBundle takes lineage on trust from its caller too");
    const derived = exportEvidenceBundle({
      attribution: { integration: SCREAMS_INTERNAL, runId: "r-direct" },
    });
    assert.equal(derived.lineage, "dogfood",
      "the classifier is right whenever it is actually allowed to run");
  }

  /* ---------- DEFECT #23 (medium): acceptanceDoc is asserted, never checked ---------- */
  // Every transcript cites an acceptance document by relative path. Nothing
  // verifies the path resolves, so the citation can (and here does) dangle.
  // SHOULD BE: the path is resolved and the transcript refuses to claim ok:true
  // while citing a document that is not in the published tree.
  {
    assert.equal(honest.acceptanceDoc, "docs/strategy/gate-adoption-operator-proof.md");
    const testDir = dirname(fileURLToPath(import.meta.url));
    const roots = [resolve(testDir, "..", ".."), resolve(testDir, "..")];
    const resolves = roots.some((r) => existsSync(join(r, honest.acceptanceDoc)));
    // The point is independence, not today's filesystem: ok:true is emitted with
    // the same citation whether or not the document is present. Asserted both
    // ways so this stays honest after the doc is added.
    assert.equal(honest.ok, true,
      "DEFECT: transcript validity is entirely independent of whether its citation resolves");
    assert.equal(
      (await runGateAdoptionProof({ integration: "external-partner-x", runId: "r2" })).acceptanceDoc,
      honest.acceptanceDoc,
      "DEFECT: the citation is a hardcoded constant, emitted unconditionally for every run",
    );
    console.log(`  (acceptanceDoc resolves in this worktree: ${resolves})`);
  }

  console.log("red-lineage-laundering.test.ts: ALL PASSED (3 DEFECTS encoded — see DEFECT: comments)");
}

run().catch((e) => {
  console.error("red-lineage-laundering.test.ts FAILED:", e);
  process.exit(1);
});
