/**
 * AUDIT: spend-ledger TOCTOU + amount hygiene + offer narrowing.
 *
 * twzrd.safeFetch checks `spentMicro + amount <= maxSpend`, then awaits
 * preflight / prepare / pay, and only THEN records. Two concurrent calls both
 * read the same headroom, both invoke the signer, and the cumulative budget
 * is exceeded. evaluateIntent has the same gap around `await intelligence`.
 * Offline, deterministic. Run: npx tsx test/audit-spend-ledger.test.ts
 */
import assert from "node:assert/strict";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import { createMemorySpendLedger, evaluateIntent } from "../src/policy-runtime.js";
import { twzrd } from "../src/spend-control.js";
import type { PaymentIntent } from "../src/intent.js";

const SOL = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const URL_ = "https://merchant.example/paid";
const tick = () => new Promise((r) => setTimeout(r, 5));

const fetch402 = (accepts: Array<Record<string, unknown>>): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ x402Version: 1, accepts }), {
      status: 402, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
const solana = (over: Record<string, unknown> = {}) => ({
  scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC, resource: URL_, ...over,
});

async function run() {
  // 1. Concurrent safeFetch: cap $0.015, two $0.01 calls in flight together.
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const pay = async () => { await tick(); signs += 1; return { response: new Response("ok") }; };
    const opts = { fetch: fetch402([solana()]), maxSpend: "0.015", ledger, pay, agentId: "a", mandateId: "m" };
    const [a, b] = await Promise.all([twzrd.safeFetch(URL_, opts), twzrd.safeFetch(URL_, opts)]);
    const verdicts = [a.verdict, b.verdict].sort();
    assert.deepEqual(verdicts, ["allow", "block"], `both passed the cap: ${JSON.stringify([a, b])}`);
    assert.equal(signs, 1, "signer invoked twice under a $0.015 cumulative cap");
    assert.equal(ledger.spentMicro("agent:a", 1e12, Date.now()), 10000n);
  }

  // 2. Concurrent evaluateIntent: monthly ceiling $1.00, two $0.60 intents, async intel.
  {
    const ledger = createMemorySpendLedger();
    const signer = createLocalDecisionSigner();
    const intent: PaymentIntent = { protocol: "x402", network: "solana", asset: USDC, amount: "0.60", payTo: SOL };
    const opts = {
      signer, ledger, mandate: { mandateId: "m1", monthlyCeilingUsd: "1.00" },
      policy: { newCounterpartyCap: { capUsd: "1.00", windowHours: 24 } },
      intelligence: async () => { await tick(); return { decision: "allow" as const }; },
    };
    const [a, b] = await Promise.all([evaluateIntent(intent, opts), evaluateIntent(intent, opts)]);
    const verdicts = [a.decision, b.decision].sort();
    assert.deepEqual(verdicts, ["allow", "block"], `ceiling breached: ${a.decision}/${b.decision}`);
    const blocked = a.decision === "block" ? a : b;
    assert.ok(blocked.reasonCodes.includes("MANDATE_MONTHLY_CEILING"));
    assert.ok(blocked.reasonCodes.includes("NEW_COUNTERPARTY_CAP"));
    assert.equal(ledger.spentMicro("mandate:m1", 1e12, Date.now()), 600000n);
  }

  // 3. A seller-controlled amount that is not a base-unit integer must not reach pay().
  {
    for (const amount of ["-100", "0.5", "1e6", " 10000"]) {
      let signs = 0;
      const r = await twzrd.safeFetch(URL_, {
        fetch: fetch402([solana({ amount })]), maxSpend: "0.01",
        pay: async () => { signs += 1; return { response: new Response("ok") }; },
      });
      assert.equal(r.verdict, "block", `amount ${JSON.stringify(amount)} reached the signer`);
      assert.equal(r.reason, "malformed_amount");
      assert.equal(signs, 0);
    }
  }

  // 4. pay() must only see the offer the gate approved, not the whole accepts[].
  {
    const base = { scheme: "exact", network: "eip155:8453", payTo: "0x3803A1f7E5cC4E7b2b0E5F1A2b3C4d5E6f708192", amount: "1000000", asset: "0xusdc" };
    let seen: unknown;
    const r = await twzrd.safeFetch(URL_, {
      fetch: fetch402([base, solana({ amount: "1000" })]), maxSpend: "0.01",
      pay: async ({ paymentRequired, selected }) => {
        seen = { accepts: (paymentRequired as { accepts: unknown[] }).accepts, selected };
        return { response: new Response("ok") };
      },
    });
    assert.equal(r.verdict, "allow");
    const s = seen as { accepts: Record<string, unknown>[]; selected: Record<string, unknown> };
    assert.equal(s.selected.payTo, SOL);
    assert.deepEqual(s.accepts, [s.selected], "payer was handed an unvetted $1 Base offer alongside the $0.001 approved one");
  }

  console.log("audit-spend-ledger.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("audit-spend-ledger.test.ts FAILED:", e);
  process.exit(1);
});
