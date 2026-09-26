/**
 * AUDIT: an accepts[] entry whose v1 and v2 price fields disagree has no single
 * price, and must be refused - never resolved by precedence.
 *
 * x402 v1 prices an offer with `maxAmountRequired`, v2 with `amount`, and a
 * client pays the field of its own version (@x402/svm exact v2 builds the
 * transfer from `requirements.amount`). The seller controls both fields and
 * `x402Version`. This package read them with BOTH precedences at once:
 *   - payto.ts (spend-control, safe-fetch, evaluate, mcp-hook, wrap-fetch):
 *     maxAmountRequired ?? amount
 *   - resource-bind, wash-default, payment-decision, intent-adapters,
 *     x402-client-hook: amount ?? maxAmountRequired
 * so a decoy in either field slid under a cap on one path or the other, and the
 * two normalizers wrote the chosen value back into BOTH fields, laundering it.
 *
 * Cases:
 *   1  v2 entry, decoy v1 field    -> spend-control blocks amount_field_conflict
 *   2  v1 entry, decoy v2 field    -> client hook (v2-first path) aborts
 *   3  CONTROL dual-emit, equal    -> spend-control still allows and pays
 *   4  payTo / pay_to disagree     -> spend-control blocks payto_field_conflict
 *   5  normalizers keep raw fields -> no laundering
 *   6  wash-only evaluator aborts  -> not the fail-open no-payTo skip
 *   7  bound path refuses to stamp -> no leaf over an ambiguous entry
 *   8  payment-decision merchant identity refuses on its own
 *   9  resolver unit cases
 *
 * Offline, deterministic. Run: npx tsx test/amount-field-conflict.test.ts
 */
import assert from "node:assert/strict";

import {
  AMOUNT_FIELD_CONFLICT,
  PAYTO_FIELD_CONFLICT,
  resolveRequirementFields,
} from "../src/payto.js";
import { merchantFromChallenge } from "../src/payment-decision.js";
import { stampResourceBind } from "../src/resource-bind.js";
import { spendControlSafeFetch } from "../src/spend-control.js";
import { evaluateWashOnlyBeforePayment, mapWashRequirements } from "../src/wash-default.js";
import {
  evaluateBeforePaymentCreation,
  mapX402SolanaRequirements,
} from "../src/x402-client-hook.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const OTHER = "8FVeybWnB4dYrxTuPK7WzFZNAiEcFVaDLFnKpRwVGr5s";
const RESOURCE = "https://m.example/p";

const allowIntel: typeof fetch = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? new Response("{}", { status: 404 })
    : new Response(
        JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } }),
        { status: 200 },
      )) as unknown as typeof fetch;

function seller402(entry: Record<string, unknown>, x402Version = 2): typeof fetch {
  const body = { x402Version, accepts: [{ scheme: "exact", network: SOL, asset: USDC, resource: RESOURCE, ...entry }] };
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 402,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function spend(entry: Record<string, unknown>) {
  let paid = 0;
  const r = await spendControlSafeFetch(RESOURCE, {
    fetch: seller402(entry),
    maxSpend: "0.01",
    pay: async () => {
      paid += 1;
      return {};
    },
  });
  return { r, paid };
}

async function run() {
  // 1. v2 entry with a disagreeing v1 field.
  {
    const { r, paid } = await spend({ payTo: SELLER, amount: "50000000", maxAmountRequired: "1000" });
    assert.equal(r.verdict, "block");
    assert.equal(r.reason, AMOUNT_FIELD_CONFLICT);
    assert.equal(r.signerInvocations, 0);
    assert.equal(paid, 0, "payer invoked for a conflicted entry");
  }

  // 2. The mirror: v1 entry, decoy v2 field, hitting the v2-first client hook.
  {
    const r = await evaluateBeforePaymentCreation(
      { payTo: SELLER, network: SOL, amount: "1000", maxAmountRequired: "50000000", resource: RESOURCE },
      { fetch: allowIntel },
    );
    assert.ok(r && "abort" in r && r.abort, "client hook proceeded on a conflicted entry");
    assert.match(String((r as { reason?: string }).reason), /amount_field_conflict/);
  }

  // 3. CONTROL: dual-emit with equal values (TWZRD's own 402s) must still pay.
  {
    const { r, paid } = await spend({ payTo: SELLER, amount: "1000", maxAmountRequired: "1000" });
    assert.equal(r.verdict, "allow");
    assert.equal(r.signerInvocations, 1);
    assert.equal(paid, 1);
  }

  // 4. Recipient conflict.
  {
    const { r, paid } = await spend({ payTo: SELLER, pay_to: OTHER, amount: "1000" });
    assert.equal(r.verdict, "block");
    assert.equal(r.reason, PAYTO_FIELD_CONFLICT);
    assert.equal(paid, 0);
  }

  // 5. Normalizers must not launder: raw fields survive so the evaluator refuses.
  {
    const raw = { payTo: SELLER, network: SOL, amount: "1000", maxAmountRequired: "50000000" };
    for (const map of [mapX402SolanaRequirements, mapWashRequirements]) {
      const m = map(raw as never) as Record<string, unknown>;
      assert.equal(m.amount, "1000");
      assert.equal(m.maxAmountRequired, "50000000", `${map.name} collapsed a conflict`);
      assert.equal(resolveRequirementFields(m).conflict, AMOUNT_FIELD_CONFLICT);
    }
    const clean = mapX402SolanaRequirements({ payTo: SELLER, network: SOL, amount: "1000" } as never);
    assert.equal(clean.amount, "1000");
    assert.equal(clean.maxAmountRequired, "1000");
  }

  // 6. Wash-only evaluator: refuse, never the fail-open no-payTo skip.
  {
    const seen: Array<Record<string, unknown>> = [];
    const r = await evaluateWashOnlyBeforePayment(
      { payTo: SELLER, pay_to: OTHER, network: SOL, amount: "1000" },
      { fetch: allowIntel, onDecision: (d) => seen.push(d as Record<string, unknown>) },
    );
    assert.ok(r && r.abort, "wash-only evaluator proceeded on a conflicted entry");
    assert.equal(seen[0]?.approved, false);
    assert.equal(seen[0]?.reason, PAYTO_FIELD_CONFLICT);
  }

  // 7. Bound path: no leaf hash over an entry with two prices, and it says why.
  {
    const base = { payTo: SELLER, network: SOL, asset: USDC, resource: RESOURCE };
    const clean = stampResourceBind({ ...base, amount: "1000" } as never);
    assert.ok(clean.leaf_hash, "control: a clean entry must stamp a leaf");
    const d = stampResourceBind({ ...base, amount: "50000000", maxAmountRequired: "1000" } as never);
    assert.equal(d.leaf_hash, null, "stamped a leaf over a conflicted entry");
    assert.equal(d.reason, AMOUNT_FIELD_CONFLICT);
  }

  // 8. Payment-decision merchant identity refuses on its own, not via call order.
  {
    const base = { network: SOL, asset: USDC, resource: RESOURCE, amount: "1000", scheme: "exact" };
    assert.equal(merchantFromChallenge({ ...base, payTo: SELLER } as never).pay_to, SELLER);
    assert.throws(
      () => merchantFromChallenge({ ...base, payTo: SELLER, pay_to: OTHER } as never),
      /payto_field_conflict/,
    );
  }

  // 9. Resolver.
  {
    assert.deepEqual(resolveRequirementFields({ amount: "5" }), { payTo: undefined, amount: "5", conflict: undefined });
    assert.deepEqual(resolveRequirementFields({ maxAmountRequired: "5" }), { payTo: undefined, amount: "5", conflict: undefined });
    assert.equal(resolveRequirementFields({ amount: "5", maxAmountRequired: "5" }).conflict, undefined);
    assert.equal(resolveRequirementFields({ amount: "5", maxAmountRequired: "6" }).conflict, AMOUNT_FIELD_CONFLICT);
    // "" is a value, not an absence - same rule as `??`, which only skips null/undefined.
    assert.equal(resolveRequirementFields({ amount: "", maxAmountRequired: "6" }).conflict, AMOUNT_FIELD_CONFLICT);
    assert.equal(resolveRequirementFields({ payTo: "a", pay_to: "a" }).conflict, undefined);
    assert.equal(resolveRequirementFields({ payTo: "a", pay_to: "b" }).payTo, undefined);
  }

  console.log("amount-field-conflict.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("amount-field-conflict.test.ts FAILED:", e);
  process.exit(1);
});
