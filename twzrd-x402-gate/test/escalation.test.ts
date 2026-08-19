/**
 * Autonomous risk-escalation (escalateOnWarn) contract test — no real network / no real spend.
 * Run: npx tsx test/escalation.test.ts
 *
 * Locks the autonomous risk loop: on a *proceeding* `warn`, the gate settles the cheap
 * $0.001 quick tier via x402Fetch and RE-DECIDES on the paid score — below the floor the
 * payment is denied, at/above it proceeds. The paid call fires from the agent's own policy,
 * and the paid signal gates the spend (only tightens; never loosens a block/allow).
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import type { X402PaymentRequirements } from "../src/types.js";

const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const URL_ = "https://merchant/x";
const REQ: X402PaymentRequirements = {
  payTo: SELLER,
  maxAmountRequired: "50000", // $0.05
  resource: URL_,
};

// config.fetch: the free preflight POST -> returns a readiness_card.
function preflightFetch(card: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// x402Fetch: settles the $0.001 quick GET -> returns tier+score. Tracks calls.
function quickX402(score: number | null, tier: string | null = null) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ pubkey: SELLER, tier, score, paid: true, charged_amount_usdc: 0.001 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch & { calls: string[] };
  (fn as { calls: string[] }).calls = calls;
  return fn as typeof fetch & { calls: string[] };
}

async function run() {
  // 1. warn + escalate + paid score BELOW floor -> denied (autonomous block on paid intel).
  {
    const x402 = quickX402(28);
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: {},
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 1, "one paid quick call on warn");
    assert.match(x402.calls[0], /\/v1\/intel\/quick\//, "escalation hits the cheap quick tier, not trust");
    assert.equal(r.escalated, true);
    assert.equal(r.escalatedScore, 28);
    assert.equal(r.approved, false, "paid score 28 < floor 40 -> denied");
    assert.match(r.reason, /twzrd_escalated_warn_block/);
    assert.equal(r.trustScore, 28, "trustScore now reflects the sharper paid signal");
  }

  // 2. warn + escalate + paid score AT/ABOVE floor -> proceeds, sharpened.
  {
    const x402 = quickX402(82, "Silver");
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: {},
      x402Fetch: x402,
    });
    assert.equal(r.approved, true, "paid score 82 >= floor 40 -> proceeds");
    assert.equal(r.escalated, true);
    assert.equal(r.escalatedScore, 82);
    assert.equal(r.escalatedTier, "Silver");
    assert.match(r.reason, /twzrd_escalated_warn_allow/);
  }

  // 3. custom blockBelowScore: paid 82 < 90 -> denied.
  {
    const x402 = quickX402(82);
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: { blockBelowScore: 90 },
      x402Fetch: x402,
    });
    assert.equal(r.approved, false, "paid 82 < custom floor 90 -> denied");
    assert.match(r.reason, /twzrd_escalated_warn_block/);
  }

  // 4. minSpendUsdc gate: price 0.05 < minSpend 1.00 -> NO escalation (no paid call).
  {
    const x402 = quickX402(10);
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: { minSpendUsdc: 1.0 },
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 0, "sub-threshold spend does not pay to escalate");
    assert.equal(r.escalated, undefined, "no escalation");
    assert.equal(r.approved, true, "base warn proceeds");
  }

  // 5. allow decision -> no escalation (only warn escalates).
  {
    const x402 = quickX402(10);
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "allow", trust_score: 90 }),
      escalateOnWarn: {},
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 0, "allow never escalates");
    assert.equal(r.escalated, undefined);
    assert.equal(r.approved, true);
  }

  // 6. escalateOnWarn set but no x402Fetch -> fail-soft, no escalation, base warn preserved.
  {
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: {},
    });
    assert.equal(r.escalated, undefined, "no x402Fetch -> escalation skipped");
    assert.equal(r.approved, true, "base warn preserved");
  }

  // 7. quick tier unreachable (non-200) -> fail-soft: base warn preserved, escalation flagged.
  {
    const bad = (async () => new Response("{}", { status: 402 })) as unknown as typeof fetch;
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: {},
      x402Fetch: bad,
    });
    assert.equal(r.escalated, true, "escalation attempted");
    assert.equal(r.escalatedScore, null, "quick could not answer");
    assert.equal(r.approved, true, "fail-soft preserves the base warn decision");
  }

  // 8. NOT set -> current behavior (warn proceeds, no paid call). Regression guard.
  {
    const x402 = quickX402(10);
    const r = await evaluate_x402_resource(URL_, REQ, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 0, "no escalation when escalateOnWarn is unset");
    assert.equal(r.escalated, undefined);
    assert.equal(r.approved, true);
  }

  // 9. via withTwzrdGuard: warn + escalate + bad paid score -> guard THROWS before the caller pays.
  {
    const x402 = quickX402(15);
    const merchant402 = (async () =>
      new Response(
        JSON.stringify({
          accepts: [{ network: "solana", payTo: SELLER, maxAmountRequired: "50000", resource: URL_ }],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const gated = withTwzrdGuard(merchant402, {
      fetch: preflightFetch({ decision: "warn", trust_score: 45 }),
      escalateOnWarn: {},
      x402Fetch: x402,
    });
    await assert.rejects(
      () => gated(URL_),
      /payment blocked: twzrd_escalated_warn_block/,
      "guard blocks the spend on a bad escalated paid score",
    );
    assert.equal(x402.calls.length, 1, "guard settled exactly one $0.001 quick call");
  }

  console.log("escalation.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("escalation.test.ts FAILED:", e);
  process.exit(1);
});
