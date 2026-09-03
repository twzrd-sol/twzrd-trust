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

  /* ---------- 5. FIXED #9 (was CRITICAL): TOCTOU — N parallel payments, one cap ---------- */
  // WAS: spend-control.ts read the ledger and wrote it with `await opts.pay(...)`
  // in between, holding nothing across the await, so every concurrent call
  // observed a pre-spend ledger and all of them cleared the same cap.
  // NOW: an in-flight reservation is taken in the SAME TICK as the cap check and
  // released in `finally`. These assertions are the SHOULD BE from the original
  // red-team block, flipped: exactly one allow, the rest over_cumulative_spend.
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

    const verdicts = results.map((r) => r.verdict).sort();
    assert.deepEqual(
      verdicts,
      ["allow", "block", "block", "block", "block"],
      "exactly one of 5 concurrent payments may clear a 1-payment cap",
    );
    assert.deepEqual(
      results.filter((r) => r.verdict === "block").map((r) => r.reason),
      Array(4).fill("over_cumulative_spend"),
      "the four losers must be refused for the cap, not some incidental reason",
    );
    assert.equal(signs, 1, "the signer runs exactly once — the other four never sign");
    assert.equal(
      ledger.spentMicro("agent:a1", YEAR, Date.now()),
      1_000_000n,
      "exactly 1.00 USDC settled against a 1.00 USDC maxSpend",
    );
    // The old race was not latency-dependent, so neither is the fix: a
    // zero-await payer must be held to the same cap.
    const l2 = createMemorySpendLedger();
    const instant = await Promise.all(
      Array.from({ length: 3 }, () =>
        twzrd.safeFetch(RES, {
          maxSpend: "1.00", ledger: l2, agentId: "a2", mandateId: "m2",
          fetch: f402("1000000"), pay: async () => ({ response: new Response("ok") }),
        }),
      ),
    );
    assert.deepEqual(instant.map((r) => r.verdict).sort(), ["allow", "block", "block"],
      "a zero-await payer is held to the cap too");
  }

  /* ---------- 4b. FIXED #10 (was CRITICAL): negative-amount ledger CREDIT ---------- */
  // WAS: a merchant-controlled 402 could advertise a negative base amount. It
  // was allowed, and `ledger.record()` stored a NEGATIVE entry that
  // `spentMicro()` summed — permanently raising the effective cap for the
  // agent, the merchant AND the mandate key at once.
  // NOW: spend-control rejects any amount that is not a base-unit integer, so
  // the negative 402 blocks and nothing is recorded. Flipped to the SHOULD BE.
  {
    const ledger = createMemorySpendLedger();
    let signs = 0;
    const pay = async () => { signs += 1; return { response: new Response("ok") }; };
    const base = { maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", pay } as const;

    const credit = await twzrd.safeFetch(RES, { ...base, fetch: f402("-9000000") });
    assert.equal(credit.verdict, "block", "the -9 USDC 402 is refused");
    assert.equal(credit.reason, "malformed_amount", "and refused as a malformed amount");
    assert.equal(credit.signerInvocations, 0, "a negative 402 never reaches the signer");
    assert.equal(
      ledger.spentMicro("agent:a1", YEAR, Date.now()),
      0n,
      "no credit was written to the ledger",
    );

    // The cap is intact, so it permits exactly one 1.00 USDC payment.
    const drained: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      drained.push((await twzrd.safeFetch(RES, { ...base, fetch: f402("1000000") })).verdict);
    }
    assert.deepEqual(drained, ["allow", "block", "block", "block"],
      "a 1.00 USDC cumulative cap permits exactly one 1.00 USDC payment");
    assert.equal(signs, 1, "one signature under a cap that permits one");
    assert.equal(ledger.spentMicro(`merchant:${SOL}`, YEAR, Date.now()), 1_000_000n,
      "the merchant scope records the one real spend, never a credit");
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

  /* ---------- 4d. FIXED on main (#61): no payer wired → no budget consumed ---------- */
  // Pre-#61: `if (signerInvocations > 0 || !opts.pay)` booked spend on a
  // decision-only probe. #61 records only after an actual signer invocation.
  {
    const ledger = createMemorySpendLedger();
    const r = await twzrd.safeFetch(RES, {
      maxSpend: "1.00", ledger, agentId: "a1", mandateId: "m1", fetch: f402("1000000"),
    });
    assert.equal(r.verdict, "allow");
    assert.equal(r.signerInvocations, 0, "no payer wired, so nothing was signed");
    assert.equal(ledger.spentMicro("agent:a1", YEAR, Date.now()), 0n,
      "a probe that paid nothing must not consume cumulative budget");
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

  console.log("red-spend-race.test.ts: ALL PASSED (1 remaining DEFECT encoded — thrown-settle un-book)");
}

run().catch((e) => {
  console.error("red-spend-race.test.ts FAILED:", e);
  process.exit(1);
});
