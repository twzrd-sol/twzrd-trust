/**
 * RED TEAM — attack class 4 (retries) + 5 (concurrency / TOCTOU) against the
 * cumulative spend cap in spendControlSafeFetch.
 *
 * Claim under attack: "an ALLOWED payment can only be signed exactly as
 * approved" — which requires the cap that authorised it to be sound.
 *
 * `DEFECT:` assertions encode the CURRENT (vulnerable) behavior so the suite
 * stays green and the defect cannot rot. Read them as findings, not as passes.
 *
 * Run: npx tsx test/red-spend-race.test.ts
 */
import assert from "node:assert/strict";
import { createMemorySpendLedger } from "../src/policy-runtime.js";
import { twzrd } from "../src/spend-control.js";

const SOL = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RES = "https://merchant.example/paid";
const YEAR = 400 * 24 * 3600 * 1000;

const f402 = (amount: string): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "solana", payTo: SOL, amount, asset: USDC, resource: RES }],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

async function run() {
  /* ---------- 4a. the cap DOES hold for strictly sequential, well-formed spend ---------- */
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const pay = async () => { signs += 1; return { response: new Response("ok") }; };
    const base = { maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", pay } as const;

    const first = await twzrd.safeFetch(RES, { ...base, fetch: f402("1000000") });
    assert.equal(first.verdict, "allow");
    assert.equal(first.signerInvocations, 1);
    const second = await twzrd.safeFetch(RES, { ...base, fetch: f402("1000000") });
    assert.equal(second.verdict, "block", "sequential second 1.00 USDC must exceed a 1.00 cap");
    assert.equal(second.reason, "over_cumulative_spend");
    assert.equal(second.signerInvocations, 0);
    assert.equal(signs, 1, "exactly one signature for a 1.00 cap");
  }

  /* ---------- 5. DEFECT #9 (CRITICAL): TOCTOU — N parallel payments, one cap ---------- */
  // spend-control.ts reads the ledger (`ledger.spentMicro(...)`, line 145) and
  // writes it (`ledger.record(...)`, lines 200-202) with an `await opts.pay(...)`
  // in between. Nothing holds a lock across that await, so every concurrent
  // call observes a pre-spend ledger and all of them clear the same cap.
  // SHOULD BE: exactly one allow; the rest over_cumulative_spend.
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const pay = async () => {
      signs += 1;
      await new Promise((r) => setTimeout(r, 5)); // realistic settle latency
      return { response: new Response("ok") };
    };
    const opts = { maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", pay, fetch: f402("1000000") };
    const results = await Promise.all(Array.from({ length: 5 }, () => twzrd.safeFetch(RES, opts)));

    assert.deepEqual(
      results.map((r) => r.verdict),
      ["allow", "allow", "allow", "allow", "allow"],
      "DEFECT: all 5 concurrent payments cleared a cap that permits exactly 1",
    );
    assert.equal(signs, 5, "DEFECT: signer invoked 5x under a 1-payment cap");
    assert.equal(
      ledger.spentMicro("agent:a1", YEAR, Date.now()),
      5_000_000n,
      "DEFECT: 5.00 USDC settled against a 1.00 USDC maxSpend (5x overspend)",
    );
    // The race is not latency-dependent: it reproduces with a zero-await payer,
    // because the ledger read/write straddle an await no matter how short.
    const l2 = createMemorySpendLedger();
    const instant = await Promise.all(
      Array.from({ length: 3 }, () =>
        twzrd.safeFetch(RES, {
          maxSpend: "1.00", ledger: l2, agentId: "a2", mandateId: "m2",
          fetch: f402("1000000"), pay: async () => ({ response: new Response("ok") }),
        }),
      ),
    );
    assert.deepEqual(instant.map((r) => r.verdict), ["allow", "allow", "allow"],
      "DEFECT: race needs no artificial delay");
  }

  /* ---------- 4b. DEFECT #10 (CRITICAL): negative-amount ledger CREDIT chaining ---------- */
  // A 402 the merchant fully controls can advertise a negative base amount.
  // It is allowed (see red-malformed-402 DEFECT #1) and then `ledger.record()`
  // stores a NEGATIVE entry, which `spentMicro()` sums — permanently raising
  // the effective cap for the agent, the merchant AND the mandate key at once.
  // SHOULD BE: the negative 402 blocks and nothing is recorded.
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const pay = async () => { signs += 1; return { response: new Response("ok") }; };
    const base = { maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", pay } as const;

    const credit = await twzrd.safeFetch(RES, { ...base, fetch: f402("-9000000") });
    assert.equal(credit.verdict, "allow", "DEFECT: the -9 USDC 402 is allowed");
    assert.equal(
      ledger.spentMicro("agent:a1", YEAR, Date.now()),
      -9_000_000n,
      "DEFECT: ledger now holds a -9.00 USDC credit",
    );

    // The cap is now effectively 10.00 USDC. Drain it.
    const drained: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      drained.push((await twzrd.safeFetch(RES, { ...base, fetch: f402("1000000") })).verdict);
    }
    assert.deepEqual(drained, ["allow", "allow", "allow", "allow"],
      "DEFECT: 4 further 1.00 USDC payments cleared a 1.00 USDC cumulative cap");
    assert.equal(signs, 5, "DEFECT: 5 signatures under a cap that permits 1");
    assert.equal(ledger.spentMicro(`merchant:${SOL}`, YEAR, Date.now()), -5_000_000n,
      "DEFECT: the merchant-scoped cap is credited too, so the merchant funds its own headroom");
  }

  /* ---------- 4c. DEFECT #11 (high): a thrown settle un-books a spend that may have landed ---------- */
  // `ledger.record()` runs only after `await opts.pay()` RESOLVES. A settle that
  // broadcast on-chain and then failed to return (timeout, dropped socket,
  // response parse error) leaves the ledger at zero while the funds are gone —
  // the retry then gets the full cap again. This is the "double-spend by not
  // counting" half of the retry class.
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const pay = async () => {
      signs += 1; // the signature HAS happened by this point
      if (signs === 1) throw new Error("settle broadcast, response lost");
      return { response: new Response("ok") };
    };
    const base = { maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", pay } as const;

    await assert.rejects(() => twzrd.safeFetch(RES, { ...base, fetch: f402("600000") }),
      /settle broadcast/, "the settle error propagates uncaught out of safeFetch");
    assert.equal(signs, 1, "the signer WAS invoked");
    assert.equal(ledger.spentMicro("agent:a1", YEAR, Date.now()), 0n,
      "DEFECT: 0.60 USDC signed but 0 recorded against the cap");

    const retry = await twzrd.safeFetch(RES, { ...base, fetch: f402("600000") });
    assert.equal(retry.verdict, "allow",
      "DEFECT: the retry gets the full cap back — 1.20 USDC signed under a 1.00 cap");
    assert.equal(signs, 2);
    assert.equal(ledger.spentMicro("agent:a1", YEAR, Date.now()), 600_000n,
      "DEFECT: the ledger under-reports actual signed spend by exactly one settle");
  }

  /* ---------- 4d. DEFECT #12 (medium): budget is consumed with no payer wired ---------- */
  // `if (signerInvocations > 0 || !opts.pay)` books the spend even when no `pay`
  // callback exists, so a decision-only probe burns real budget headroom.
  // SHOULD BE: nothing recorded when nothing was paid.
  {
    const ledger = createMemorySpendLedger();
    const r = await twzrd.safeFetch(RES, {
      maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", fetch: f402("1000000"),
    });
    assert.equal(r.verdict, "allow");
    assert.equal(r.signerInvocations, 0, "no payer wired, so nothing was signed");
    assert.equal(ledger.spentMicro("agent:a1", YEAR, Date.now()), 1_000_000n,
      "DEFECT: 1.00 USDC of budget consumed by a probe that paid nothing");
  }

  /* ---------- 4e. a blocked payment never books spend (correct, locked in) ---------- */
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const blocked = await twzrd.safeFetch(RES, {
      maxSpend: "0.10", ledger, agentId: "a1", mandateId: "m1", fetch: f402("1000000"),
      pay: async () => { signs += 1; return {}; },
      preflight: async () => ({ decision: "block" }),
    });
    assert.equal(blocked.verdict, "block");
    assert.equal(signs, 0, "refuse path invokes the signer ZERO times");
    assert.equal(ledger.spentMicro("agent:a1", YEAR, Date.now()), 0n, "refuse books no spend");
  }

  console.log("red-spend-race.test.ts: ALL PASSED (4 DEFECTS encoded — see DEFECT: comments)");
}

run().catch((e) => {
  console.error("red-spend-race.test.ts FAILED:", e);
  process.exit(1);
});
