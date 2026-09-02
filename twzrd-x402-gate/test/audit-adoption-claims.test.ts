/**
 * AUDIT: adoption-claim forgery + README claims about implicit paid intel.
 *
 * Finding B (conductor-confirmed) — explicit `lineage` overrides
 * isInternalIntegration() in runGateAdoptionProof. The SAME override exists in
 * exportEvidenceBundle (opts.lineage, then a hand-editable transcript.lineage),
 * so a twzrd-/ci- integration can publish a `twzrd.evidence_bundle.v1` labelled
 * external_candidate. Lineage must only ever TIGHTEN: an internal id is dogfood
 * no matter what the caller claims; a non-internal id may self-declare dogfood.
 *
 * README ("Why pre-spend"): "Paid intel (quickCheck, autoReceipt) is opt-in and
 * never runs implicitly." For installTwzrdAutoGate(payWrap) that is false: the
 * payWrap output is auto-wired as x402Fetch, buyer Path A defaults switch on,
 * and a plain `warn` settles $0.001 to TWZRD through the buyer's wallet with no
 * opt-in. Pinned here so the doc (not this test) gets corrected.
 * Offline, deterministic. Run: npx tsx test/audit-adoption-claims.test.ts
 */
import assert from "node:assert/strict";

import { runGateAdoptionProof, isInternalIntegration } from "../src/adoption-proof.js";
import { exportEvidenceBundle, exportEvidenceBundleFromAdoptionProof } from "../src/evidence-bundle.js";
import { installTwzrdAutoGate } from "../src/auto-gate.js";

const INTERNAL = "twzrd-dogfood-internal-ci-";
const decision = { verdict: "block", approved: false, signerInvocations: 0 };

async function run() {
  assert.equal(isInternalIntegration(INTERNAL), true);

  // 1. exportEvidenceBundle: explicit lineage must not launder an internal id.
  {
    const b = exportEvidenceBundle({ attribution: { integration: INTERNAL, runId: "r1" }, lineage: "external_candidate", decision });
    assert.equal(b.lineage, "dogfood", "evidence bundle accepted a forged external_candidate lineage");
  }

  // 2. exportEvidenceBundle: a hand-edited transcript.lineage must not either.
  {
    const t = await runGateAdoptionProof({ integration: INTERNAL, runId: "r2" });
    const forged = { ...t, lineage: "external_candidate" as const };
    const b = exportEvidenceBundle({ attribution: { integration: INTERNAL, runId: "r2" }, transcript: forged, decision });
    assert.equal(b.lineage, "dogfood", "transcript.lineage overrode isInternalIntegration");
  }

  // 3. Finding B itself (runGateAdoptionProof) + the CLI-shaped export path.
  {
    const t = await runGateAdoptionProof({ integration: INTERNAL, runId: "r3", lineage: "external_candidate" });
    assert.equal(t.lineage, "dogfood");
    assert.equal(t.ok, true);
    const b = await exportEvidenceBundleFromAdoptionProof({ integration: INTERNAL, runId: "r3", lineage: "external_candidate" });
    assert.equal(b.lineage, "dogfood");
  }

  // 4. Tightening stays allowed: a non-internal operator may self-declare dogfood.
  {
    const t = await runGateAdoptionProof({ integration: "acme-ops-agent-v1", runId: "r4", lineage: "dogfood" });
    assert.equal(t.lineage, "dogfood");
    const u = await runGateAdoptionProof({ integration: "acme-ops-agent-v1", runId: "r5" });
    assert.equal(u.lineage, "external_candidate");
  }

  // 5. README claim check: payWrap adapter + warn => implicit $0.001 quick-tier settle.
  {
    const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
    const paidUrls: string[] = [];
    const raw: typeof fetch = (async (input: unknown) => {
      const u = String(input);
      if (u.includes("/v1/intel/merchant_card/")) return new Response("{}", { status: 404 });
      if (u.includes("/v1/intel/preflight")) {
        return new Response(JSON.stringify({ readiness_card: { decision: "warn", trust_score: 45 } }), { status: 200 });
      }
      // Both the merchant resource AND TWZRD's quick tier are x402-paid (402 first).
      return new Response(JSON.stringify({ x402Version: 1, accepts: [{ network: "solana", payTo: SELLER, maxAmountRequired: "1000", resource: u }] }), { status: 402 });
    }) as unknown as typeof fetch;
    const payWrap = (g: typeof fetch): typeof fetch =>
      (async (input: unknown, init?: unknown) => {
        const r = await g(input as never, init as never);
        if (r.status !== 402) return r;
        const u = String(input);
        paidUrls.push(u); // the buyer's wallet signs here
        if (u.includes("/v1/intel/quick/")) {
          return new Response(JSON.stringify({ score: 80, tier: "Gold", paid: true }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
    const paying = installTwzrdAutoGate(payWrap, { rawFetch: raw, fetch: raw });
    await paying("https://merchant.example/paid");
    // OBSERVED (pinned, not endorsed): the wallet pays TWZRD's $0.001 quick tier
    // BEFORE the merchant, with no flag set. QUICKSTART 3b documents this;
    // README "Why pre-spend" says paid intel "never runs implicitly". One is wrong.
    // If Path A is ever made opt-in on this adapter, flip these two assertions.
    assert.equal(paidUrls.length, 2, "paid URLs: " + paidUrls.join(","));
    assert.ok(paidUrls[0].includes("/v1/intel/quick/"), "implicit $0.001 quick-tier settle on warn");
    assert.equal(paidUrls[1], "https://merchant.example/paid");
  }

  console.log("audit-adoption-claims.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("audit-adoption-claims.test.ts FAILED:", e);
  process.exit(1);
});
