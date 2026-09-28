/**
 * 0.11.0 unevaluated-seller policy: a seller intel has never evaluated is
 * allowed up to the card's own recommended_cap_usdc, refused above it, refused
 * when no cap or no price is known, and refused outright with
 * refuseUnevaluated: true (the 0.9.9–0.9.16 default).
 * Run: npx tsx test/unevaluated-seller.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { evaluateReadinessCard, twzrdApprovePayment } from "../src/policy.js";
import { evaluateBeforePaymentCreation } from "../src/x402-client-hook.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const bd = () => new Set(["block"]);

/** The card live intel serves for a wallet it has never seen (2026-09-28). */
const unknownCard = (over: Record<string, unknown> = {}) => ({
  decision: "warn",
  trust_score: 45,
  score: null,
  null_reason: "unknown_subject",
  can_spend: true,
  recommended_cap_usdc: 0.01,
  ...over,
});

/** Intel stub: preflight answers `card`; merchant_card answers `merchant`. */
function intel(card: Record<string, unknown>, merchant: Record<string, unknown> = { wash_flagged: null }) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const body = /\/merchant_card\//.test(String(url)) ? merchant : { readiness_card: card };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Paying fetch that records every paid hop (/quick, /trust). */
function paying() {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ pubkey: SELLER, tier: null, score: null, paid: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const evalCard = (card: Record<string, unknown>, extra: { priceUsdc?: number; refuseUnevaluated?: boolean; gateOnCanSpend?: boolean } = {}) =>
  evaluateReadinessCard({ card, preflightMinScore: 40, blockDecisions: bd(), ...extra });

async function run() {
  // --- pure policy table ---
  {
    const within = evalCard(unknownCard(), { priceUsdc: 0.01 });
    assert.equal(within.approved, true);
    assert.equal(within.verdict, "warn");
    assert.equal(within.score, null, "45 is a floor, not a score");
    assert.equal(within.unevaluated, true);
    assert.equal(within.recommendedCapUsdc, 0.01);
    assert.equal(within.reason, "twzrd_unevaluated_within_cap_0.01_le_0.01");

    const over = evalCard(unknownCard(), { priceUsdc: 0.02 });
    assert.equal(over.approved, false);
    assert.equal(over.overRecommendedCap, true);
    assert.equal(over.reason, "twzrd_unevaluated_over_cap_0.02_gt_0.01");

    const noCap = evalCard(unknownCard({ recommended_cap_usdc: undefined }), { priceUsdc: 0.001 });
    assert.equal(noCap.approved, false);
    assert.equal(noCap.reason, "twzrd_unevaluated_no_cap_unknown_subject");

    const badCap = evalCard(unknownCard({ recommended_cap_usdc: -1 }), { priceUsdc: 0.001 });
    assert.equal(badCap.reason, "twzrd_unevaluated_no_cap_unknown_subject");

    const noPrice = evalCard(unknownCard());
    assert.equal(noPrice.approved, false);
    assert.equal(noPrice.reason, "twzrd_unevaluated_unknown_price_unknown_subject");

    const strict = evalCard(unknownCard(), { priceUsdc: 0.001, refuseUnevaluated: true });
    assert.equal(strict.approved, false);
    assert.equal(strict.verdict, "unknown");
    assert.equal(strict.reason, "twzrd_unevaluated_subject_unknown_subject");

    // A decision other than allow/warn is never loosened by the cap.
    const odd = evalCard(unknownCard({ decision: "insufficient_evidence" }), { priceUsdc: 0.001 });
    assert.equal(odd.approved, false);
    assert.equal(odd.reason, "twzrd_unevaluated_subject_unknown_subject");

    // block stays block (checked before the unevaluated branch).
    const blocked = evalCard(unknownCard({ decision: "block" }), { priceUsdc: 0.001 });
    assert.equal(blocked.reason, "twzrd_decision_block");

    // can_spend false only refuses when the caller opted into gateOnCanSpend.
    assert.equal(evalCard(unknownCard({ can_spend: false }), { priceUsdc: 0.001 }).approved, true);
    assert.equal(
      evalCard(unknownCard({ can_spend: false }), { priceUsdc: 0.001, gateOnCanSpend: true }).reason,
      "twzrd_can_spend_false",
    );

    // score: null with no null_reason and no trust_score is still unevaluated,
    // not "score 0 below 40".
    const bare = evalCard({ decision: "warn", score: null, recommended_cap_usdc: 0.01 }, { priceUsdc: 0.001 });
    assert.equal(bare.approved, true);
    assert.equal(bare.reason, "twzrd_unevaluated_within_cap_0.001_le_0.01");
    const bareNoCap = evalCard({ decision: "warn", score: null }, { priceUsdc: 0.001 });
    assert.equal(bareNoCap.reason, "twzrd_unevaluated_no_cap_score_null");

    // An evaluated card is untouched: floor, allow and warn reasons as before.
    assert.equal(evalCard({ decision: "warn", trust_score: 50 }, { priceUsdc: 0.001 }).reason, "twzrd_warn_allowed");
    assert.equal(evalCard({ decision: "allow", trust_score: 20 }, { priceUsdc: 0.001 }).reason, "twzrd_score_20_below_40");
  }

  // --- config knob + env ---
  {
    assert.equal(resolveConfig({}).refuseUnevaluated, false);
    assert.equal(resolveConfig({ refuseUnevaluated: true }).refuseUnevaluated, true);
    for (const v of ["true", "1"]) {
      process.env.TWZRD_REFUSE_UNEVALUATED = v;
      try {
        assert.equal(resolveConfig({}).refuseUnevaluated, true, v);
        assert.equal(resolveConfig({ refuseUnevaluated: false }).refuseUnevaluated, false, "override wins");
      } finally {
        delete process.env.TWZRD_REFUSE_UNEVALUATED;
      }
    }
  }

  // --- twzrdApprovePayment: wash still refuses an unevaluated seller within its cap ---
  {
    const clean = await twzrdApprovePayment(
      { payTo: SELLER, chain: "solana", priceUsdc: 0.005 },
      resolveConfig({ fetch: intel(unknownCard()) }),
    );
    assert.equal(clean.approved, true, clean.reason);
    assert.equal(clean.unevaluated, true);

    const washed = await twzrdApprovePayment(
      { payTo: SELLER, chain: "solana", priceUsdc: 0.005 },
      resolveConfig({ fetch: intel(unknownCard(), { wash_flagged: true }) }),
    );
    assert.equal(washed.approved, false);
    assert.equal(washed.reason, "twzrd_wash_flagged");
  }

  // --- x402 hook with buyer defaults: no paid /quick for an unevaluated seller ---
  {
    const x402 = paying();
    const result = await evaluateBeforePaymentCreation(
      { payTo: SELLER, network: "solana", amount: "5000", resource: "https://seller.example/paid" },
      { fetch: intel(unknownCard()), x402Fetch: x402 },
    );
    assert.ok(!result || result.abort !== true, `unexpected abort: ${JSON.stringify(result)}`);
    assert.equal(x402.calls.length, 0, "no paid hop can score a seller intel never saw");

    // Control: an evaluated warn with the same defaults still takes the $0.001 hop.
    const x402b = paying();
    await evaluateBeforePaymentCreation(
      { payTo: SELLER, network: "solana", amount: "5000", resource: "https://seller.example/paid" },
      { fetch: intel({ decision: "warn", trust_score: 50, can_spend: true }), x402Fetch: x402b },
    );
    assert.equal(x402b.calls.length, 1);
    assert.match(x402b.calls[0], /\/v1\/intel\/quick\//);
  }

  // --- evaluate_x402_resource: same skip, and refuseUnevaluated passes through ---
  {
    const reqs = { payTo: SELLER, amount: "5000", maxAmountRequired: "5000", network: "solana", resource: "https://seller.example/paid" };
    const x402 = paying();
    const r = await evaluate_x402_resource("https://seller.example/paid", reqs, {
      fetch: intel(unknownCard()),
      x402Fetch: x402,
      escalateOnWarn: { minSpendUsdc: 0 },
    });
    assert.equal(r.approved, true, r.reason);
    assert.equal(r.escalated, undefined);
    assert.equal(x402.calls.length, 0);

    const strict = await evaluate_x402_resource("https://seller.example/paid", reqs, {
      fetch: intel(unknownCard()),
      refuseUnevaluated: true,
    });
    assert.equal(strict.approved, false);
    assert.equal(strict.reason, "twzrd_unevaluated_subject_unknown_subject");
  }

  console.log("unevaluated-seller.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("unevaluated-seller.test.ts FAILED:", e);
  process.exit(1);
});
