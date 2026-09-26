/**
 * Product twzrd.safeFetch — shared-budget reservations under concurrency.
 * Run: npx tsx test/spend-control-concurrency.test.ts
 *
 * The cumulative cap is read before the payment is awaited and recorded after
 * it returns. Two calls in flight against one ledger both pass the read and both
 * sign, so a mandate capped at $0.01 records $0.02. These cases pin the fix:
 * reserve atomically before signing, commit after, release only on a refusal
 * that provably never signed, and never release on an ambiguous failure.
 *
 * Scope: ONE process sharing ONE ledger object. Nothing here proves anything
 * across processes; a second process holding the same ledger file has its own
 * view and that gap is documented, not covered.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { tempDir } from "./helpers/tmpdir.js";
import { createMemorySpendLedger, type SpendLedger } from "../src/policy-runtime.js";
import { createFileSpendLedger } from "../src/spend-ledger-file.js";
import { twzrd } from "../src/spend-control.js";

const SOL = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const URL = "https://merchant.example/paid";
const WIN = 365 * 24 * 3600 * 1000;
const body402 = () => ({
  x402Version: 1,
  accepts: [{ scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC, resource: URL }],
});
const fetch402: typeof fetch =
  (async () => new Response(JSON.stringify(body402()), { status: 402, headers: { "content-type": "application/json" } })) as typeof fetch;

/** Mock payer: counts invocations, parks each call for a tick so the other call's check runs mid-flight. */
function payer() {
  let signs = 0;
  const pay = async () => {
    signs += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { response: new Response("paid", { status: 200 }) };
  };
  return { pay, signs: () => signs };
}

async function twoConcurrent(ledger: SpendLedger, label: string) {
  const p = payer();
  const opts = { fetch: fetch402, maxSpend: "0.01", ledger, agentId: "a1", mandateId: "m1", pay: p.pay };
  const [r1, r2] = await Promise.all([twzrd.safeFetch(URL, opts), twzrd.safeFetch(URL, opts)]);
  const verdicts = [r1, r2].map((r) => r.verdict).sort();
  assert.deepEqual(verdicts, ["allow", "block"], `${label}: exactly one of two concurrent calls may pay`);
  const blocked = [r1, r2].find((r) => r.verdict === "block")!;
  assert.equal(blocked.reason, "over_cumulative_spend", label);
  assert.equal(blocked.signerInvocations, 0, `${label}: the blocked call must never reach the signer`);
  assert.equal(p.signs(), 1, `${label}: signer invoked once, not twice`);
  assert.equal(ledger.spentMicro("mandate:m1", WIN, Date.now()), 10000n, `${label}: ledger holds one payment, not two`);
}

async function run() {
  // A. Two concurrent calls, one shared in-memory ledger, cap == one price.
  await twoConcurrent(createMemorySpendLedger(), "memory ledger");

  // B. Same, on the durable file ledger shared as ONE object in ONE process.
  const dir = tempDir("twzrd-spend-conc-");
  await twoConcurrent(createFileSpendLedger(join(dir, "ledger.jsonl")), "file ledger (single process)");

  // C. N in flight, budget for K: exactly K sign, N-K block, ledger == K * price.
  {
    const led = createMemorySpendLedger();
    const p = payer();
    const opts = { fetch: fetch402, maxSpend: "0.03", ledger: led, agentId: "a1", mandateId: "m1", pay: p.pay };
    const rs = await Promise.all(Array.from({ length: 5 }, () => twzrd.safeFetch(URL, opts)));
    assert.equal(rs.filter((r) => r.verdict === "allow").length, 3, "5 in flight, budget for 3: three allow");
    assert.equal(rs.filter((r) => r.reason === "over_cumulative_spend").length, 2, "and two block");
    assert.equal(p.signs(), 3);
    assert.equal(led.spentMicro("mandate:m1", WIN, Date.now()), 30000n);
  }

  // D. Ambiguous failure: the payer throws after it may have broadcast. The
  //    budget must stay consumed (conservative), and the error must surface.
  {
    const led = createMemorySpendLedger();
    const boom = async () => { throw new Error("broadcast timeout: unknown outcome"); };
    const opts = { fetch: fetch402, maxSpend: "0.01", ledger: led, agentId: "a1", mandateId: "m1", pay: boom };
    await assert.rejects(() => twzrd.safeFetch(URL, opts), /unknown outcome/, "ambiguous failure surfaces to the caller");
    assert.equal(led.spentMicro("mandate:m1", WIN, Date.now()), 10000n, "no early release after an unknown broadcast");
    const p = payer();
    const next = await twzrd.safeFetch(URL, { ...opts, pay: p.pay });
    assert.equal(next.verdict, "block", "the next call is blocked: the unknown payment is still counted");
    assert.equal(next.reason, "over_cumulative_spend");
    assert.equal(p.signs(), 0);
  }

  // E. A refusal that provably never signed releases its reservation: a blocked
  //    preflight must not leave a phantom hold that starves the next call.
  //    (Guard for the fix; passes today because no reservation exists yet.)
  {
    const led = createMemorySpendLedger();
    const p = payer();
    const base = { fetch: fetch402, maxSpend: "0.01", ledger: led, agentId: "a1", mandateId: "m1", pay: p.pay };
    const refused = await twzrd.safeFetch(URL, { ...base, preflight: async () => ({ decision: "block" }) });
    assert.equal(refused.verdict, "block");
    assert.equal(led.spentMicro("mandate:m1", WIN, Date.now()), 0n, "a refusal before signing records nothing");
    const ok = await twzrd.safeFetch(URL, base);
    assert.equal(ok.verdict, "allow", "no phantom hold after a refusal");
    assert.equal(p.signs(), 1);
  }

  // F. Callers that pass only `ledgerFile` never share a ledger object; the
  //    process must still hold one head per path or the holds cannot see each
  //    other (and two heads would corrupt the hash chain on the next replay).
  {
    const file = join(tempDir("twzrd-spend-path-"), "ledger.jsonl");
    const p = payer();
    const opts = { fetch: fetch402, maxSpend: "0.01", ledgerFile: file, agentId: "a1", mandateId: "m1", pay: p.pay };
    const rs = await Promise.all([twzrd.safeFetch(URL, opts), twzrd.safeFetch(URL, opts)]);
    assert.deepEqual(rs.map((r) => r.verdict).sort(), ["allow", "block"], "ledgerFile path: one of two pays");
    assert.equal(p.signs(), 1);
    assert.equal(createFileSpendLedger(file).spentMicro("mandate:m1", WIN, Date.now()), 10000n, "replay shows one payment, chain intact");
  }

  // G. Relative vs absolute ledgerFile must intern as one object. Two spellings
  //    of the same file used to split holds and both pay.
  {
    const abs = join(tempDir("twzrd-spend-abs-"), "ledger.jsonl");
    const rel = relative(process.cwd(), abs);
    const p = payer();
    const base = { fetch: fetch402, maxSpend: "0.01", agentId: "a1", mandateId: "m1", pay: p.pay };
    const rs = await Promise.all([
      twzrd.safeFetch(URL, { ...base, ledgerFile: abs }),
      twzrd.safeFetch(URL, { ...base, ledgerFile: rel }),
    ]);
    assert.deepEqual(rs.map((r) => r.verdict).sort(), ["allow", "block"], "abs+rel ledgerFile: one of two pays");
    assert.equal(p.signs(), 1);
  }

  console.log("spend-control-concurrency.test.ts: ALL PASSED");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
