/**
 * requireReceipt threshold policy — pure + evaluate_x402_resource integration.
 * Run: npx tsx test/receipt-policy.test.ts
 */
import assert from "node:assert/strict";

import {
  DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC,
  resolveRequireReceiptPolicy,
  shouldAttemptPathAReceipt,
  shouldRequirePathAReceipt,
} from "../src/receipt-policy.js";
import { evaluate_x402_resource } from "../src/evaluate.js";

const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

function preflightFetch(decision: "allow" | "warn" | "block", score = 55): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/merchant_card/")) {
      return new Response(
        JSON.stringify({ wash_flagged: false, in_corpus: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        preflight_id: 42,
        readiness_card: {
          decision,
          trust_score: score,
          can_spend: decision !== "block",
          paid_trust_endpoint: `/v1/intel/trust/${SELLER}`,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function reqs(amountMicro: string) {
  return {
    scheme: "exact",
    network: "solana:mainnet",
    maxAmountRequired: amountMicro,
    amount: amountMicro,
    payTo: SELLER,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    resource: "https://merchant.example/paid",
  };
}

async function main() {
  // Pure policy
  assert.equal(resolveRequireReceiptPolicy(undefined), null);
  assert.equal(resolveRequireReceiptPolicy(false), null);
  const d = resolveRequireReceiptPolicy(true)!;
  assert.equal(d.minSpendUsdc, DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC);
  assert.equal(d.onWarn, true);
  assert.equal(d.hard, true);

  assert.equal(
    shouldRequirePathAReceipt({
      policy: d,
      decision: "allow",
      priceUsdc: 5,
    }),
    false,
    "low-value allow → free only",
  );
  assert.equal(
    shouldRequirePathAReceipt({
      policy: d,
      decision: "allow",
      priceUsdc: 10.01,
    }),
    true,
    "high-value allow → require Path A",
  );
  assert.equal(
    shouldRequirePathAReceipt({
      policy: d,
      decision: "warn",
      priceUsdc: 0.01,
    }),
    true,
    "warn → require Path A even at low value",
  );
  assert.equal(
    shouldRequirePathAReceipt({
      policy: d,
      decision: "block",
      priceUsdc: 100,
    }),
    false,
    "block never requires paid proof",
  );

  assert.equal(
    shouldAttemptPathAReceipt({
      autoReceipt: false,
      requireReceipt: true,
      decision: "allow",
      priceUsdc: 1,
    }),
    false,
  );
  assert.equal(
    shouldAttemptPathAReceipt({
      autoReceipt: true,
      decision: "allow",
      priceUsdc: 1,
    }),
    true,
  );

  // Integration: high-value allow without x402Fetch → hard deny
  {
    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("15000000"), // $15
      {
        fetch: preflightFetch("allow", 70),
        requireReceipt: true,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(r.receiptRequired, true);
    assert.equal(r.receiptRequiredDenied, true);
    assert.equal(r.approved, false);
    assert.match(r.reason, /missing_x402Fetch|receipt_required/);
  }

  // High-value allow with successful Path A
  {
    let paidCalls = 0;
    const x402Fetch = (async () => {
      paidCalls += 1;
      return new Response(
        JSON.stringify({
          paid: true,
          tx: "fakeSig111",
          twzrd_receipt: {
            version: 6,
            preimage: { settlement_tx: "fakeSig111" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("15000000"),
      {
        fetch: preflightFetch("allow", 70),
        requireReceipt: { minSpendUsdc: 10, onWarn: true, hard: true },
        x402Fetch,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(paidCalls, 1);
    assert.equal(r.approved, true);
    assert.equal(r.receiptRequired, true);
    assert.equal(r.receiptFeeCaptured, true);
    assert.ok(r.receipt);
  }

  // Low-value allow: no Path A
  {
    let paidCalls = 0;
    const x402Fetch = (async () => {
      paidCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("1000000"), // $1
      {
        fetch: preflightFetch("allow", 70),
        requireReceipt: true,
        x402Fetch,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(paidCalls, 0);
    assert.equal(r.approved, true);
    assert.equal(r.receiptRequired, undefined);
  }

  // Warn low-value: Path A required
  {
    let paidCalls = 0;
    const x402Fetch = (async () => {
      paidCalls += 1;
      return new Response(
        JSON.stringify({
          paid: true,
          charged: true,
          twzrd_receipt: { version: 6 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("50000"), // $0.05
      {
        fetch: preflightFetch("warn", 45),
        requireReceipt: true,
        x402Fetch,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(paidCalls, 1);
    assert.equal(r.receiptRequired, true);
    assert.equal(r.approved, true);
  }

  // Hard require + failed Path A → deny
  {
    const x402Fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 402,
      })) as unknown as typeof fetch;
    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("20000000"),
      {
        fetch: preflightFetch("allow", 70),
        requireReceipt: { minSpendUsdc: 10, hard: true },
        x402Fetch,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(r.approved, false);
    assert.equal(r.receiptRequiredDenied, true);
  }

  // Soft require: fail-open on Path A error
  {
    const x402Fetch = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("20000000"),
      {
        fetch: preflightFetch("allow", 70),
        requireReceipt: { minSpendUsdc: 10, hard: false },
        x402Fetch,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(r.approved, true);
    assert.equal(r.receiptRequiredDenied, undefined);
  }

  // block never buys Path A even with autoReceipt
  {
    let paidCalls = 0;
    const x402Fetch = (async () => {
      paidCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await evaluate_x402_resource(
      "https://merchant.example/paid",
      reqs("999000000"),
      {
        fetch: preflightFetch("block", 10),
        requireReceipt: true,
        autoReceipt: true,
        x402Fetch,
        refuseWashFlagged: false,
        preflightMinScore: 0,
        blockDecisions: ["block"],
      },
    );
    assert.equal(paidCalls, 0);
    assert.equal(r.approved, false);
  }

  console.log("receipt-policy.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
