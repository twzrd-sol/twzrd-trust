/**
 * Wash refuse default (trustless step 3) — pure policy + approvePayment routing.
 * Run: npx tsx test/wash-refuse.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import {
  applyWashFlaggedPolicy,
  fetchMerchantCard,
} from "../src/merchant-card.js";
import { twzrdApprovePayment } from "../src/policy.js";

function routedFetch(opts: {
  preflightCard: unknown;
  merchantCard?: unknown | null;
  merchantStatus?: number;
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/merchant_card/")) {
      if (opts.merchantCard === null) {
        throw new Error("merchant card down");
      }
      const status = opts.merchantStatus ?? 200;
      return new Response(
        status === 200 ? JSON.stringify(opts.merchantCard ?? {}) : JSON.stringify({ error: "nope" }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    // preflight
    return new Response(JSON.stringify({ readiness_card: opts.preflightCard }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function run() {
  // --- pure applyWashFlaggedPolicy ---
  assert.equal(
    applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_allow",
      washFlagged: true,
      refuseWashFlagged: true,
    }).reason,
    "twzrd_wash_flagged",
    "wash_flagged hard refuses",
  );
  assert.equal(
    applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_allow",
      washFlagged: true,
      refuseWashFlagged: true,
    }).approved,
    false,
  );
  assert.equal(
    applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_allow",
      washFlagged: false,
      refuseWashFlagged: true,
    }).approved,
    true,
    "clean card still allows",
  );
  assert.equal(
    applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_allow",
      washFlagged: null,
      refuseWashFlagged: true,
    }).approved,
    true,
    "missing wash signal fail-opens (no invent)",
  );
  assert.equal(
    applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_allow",
      washFlagged: true,
      refuseWashFlagged: false,
    }).approved,
    true,
    "opt-out refuseWashFlagged=false ignores wash",
  );
  const capped = applyWashFlaggedPolicy({
    approved: true,
    reason: "twzrd_allow",
    washFlagged: true,
    refuseWashFlagged: true,
    washMaxUsdc: 0.05,
    priceUsdc: 0.01,
  });
  assert.equal(capped.approved, true, "wash under cap allows");
  assert.equal(capped.washCapped, true);
  assert.match(capped.reason, /twzrd_wash_capped/);
  assert.equal(
    applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_allow",
      washFlagged: true,
      refuseWashFlagged: true,
      washMaxUsdc: 0.05,
      priceUsdc: 1.0,
    }).approved,
    false,
    "wash over cap refuses",
  );
  assert.equal(
    applyWashFlaggedPolicy({
      approved: false,
      reason: "twzrd_decision_block",
      washFlagged: false,
      refuseWashFlagged: true,
    }).approved,
    false,
    "only tightens — never loosens a prior deny",
  );

  // --- fetchMerchantCard fail-open ---
  const nullCard = await fetchMerchantCard("ABC", {
    intelBase: "https://intel.twzrd.xyz",
    fetch: (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch,
  });
  assert.equal(nullCard, null);

  // --- approvePayment integration ---
  const allowCard = { decision: "allow", trust_score: 80, can_spend: true };

  const refused = await twzrdApprovePayment(
    { payTo: "WASHWALLET", priceUsdc: 0.5 },
    resolveConfig({
      fetch: routedFetch({
        preflightCard: allowCard,
        merchantCard: { merchant: "WASHWALLET", wash_flagged: true, wash_label: "fleet_dominated" },
      }),
    }),
  );
  assert.equal(refused.approved, false, "default refuse wash_flagged");
  assert.equal(refused.reason, "twzrd_wash_flagged");
  assert.equal(refused.washFlagged, true);
  assert.equal(refused.verdict, "block");

  const clean = await twzrdApprovePayment(
    { payTo: "CLEAN", priceUsdc: 0.5 },
    resolveConfig({
      fetch: routedFetch({
        preflightCard: allowCard,
        merchantCard: { merchant: "CLEAN", wash_flagged: false },
      }),
    }),
  );
  assert.equal(clean.approved, true, "clean merchant allows");
  assert.equal(clean.washFlagged, false);

  const failOpenCard = await twzrdApprovePayment(
    { payTo: "GAP", priceUsdc: 0.5 },
    resolveConfig({
      fetch: routedFetch({
        preflightCard: allowCard,
        merchantCard: null, // throws
      }),
    }),
  );
  assert.equal(failOpenCard.approved, true, "merchant_card outage fail-opens");
  assert.equal(failOpenCard.washFlagged, null);

  const optOut = await twzrdApprovePayment(
    { payTo: "WASHWALLET", priceUsdc: 0.5 },
    resolveConfig({
      refuseWashFlagged: false,
      fetch: routedFetch({
        preflightCard: allowCard,
        merchantCard: { wash_flagged: true },
      }),
    }),
  );
  assert.equal(optOut.approved, true, "refuseWashFlagged=false opt-out");

  const softCap = await twzrdApprovePayment(
    { payTo: "WASHWALLET", priceUsdc: 0.01 },
    resolveConfig({
      washMaxUsdc: 0.05,
      fetch: routedFetch({
        preflightCard: allowCard,
        merchantCard: { wash_flagged: true },
      }),
    }),
  );
  assert.equal(softCap.approved, true, "under washMaxUsdc allows");
  assert.equal(softCap.washCapped, true);

  console.log("wash-refuse.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
