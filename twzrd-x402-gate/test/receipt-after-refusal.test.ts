/**
 * The paid trust receipt is bought for a seller the gate is going to pay, and
 * for no other.
 *
 * evaluate_x402_resource decided whether to buy the $0.05 receipt from the
 * card's decision string. Several refusals leave that string at "allow" or
 * "warn": a wash-flagged seller, a seller intel has never evaluated, a score
 * under the host's floor. For those the gate refused the payment and bought the
 * receipt anyway, so a seller could cost a buyer $0.05 per evaluation without
 * ever being paid.
 *
 * Run: npx tsx --test test/receipt-after-refusal.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate_x402_resource, type EvaluateX402Options } from "../src/evaluate.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { withTwzrdGuard } from "../src/with-guard.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const RESOURCE = "https://seller.example/paid";
/** $3.00. */
const REQS = {
  payTo: SELLER,
  maxAmountRequired: "3000000",
  resource: RESOURCE,
  network: "solana",
} as X402PaymentRequirements;

/** Intel stub: preflight answers `card`; merchant_card answers `merchant`. */
function intel(card: Record<string, unknown>, merchant: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const body = /\/merchant_card\//.test(String(url)) ? merchant : { readiness_card: card };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** Paying fetch: records every paid hop and answers with a settled receipt. */
function paying() {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ tx: "TX_PAID", charged: true, twzrd_receipt: { score: 80 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const CLEAN = { wash_flagged: false, confidence: "full" };
const GOOD_CARD = { decision: "allow", trust_score: 90, can_spend: true };

type Case = {
  name: string;
  card: Record<string, unknown>;
  merchant: Record<string, unknown>;
  reason: RegExp;
  options?: Partial<EvaluateX402Options>;
};

const REFUSED: Case[] = [
  {
    name: "a wash-flagged seller whose card still says allow",
    card: GOOD_CARD,
    merchant: { wash_flagged: true, confidence: "full" },
    reason: /twzrd_wash_flagged/,
  },
  {
    name: "a seller intel has never evaluated, whose card says warn",
    card: { decision: "warn", trust_score: 45, score: null, null_reason: "unknown_subject", can_spend: true, recommended_cap_usdc: 5 },
    merchant: CLEAN,
    reason: /twzrd_unevaluated_subject_unknown_subject/,
  },
  {
    name: "a score under the host's floor, on a card that says allow",
    card: { decision: "allow", trust_score: 55, can_spend: true },
    merchant: CLEAN,
    reason: /55/,
    options: { preflightMinScore: 70 },
  },
];

for (const c of REFUSED) {
  for (const receipt of [
    { label: "autoReceipt", options: { autoReceipt: true } },
    { label: "requireReceipt", options: { requireReceipt: { minSpendUsdc: 1 } } },
  ]) {
    test(`${c.name} is refused with no paid receipt (${receipt.label})`, async () => {
      const x402Fetch = paying();
      const result = await evaluate_x402_resource(RESOURCE, REQS, {
        fetch: intel(c.card, c.merchant),
        x402Fetch,
        ...c.options,
        ...receipt.options,
      });
      assert.equal(result.approved, false);
      assert.match(String(result.reason), c.reason, "the refusal keeps its own reason");
      assert.deepEqual(x402Fetch.calls, [], "nothing is bought for a refused seller");
      assert.equal(result.receipt, undefined);
      assert.equal(result.receiptFeeCaptured, undefined);
    });
  }
}

test("the guard refuses a wash-flagged seller without paying intel or the seller", async () => {
  const x402Fetch = paying();
  let sellerRequests = 0;
  const merchant = (async () => {
    sellerRequests += 1;
    const body = { x402Version: 1, accepts: [{ ...REQS, scheme: "exact", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }] };
    return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const guarded = withTwzrdGuard(merchant, {
    fetch: intel(GOOD_CARD, { wash_flagged: true, confidence: "full" }),
    x402Fetch,
    autoReceipt: true,
  });
  await assert.rejects(() => guarded(RESOURCE), /twzrd_wash_flagged/);
  assert.deepEqual(x402Fetch.calls, []);
  assert.equal(sellerRequests, 1, "only the unpaid probe reached the seller");
});

test("an approved seller still gets its receipt", async () => {
  const x402Fetch = paying();
  const result = await evaluate_x402_resource(RESOURCE, REQS, {
    fetch: intel(GOOD_CARD, CLEAN),
    x402Fetch,
    autoReceipt: true,
  });
  assert.equal(result.approved, true);
  assert.equal(x402Fetch.calls.length, 1);
  assert.match(x402Fetch.calls[0], /\/v1\/intel\/trust\//);
  assert.equal(result.receiptTx, "TX_PAID");
  assert.equal(result.receiptFeeCaptured, true);
});
