/**
 * dailyCeilingUsd: global rolling-24h cumulative ceiling across all
 * counterparties, surfaced as a budget refuse (twzrd_budget_exceeded +
 * budgetRemainingUsdc). Run: npx tsx test/daily-ceiling.test.ts
 */
import assert from "node:assert/strict";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import type { PaymentIntent } from "../src/intent.js";
import { createMemorySpendLedger, evaluateIntent } from "../src/policy-runtime.js";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HOUR = 3_600_000;
const t0 = 1_700_000_000_000;

function intent(amount: string, payTo: string): PaymentIntent {
  return {
    protocol: "x402",
    network: NETWORK,
    asset: USDC,
    amount,
    payTo,
    resource: { url: "https://store.example/item", method: "GET" },
  };
}

async function run() {
  const signer = createLocalDecisionSigner({ keyId: "daily-test" });
  const ledger = createMemorySpendLedger();
  const opts = { signer, ledger, policy: { dailyCeilingUsd: "1.00" } };

  /* 1. Spend accumulates ACROSS counterparties: 0.60 + 0.30 allowed. */
  assert.equal((await evaluateIntent(intent("0.60", "MerchantA"), { ...opts, now: t0 })).decision, "allow");
  assert.equal((await evaluateIntent(intent("0.30", "MerchantB"), { ...opts, now: t0 + HOUR })).decision, "allow");

  /* 2. Third payment busts the global ceiling — budget refuse with remaining. */
  const d = await evaluateIntent(intent("0.20", "MerchantC"), { ...opts, now: t0 + 2 * HOUR });
  assert.equal(d.decision, "block");
  assert.ok(d.reasonCodes.includes("POLICY_DAILY_CEILING"), JSON.stringify(d.reasonCodes));
  assert.ok(d.reasonCodes.includes("twzrd_budget_exceeded"), JSON.stringify(d.reasonCodes));
  assert.equal(d.budgetRemainingUsdc, "0.1");

  /* 3. Blocked spend was not recorded: an in-budget retry still fits. */
  assert.equal((await evaluateIntent(intent("0.10", "MerchantC"), { ...opts, now: t0 + 2 * HOUR })).decision, "allow");

  /* 4. The window rolls: 25h after t0 the first 0.60 has aged out. */
  const later = await evaluateIntent(intent("0.55", "MerchantD"), { ...opts, now: t0 + 25 * HOUR });
  assert.equal(later.decision, "allow", JSON.stringify(later.reasonCodes));

  /* 5. No ledger → ceiling cannot evaluate; per-tx cap still enforces. */
  const noLedger = await evaluateIntent(intent("9.00", "MerchantE"), {
    signer,
    policy: { dailyCeilingUsd: "1.00", maxAmountUsd: "0.01" },
  });
  assert.equal(noLedger.decision, "block");
  assert.ok(noLedger.reasonCodes.includes("POLICY_MAX_AMOUNT"));

  /* 6. Composition: the shipped fuse (createTwzrdPolicyFetch) accumulates the
     global scope on paid 200s, so the ceiling actually binds in deployment. */
  {
    const { createTwzrdPolicyFetch, TwzrdPolicyAbortError } = await import("../src/policy-fetch.js");
    const asFetch = (fn: (...a: never[]) => Promise<Response>) => fn as unknown as typeof fetch;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
      const r = await g(input, init);
      return r.status === 402 ? new Response("paid", { status: 200 }) : r;
    };
    const pf = createTwzrdPolicyFetch({
      signer,
      fetch: asFetch(async () => json({ wash_flagged: false, wash_confidence: "full" })),
      rawFetch: asFetch(async () =>
        json({ accepts: [{ payTo: "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs", amount: "10000", network: "solana", asset: "USDC" }] }, 402)),
      wrapPay,
      ledger: createMemorySpendLedger(),
      policy: { dailyCeilingUsd: "0.025" },
    });
    assert.equal((await pf("https://origin.example/paid")).status, 200);
    assert.equal((await pf("https://origin.example/paid")).status, 200);
    await assert.rejects(
      () => pf("https://origin.example/paid"),
      (e: unknown) =>
        e instanceof TwzrdPolicyAbortError && e.decision.reasonCodes.includes("POLICY_DAILY_CEILING"),
    );
  }

  console.log("daily-ceiling.test.ts: ALL PASSED");
}

await run();
