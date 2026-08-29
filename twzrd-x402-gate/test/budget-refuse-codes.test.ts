/**
 * Budget refuse codes on the shipped evaluateIntent path.
 *
 * POLICY_MAX_AMOUNT / MANDATE_MONTHLY_CEILING must surface as:
 *   - reasonCodes includes twzrd_budget_exceeded (agent-facing)
 *   - budgetRemainingUsdc on the signed PaymentDecision
 * and onDecision must echo budget_remaining_usdc for refuse transcripts.
 *
 * Run: npx tsx test/budget-refuse-codes.test.ts
 */
import assert from "node:assert/strict";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import type { PaymentIntent } from "../src/intent.js";
import {
  createMemorySpendLedger,
  evaluateIntent,
} from "../src/policy-runtime.js";
import { toTrustGateBlockReason } from "../src/trust-gate-reason.js";
import {
  evaluateBeforePaymentCreation,
  type InstallX402ClientHookOptions,
} from "../src/x402-client-hook.js";

const MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function baseIntent(overrides?: Partial<PaymentIntent>): PaymentIntent {
  return {
    protocol: "x402",
    network: NETWORK,
    asset: USDC,
    amount: "5.00",
    payTo: MERCHANT,
    resource: { url: "https://store.example/item", method: "GET" },
    ...overrides,
  };
}

async function run() {
  const signer = createLocalDecisionSigner({ keyId: "budget-test" });

  /* 1. POLICY_MAX_AMOUNT → twzrd_budget_exceeded + remaining = cap */
  {
    const d = await evaluateIntent(baseIntent({ amount: "5.00" }), {
      signer,
      policy: { maxAmountUsd: "1.00" },
    });
    assert.equal(d.decision, "block");
    assert.ok(d.reasonCodes.includes("POLICY_MAX_AMOUNT"));
    assert.ok(
      d.reasonCodes.includes("twzrd_budget_exceeded"),
      `expected twzrd_budget_exceeded in ${JSON.stringify(d.reasonCodes)}`,
    );
    assert.equal(d.budgetRemainingUsdc, "1");
    assert.equal(
      toTrustGateBlockReason("twzrd_budget_exceeded"),
      "TWZRD_TRUST_GATE_BLOCK: budget_exceeded",
    );
  }

  /* 2. MANDATE_MONTHLY_CEILING → twzrd_budget_exceeded + remaining after prior spend */
  {
    const ledger = createMemorySpendLedger();
    const mandate = { mandateId: "m-budget", monthlyCeilingUsd: "10.00" };
    // Spend $9 first (allowed).
    const first = await evaluateIntent(baseIntent({ amount: "9.00" }), {
      signer,
      mandate,
      ledger,
    });
    assert.equal(first.decision, "allow");

    // $2 more would exceed $10 ceiling → remaining $1.00
    const over = await evaluateIntent(baseIntent({ amount: "2.00" }), {
      signer,
      mandate,
      ledger,
    });
    assert.equal(over.decision, "block");
    assert.ok(over.reasonCodes.includes("MANDATE_MONTHLY_CEILING"));
    assert.ok(over.reasonCodes.includes("twzrd_budget_exceeded"));
    assert.equal(over.budgetRemainingUsdc, "1");
  }

  /* 3. Exact monthly exhaust → remaining 0.00 */
  {
    const ledger = createMemorySpendLedger();
    const mandate = { mandateId: "m-zero", monthlyCeilingUsd: "5.00" };
    await evaluateIntent(baseIntent({ amount: "5.00" }), {
      signer,
      mandate,
      ledger,
    });
    const over = await evaluateIntent(baseIntent({ amount: "0.01" }), {
      signer,
      mandate,
      ledger,
    });
    assert.equal(over.decision, "block");
    assert.ok(over.reasonCodes.includes("twzrd_budget_exceeded"));
    assert.equal(over.budgetRemainingUsdc, "0");
  }

  /* 4. Shipped evaluate path (evaluateBeforePaymentCreation) surfaces snake_case on onDecision */
  {
    type CapturedDecision = {
      approved?: boolean;
      reason?: string;
      budget_remaining_usdc?: string | null;
      decision?: { reasonCodes: string[]; budgetRemainingUsdc?: string };
    };
    let detail: CapturedDecision | null = null;

    const opts: InstallX402ClientHookOptions = {
      failOpen: true,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 0,
      // Preflight allow so payment-control alone drives the refuse.
      fetch: (async () =>
        new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              trust_score: 90,
              can_spend: true,
              wash_flagged: false,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      paymentControl: {
        signer,
        policy: { maxAmountUsd: "0.01" },
      },
      onDecision(d) {
        detail = d as typeof detail;
      },
    };

    // 50000 micro = $0.05 > $0.01 cap
    const result = await evaluateBeforePaymentCreation(
      {
        payTo: MERCHANT,
        network: NETWORK,
        asset: USDC,
        maxAmountRequired: "50000",
        resource: "https://store.example/item",
        scheme: "exact",
      },
      opts,
    );

    assert.ok(result && typeof result === "object" && result.abort === true);
    // Re-widen: control-flow analysis cannot see the onDecision closure
    // assignment, so `detail` is still narrowed to null at this point.
    const seen = detail as CapturedDecision | null;
    assert.ok(seen);
    assert.equal(seen.approved, false);
    assert.ok(
      seen.decision?.reasonCodes.includes("twzrd_budget_exceeded"),
      `decision codes: ${JSON.stringify(seen.decision?.reasonCodes)}`,
    );
    assert.equal(seen.decision?.budgetRemainingUsdc, "0.01");
    assert.equal(
      seen.budget_remaining_usdc,
      "0.01",
      "refuse transcript field budget_remaining_usdc must be present on onDecision",
    );
    assert.match(String(seen.reason), /twzrd_budget_exceeded|POLICY_MAX_AMOUNT/);
  }

  /* 5. Non-budget block does not invent remaining */
  {
    const d = await evaluateIntent(baseIntent(), {
      signer,
      policy: { blocklist: [MERCHANT] },
    });
    assert.equal(d.decision, "block");
    assert.ok(d.reasonCodes.includes("POLICY_BLOCKLIST"));
    assert.ok(!d.reasonCodes.includes("twzrd_budget_exceeded"));
    assert.equal(d.budgetRemainingUsdc, undefined);
  }

  console.log("budget-refuse-codes: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
