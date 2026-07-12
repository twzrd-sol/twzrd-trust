/**
 * Adversarial TOCTOU: probe challenge A ≠ payer challenge B.
 * Proves twzrd-safe-fetch does NOT bind the signed requirement to the scored one.
 *
 * Secure expected: payer must not sign B after A was approved.
 * Actual (advisory path): payer is invoked after A approved and receives B.
 *
 * Run: npx tsx test/challenge-swap.test.ts
 */
import assert from "node:assert/strict";

import { safeFetch } from "../src/safe-fetch.js";

const SAFE_A = "SAFE_SELLER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const UNSAFE_B = "UNAPPROVED_SELLER_BBBBBBBBBBBBBBBBBBBBBBB";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function challenge(payTo: string, amount: string) {
  return {
    accepts: [
      {
        network: SOL,
        payTo,
        amount,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
    ],
  };
}

async function run() {
  let targetHits = 0;
  let payerInvoked = 0;
  let payerSawPayTo: string | undefined;
  let payerSawAmount: string | undefined;
  let signerWouldSign = false;

  // Target: first request returns SAFE A; subsequent would return UNSAFE B
  // (simulates AgentCash's independent re-fetch).
  const targetFetch: typeof fetch = (async (input) => {
    const u = String(input);
    if (u.includes("/preflight") || u.includes("intel.twzrd")) {
      // not used for target
      return new Response("{}", { status: 404 });
    }
    targetHits += 1;
    const payTo = targetHits === 1 ? SAFE_A : UNSAFE_B;
    const amount = targetHits === 1 ? "1000" : "500000";
    return new Response(JSON.stringify(challenge(payTo, amount)), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  // Combined fetch: preflight always allows SAFE_A; target uses targetFetch
  const fetchImpl: typeof fetch = (async (input, init) => {
    const u = String(input);
    if (u.includes("/preflight")) {
      return new Response(
        JSON.stringify({
          readiness_card: {
            decision: "allow",
            trust_score: 95,
            can_spend: true,
            seller_wallet: SAFE_A,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/merchant_card")) {
      return new Response(JSON.stringify({ wash_flagged: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return targetFetch(input, init);
  }) as typeof fetch;

  const r = await safeFetch({
    url: "https://merchant.example/paid",
    refuseWashFlagged: false,
    gateOnCanSpend: false,
    preflightMinScore: 40,
    fetch: fetchImpl,
    runPayer: async () => {
      // Simulate AgentCash: independent second request to target
      payerInvoked += 1;
      const second = await targetFetch("https://merchant.example/paid");
      assert.equal(second.status, 402);
      const body = (await second.json()) as {
        accepts: Array<{ payTo: string; amount: string }>;
      };
      payerSawPayTo = body.accepts[0]?.payTo;
      payerSawAmount = body.accepts[0]?.amount;
      // Insecure: advisory path already approved; AgentCash would sign B
      signerWouldSign = true;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ paid: true, simulated: true, payTo: payerSawPayTo }),
        stderr: "",
      };
    },
  });

  // --- Document the insecure outcome ---
  assert.equal(r.ok, true, "advisory path reports ok after AgentCash success");
  assert.equal(r.phase, "paid");
  assert.equal(r.requirementScored?.payTo, SAFE_A);
  assert.equal(r.requirementScored?.amountMicro, "1000");
  assert.equal(r.requirementScoredMatchesRequirementSigned, false);
  assert.equal(r.cliSecurityClassification, "advisory_precheck");
  assert.equal(r.targetRequestCount, 2);
  assert.equal(payerInvoked, 1);
  assert.equal(payerSawPayTo, UNSAFE_B);
  assert.equal(payerSawAmount, "500000");
  assert.equal(signerWouldSign, true);

  // Secure expectation FAILS: B was signed after A was approved
  const secureWouldBlock =
    r.requirementScored?.payTo === payerSawPayTo &&
    r.requirementScored?.amountMicro === payerSawAmount;
  assert.equal(
    secureWouldBlock,
    false,
    "challenge swap must be detectable as scored≠signed",
  );

  console.log(
    JSON.stringify(
      {
        challenge_swap_test: "DOCUMENTED_INSECURE",
        requirement_scored: r.requirementScored,
        requirement_payer_received: {
          payTo: payerSawPayTo,
          amountMicro: payerSawAmount,
        },
        requirement_scored_matches_requirement_signed:
          r.requirementScoredMatchesRequirementSigned,
        payer_invoked: payerInvoked,
        signer_would_sign: signerWouldSign,
        target_request_count: r.targetRequestCount,
        classification: r.cliSecurityClassification,
      },
      null,
      2,
    ),
  );
  console.log("challenge-swap.test.ts: ALL PASSED (insecure advisory path confirmed)");
}

run().catch((e) => {
  console.error("challenge-swap.test.ts FAILED:", e);
  process.exit(1);
});
