/**
 * safeFetch with more than one accepts[] entry (0.26.0).
 *
 * AgentCash re-fetches the target and pays an entry of its own choosing, not the
 * one TWZRD scored. Before 0.26.0 safeFetch scored one entry (pickRequirements)
 * and called the payer with the URL only, so an unscored or refused entry next to
 * a clean one could be paid. Now every distinct entry the payer could pay is
 * checked, one refusal refuses the call, and the payer is told what was checked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { offerMatchesPaymentNetwork, safeFetch, type SafeFetchOptions } from "../src/safe-fetch.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GOOD_EVM = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const BAD_EVM = "0xBAd0000000000000000000000000000000000Bad";

const solEntry = { scheme: "exact", network: SOL, payTo: SOL_SELLER, amount: "10000", asset: SOL_USDC };
const baseEntry = (payTo: string, amount = "10000") =>
  ({ scheme: "exact", network: "eip155:8453", payTo, amount, asset: BASE_USDC });

type PayerArgs = Parameters<NonNullable<SafeFetchOptions["runPayer"]>>[0];

/** Merchant 402 with `accepts`; preflight (a POST naming the seller) allows every seller except BAD_EVM. */
function harness(accepts: unknown[]) {
  const payerCalls: PayerArgs[] = [];
  const preflightSellers: string[] = [];
  const opts: SafeFetchOptions = {
    url: "https://merchant.example/paid",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.startsWith("https://merchant.example/")) {
        return new Response(JSON.stringify({ x402Version: 2, accepts }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/preflight")) {
        const sent = (u + " " + String(init?.body ?? "")).toLowerCase();
        const bad = sent.includes(BAD_EVM.toLowerCase());
        preflightSellers.push(bad ? BAD_EVM : sent.includes(SOL_SELLER.toLowerCase()) ? SOL_SELLER : GOOD_EVM);
        const card = bad
          ? { decision: "block", can_spend: false, trust_score: 5, seller_wallet: BAD_EVM, wash_flagged: true }
          : { decision: "allow", can_spend: true, trust_score: 90 };
        return new Response(JSON.stringify({ readiness_card: card }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    runPayer: async (args) => {
      payerCalls.push(args);
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
    deliveryCapture: false,
    refuseWashFlagged: false,
    refuseWashUnknown: false,
  };
  return { opts, payerCalls, preflightSellers };
}

test("a refused entry next to the scored one refuses the call before the payer", async () => {
  // pickRequirements prefers Solana, so the clean Solana entry is scored first.
  // AgentCash could still pay the Base entry, whose seller preflight blocks.
  const h = harness([solEntry, baseEntry(BAD_EVM)]);
  const r = await safeFetch(h.opts);
  assert.equal(r.phase, "blocked");
  assert.match(String(r.error), /^alternate_offer_refused:/);
  assert.equal(h.payerCalls.length, 0, "payer must not run");
  assert.equal(r.network, SOL, "the scored entry is still reported");
  assert.equal(r.requirementsEvaluated?.length, 1, "only the approved entries are listed");
});

test("the same refusal holds on dry run", async () => {
  const h = harness([solEntry, baseEntry(BAD_EVM)]);
  const r = await safeFetch({ ...h.opts, dryRun: true });
  assert.equal(r.phase, "blocked");
  assert.match(String(r.error), /^alternate_offer_refused:/);
});

test("when every entry passes, the payer is told the scored entry and every entry checked", async () => {
  const h = harness([solEntry, baseEntry(GOOD_EVM)]);
  const r = await safeFetch(h.opts);
  assert.equal(r.phase, "paid");
  assert.equal(h.payerCalls.length, 1);
  const told = h.payerCalls[0]!;
  assert.equal(told.requirement?.network, SOL);
  assert.deepEqual(told.requirementsEvaluated?.map((e) => e.network), [SOL, "eip155:8453"]);
  assert.deepEqual(r.requirementsEvaluated?.map((e) => e.payTo), [SOL_SELLER, GOOD_EVM]);
});

test("paymentNetwork narrows the entries checked to that network", async () => {
  const h = harness([solEntry, baseEntry(BAD_EVM)]);
  const r = await safeFetch({ ...h.opts, paymentNetwork: "solana" });
  assert.equal(r.phase, "paid");
  assert.equal(h.preflightSellers.includes(BAD_EVM), false, "the Base entry is not a candidate");
  assert.deepEqual(h.payerCalls[0]!.requirementsEvaluated?.map((e) => e.network), [SOL]);
});

test("paymentNetwork picks the entry it names, even when Solana is listed", async () => {
  const h = harness([solEntry, baseEntry(BAD_EVM)]);
  const r = await safeFetch({ ...h.opts, paymentNetwork: "base" });
  assert.equal(r.phase, "blocked", "the Base entry is what would be paid, and it is refused");
  assert.equal(r.network, "eip155:8453");
  assert.equal(h.payerCalls.length, 0);
});

test("a paymentNetwork the 402 does not offer refuses", async () => {
  const h = harness([solEntry]);
  const r = await safeFetch({ ...h.opts, paymentNetwork: "base" });
  assert.equal(r.phase, "blocked");
  assert.equal(r.error, "payment_network_not_offered");
  assert.equal(h.payerCalls.length, 0);
});

test("duplicate entries are checked once", async () => {
  const h = harness([solEntry, { ...solEntry }, baseEntry(GOOD_EVM), baseEntry(GOOD_EVM)]);
  const r = await safeFetch(h.opts);
  assert.equal(r.phase, "paid");
  assert.equal(r.requirementsEvaluated?.length, 2);
});

test("more than eight distinct entries refuses without preflighting the rest", async () => {
  const many = Array.from({ length: 8 }, (_, i) => baseEntry(GOOD_EVM, String(10000 + i)));
  const h = harness([solEntry, ...many]);
  const r = await safeFetch(h.opts);
  assert.equal(r.phase, "blocked");
  assert.equal(r.error, "too_many_payment_options");
  assert.equal(h.payerCalls.length, 0);
});

test("offerMatchesPaymentNetwork", () => {
  assert.equal(offerMatchesPaymentNetwork({ network: SOL }, "solana"), true);
  assert.equal(offerMatchesPaymentNetwork({ network: "eip155:8453" }, "base"), true);
  assert.equal(offerMatchesPaymentNetwork({ network: "eip155:8453" }, "eip155:8453"), true);
  assert.equal(offerMatchesPaymentNetwork({ network: "eip155:84532" }, "base"), false);
  assert.equal(offerMatchesPaymentNetwork({ network: "eip155:5042" }, "eip155"), true);
  assert.equal(offerMatchesPaymentNetwork({ network: "solana-devnet" }, "solana"), false);
  assert.equal(offerMatchesPaymentNetwork({}, "solana"), false);
});
