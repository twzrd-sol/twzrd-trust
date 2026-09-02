/**
 * Durable spend ledger under concurrency.
 *
 * `createFileSpendLedger()` reads the file once and then carries `lastHash` in
 * a closure. `spendControlSafeFetch` used to construct one PER CALL, so two
 * concurrent calls each read the same pre-state, each held the same `lastHash`,
 * and each appended a row claiming that `prev`. The file then has two rows with
 * the same parent and every later replay throws "spend ledger chain broken" —
 * the durable ledger is permanently unreadable. That fails closed, but it
 * bricks the agent's budget rather than protecting it.
 *
 * Fixed by `sharedFileSpendLedger()`: one instance per resolved path, so the
 * synchronous `record()` calls serialise and the chain stays linear.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { twzrd } from "../src/spend-control.js";
import {
  createFileSpendLedger,
  sharedFileSpendLedger,
  __resetSharedFileSpendLedgers,
} from "../src/spend-ledger-file.js";

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
  /* ---------- 1. concurrent settles must not break the hash chain ---------- */
  {
    __resetSharedFileSpendLedgers();
    const file = join(mkdtempSync(join(tmpdir(), "twzrd-ledger-")), "spend.jsonl");
    let signs = 0;
    const pay = async () => {
      signs += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { response: new Response("ok") };
    };
    // Cap is generous so the reservation does not mask the chain question:
    // this case is about ledger integrity, not about the cumulative cap.
    const opts = {
      maxSpend: "100.00", ledgerFile: file, agentId: "a1", mandateId: "m1",
      pay, fetch: f402("1000000"),
    };
    const results = await Promise.all(Array.from({ length: 3 }, () => twzrd.safeFetch(RES, opts)));

    assert.deepEqual(results.map((r) => r.verdict), ["allow", "allow", "allow"],
      "all three are within the cap and must settle");
    assert.equal(signs, 3, "three settles, three signatures");

    // The real assertion: replaying the file must not throw. Pre-fix this is
    // "spend ledger chain broken" because every row claimed prev='genesis'.
    __resetSharedFileSpendLedgers();
    const replay = createFileSpendLedger(file);
    assert.equal(replay.spentMicro("agent:a1", YEAR, Date.now()), 3_000_000n,
      "the replayed ledger reports every settled row, not just the last writer");

    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 9, "3 settles x 3 scope keys (agent, merchant, mandate)");
    const prevs = rows.map((r) => r.prev);
    assert.equal(new Set(prevs).size, prevs.length,
      "every row must chain from a DISTINCT parent — a repeated prev is the corruption");
    assert.equal(prevs.filter((p) => p === "genesis").length, 1,
      "exactly one row may claim genesis");
  }

  /* ---------- 2. one instance per path, and it is the same object ---------- */
  {
    __resetSharedFileSpendLedgers();
    const dir = mkdtempSync(join(tmpdir(), "twzrd-ledger-"));
    const a = join(dir, "one.jsonl");
    assert.equal(sharedFileSpendLedger(a), sharedFileSpendLedger(a),
      "same path resolves to the same instance — this is what gives the " +
      "in-flight spend reservation a stable identity to key on");
    assert.notEqual(sharedFileSpendLedger(a), sharedFileSpendLedger(join(dir, "two.jsonl")),
      "different paths stay independent");
    // Path is resolved, so ./x and x are one ledger, not two racing ones.
    assert.equal(sharedFileSpendLedger(a), sharedFileSpendLedger(join(dir, ".", "one.jsonl")),
      "equivalent paths resolve to one instance");
  }

  /* ---------- 3. the cumulative cap still holds on the durable path ---------- */
  {
    __resetSharedFileSpendLedgers();
    const file = join(mkdtempSync(join(tmpdir(), "twzrd-ledger-")), "spend.jsonl");
    let signs = 0;
    const opts = {
      maxSpend: "1.00", ledgerFile: file, agentId: "a1", mandateId: "m1",
      fetch: f402("1000000"),
      pay: async () => { signs += 1; return { response: new Response("ok") }; },
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => twzrd.safeFetch(RES, opts)));
    assert.deepEqual(results.map((r) => r.verdict).sort(), ["allow", "block", "block", "block"],
      "the reservation must hold on the FILE ledger path too, not only in memory " +
      "— a per-call ledger object would have given each call its own empty " +
      "reservation map and silently allowed all four");
    assert.equal(signs, 1, "exactly one signature under a one-payment cap");
  }

  console.log("audit-ledger-chain.test.ts: ALL PASSED");
}

await run();
