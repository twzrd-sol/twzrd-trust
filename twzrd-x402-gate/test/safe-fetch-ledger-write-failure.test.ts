/**
 * twzrd.safeFetch with a spend ledger that stops taking writes.
 *
 * Without a WAL the payment is written to the ledger after the payer returns.
 * When that write fails the payment has still been signed, so it has to keep
 * counting against maxSpend for as long as this process lives.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySpendLedger, type SpendLedger } from "../src/policy-runtime.js";
import { twzrd } from "../src/spend-control.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const fetch402 = (async () =>
  new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [{
        scheme: "exact", network: "solana", payTo: SELLER, amount: "10000", asset: USDC,
        resource: "https://merchant.example/paid",
      }],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

/** A ledger that reads normally and refuses every write once `broken` is set. */
function breakableLedger(): { ledger: SpendLedger; break(): void } {
  const inner = createMemorySpendLedger();
  let broken = false;
  return {
    ledger: {
      ...inner,
      spentMicro: (...args: Parameters<SpendLedger["spentMicro"]>) => inner.spentMicro(...args),
      record: (...args: Parameters<SpendLedger["record"]>) => {
        if (broken) throw new Error("EACCES: spend ledger is not writable");
        return inner.record(...args);
      },
    } as SpendLedger,
    break: () => { broken = true; },
  };
}

test("a payment the ledger could not record still counts against maxSpend", async () => {
  const { ledger, break: breakLedger } = breakableLedger();
  let signs = 0;
  const pay = async () => {
    signs += 1;
    return { response: new Response("paid", { status: 200 }) };
  };
  const opts = { fetch: fetch402, maxSpend: "0.03", ledger, pay };
  assert.equal((await twzrd.safeFetch("https://merchant.example/paid", opts)).verdict, "allow");
  breakLedger();

  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    try {
      const r = await twzrd.safeFetch("https://merchant.example/paid", opts);
      outcomes.push(r.verdict + (r.reason ? ":" + r.reason : ""));
    } catch (e) {
      outcomes.push("threw");
    }
  }
  // 0.01 on the ledger, then two signed payments the ledger refused: 0.03 in
  // all, the cap. Every later call is refused before the payer runs.
  assert.equal(signs, 3, `signed ${signs} payments of 0.01 under a 0.03 cap: ${outcomes.join(", ")}`);
  assert.deepEqual(outcomes.slice(0, 2), ["threw", "threw"]);
  assert.deepEqual([...new Set(outcomes.slice(2))], ["block:over_cumulative_spend"]);
});

test("a payer that throws while the ledger is unwritable is counted too", async () => {
  const { ledger, break: breakLedger } = breakableLedger();
  let signs = 0;
  const pay = async () => {
    signs += 1;
    throw new Error("connection reset after the payment was sent");
  };
  breakLedger();
  const opts = { fetch: fetch402, maxSpend: "0.02", ledger, pay };
  for (let i = 0; i < 6; i++) {
    try { await twzrd.safeFetch("https://merchant.example/paid", opts); } catch { /* counted below */ }
  }
  assert.equal(signs, 2);
});

test("a ledger that takes the write releases the hold as before", async () => {
  const ledger = createMemorySpendLedger();
  let signs = 0;
  const pay = async () => {
    signs += 1;
    return { response: new Response("paid", { status: 200 }) };
  };
  const opts = { fetch: fetch402, maxSpend: "0.03", ledger, pay };
  for (let i = 0; i < 5; i++) await twzrd.safeFetch("https://merchant.example/paid", opts);
  assert.equal(signs, 3);
  assert.equal(ledger.spentMicro("agent:default", 3_600_000, Date.now()), 30_000n);
});
