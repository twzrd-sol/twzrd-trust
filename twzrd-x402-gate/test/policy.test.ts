/**
 * Pure-policy + approvePayment contract test (no real network — injected fetch).
 * Run: npx tsx test/policy.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import {
  buildPreflightInput,
  evaluateReadinessCard,
  twzrdApprovePayment,
} from "../src/policy.js";

const bd = (s = "block") =>
  new Set(s.split(",").map((x) => x.trim()).filter(Boolean));

const okFetch = (card: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const throwFetch: typeof fetch = (async () => {
  throw new Error("net down");
}) as unknown as typeof fetch;

async function run() {
  // --- evaluateReadinessCard (pure) ---
  assert.equal(
    evaluateReadinessCard({ card: { decision: "block", trust_score: 90 }, preflightMinScore: 40, blockDecisions: bd() }).approved,
    false,
    "block decision denies even at high score",
  );
  assert.equal(
    evaluateReadinessCard({ card: { decision: "allow", can_spend: false, trust_score: 90 }, preflightMinScore: 40, blockDecisions: bd() }).reason,
    "twzrd_can_spend_false",
    "can_spend=false denies",
  );
  assert.match(
    evaluateReadinessCard({ card: { decision: "allow", trust_score: 20 }, preflightMinScore: 40, blockDecisions: bd() }).reason,
    /below_40/,
    "score below min denies",
  );
  assert.equal(
    evaluateReadinessCard({ card: { decision: "allow", trust_score: 80 }, preflightMinScore: 40, blockDecisions: bd() }).reason,
    "twzrd_allow",
    "high allow approves",
  );
  assert.equal(
    evaluateReadinessCard({ card: { decision: "warn", trust_score: 50 }, preflightMinScore: 40, blockDecisions: bd() }).reason,
    "twzrd_warn_allowed",
    "warn above min is allowed",
  );
  assert.equal(
    evaluateReadinessCard({ card: {}, preflightMinScore: 40, blockDecisions: bd() }).approved,
    false,
    "empty card (score defaults 0) denies below min",
  );

  // --- gateOnCanSpend flag: the ClawRouter "gate only on decision" policy ---
  assert.equal(
    evaluateReadinessCard({ card: { decision: "warn", can_spend: false, trust_score: 45 }, preflightMinScore: 40, blockDecisions: bd(), gateOnCanSpend: false }).approved,
    true,
    "gateOnCanSpend=false: a warn/can_spend=false seller above min is allowed (ClawRouter policy)",
  );
  assert.equal(
    evaluateReadinessCard({ card: { decision: "block", can_spend: false, trust_score: 99 }, preflightMinScore: 40, blockDecisions: bd(), gateOnCanSpend: false }).approved,
    false,
    "gateOnCanSpend=false still denies an explicit block decision",
  );
  // via resolved config + approvePayment over the same free-tier shape we see live
  assert.equal(
    (await twzrdApprovePayment({ payTo: "S" }, resolveConfig({ gateOnCanSpend: false, fetch: okFetch({ decision: "warn", trust_score: 45, can_spend: false }) }))).approved,
    true,
    "approvePayment with gateOnCanSpend=false clears the live warn/can_spend=false free-tier card",
  );

  // --- buildPreflightInput maps payTo -> seller_wallet ---
  const inp = buildPreflightInput({ payTo: "SELLER", resourceUrl: "https://x/y" });
  assert.equal(inp.seller_wallet, "SELLER");
  assert.equal(inp.resource_name, "https://x/y");
  assert.equal(inp.agent_intent, "x402_payment_gate");

  // --- twzrdApprovePayment: allow via injected preflight ---
  assert.equal(
    (await twzrdApprovePayment({ payTo: "S" }, resolveConfig({ fetch: okFetch({ decision: "allow", trust_score: 88, can_spend: true }) }))).approved,
    true,
  );
  // --- block via injected preflight ---
  assert.equal(
    (await twzrdApprovePayment({ payTo: "S" }, resolveConfig({ fetch: okFetch({ decision: "block", trust_score: 5 }) }))).approved,
    false,
  );
  // --- fail-open (default) when preflight throws ---
  const fo = await twzrdApprovePayment({ payTo: "S" }, resolveConfig({ failOpen: true, fetch: throwFetch }));
  assert.equal(fo.approved, true);
  assert.equal(fo.failOpen, true);
  assert.equal(fo.reason, "twzrd_fail_open");
  // --- fail-closed re-throws ---
  await assert.rejects(
    () => twzrdApprovePayment({ payTo: "S" }, resolveConfig({ failOpen: false, fetch: throwFetch })),
    "failOpen=false must propagate the preflight error",
  );

  console.log("policy.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("policy.test.ts FAILED:", e);
  process.exit(1);
});
