/**
 * A requirement field that is present with the wrong type is refused.
 *
 * The gate read payTo with String(value) and skipped a non-string asset,
 * while the Solana clients read the raw value as a public key:
 *   - payTo: []            -> "no recipient" here, the all-zero key there
 *   - payTo: ["<clean>"]   -> scored as the clean seller, paid to the zero key
 *   - asset: [32 numbers]  -> "no asset named" here (priced as USDC), a real
 *                             non-USDC mint there
 * Every seat that reads a requirement through resolveRequirementFields now
 * refuses these before intel and before any signature.
 *
 * Run: npx tsx --test test/requirement-field-types.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate_x402_resource } from "../src/evaluate.js";
import { TwzrdUnpricedAssetError, x402RequirementsToIntent } from "../src/intent-adapters.js";
import {
  ASSET_MALFORMED,
  NETWORK_MALFORMED,
  PAYTO_MALFORMED,
  resolveRequirementFields,
} from "../src/payto.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { evaluateWashOnlyBeforePayment } from "../src/wash-default.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const PAID_URL = "https://merchant.example/paid";
/** 32 byte values: how a seller names a mint the string check never sees. */
const MINT_BYTES = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Intel that would approve anything it is asked about, and counts the asks. */
function allowingIntel(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/intel/preflight")) {
      return jsonResponse({ readiness_card: { decision: "allow", trust_score: 80, can_spend: true } });
    }
    if (url.includes("/v1/intel/merchant_card/")) return jsonResponse({ wash_flagged: false, wash_confidence: "full" });
    throw new Error(`unexpected intel url ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const aborted = (r: { abort?: boolean } | void | undefined) => Boolean(r && r.abort === true);
const reasonOf = (r: { reason?: string } | void | undefined) => String(r?.reason ?? "");

test("resolveRequirementFields: mistyped payTo, asset, network and amount are conflicts", () => {
  const ok = resolveRequirementFields({ payTo: CLEAN, amount: "1000", asset: USDC, network: "solana" });
  assert.deepEqual(ok, { payTo: CLEAN, amount: "1000", conflict: undefined });
  assert.equal(resolveRequirementFields({ payTo: CLEAN, amount: 1000 }).amount, "1000", "a number amount still reads");
  assert.equal(resolveRequirementFields({ pay_to: CLEAN, maxAmountRequired: "5" }).payTo, CLEAN);
  assert.equal(resolveRequirementFields({ payTo: CLEAN, amount: "1", asset: null, network: null }).conflict, undefined);

  for (const payTo of [[], [CLEAN], [[CLEAN]], { toString: CLEAN }, 7, true]) {
    const f = resolveRequirementFields({ payTo, amount: "1000" });
    assert.equal(f.conflict, PAYTO_MALFORMED, JSON.stringify(payTo));
    assert.equal(f.payTo, undefined, "a mistyped recipient is never returned as a value");
  }
  assert.equal(resolveRequirementFields({ payTo: CLEAN, pay_to: [CLEAN], amount: "1" }).conflict, PAYTO_MALFORMED);
  assert.equal(resolveRequirementFields({ pay_to: [], amount: "1" }).conflict, PAYTO_MALFORMED);

  for (const asset of [MINT_BYTES, [USDC], { mint: USDC }, 5, false]) {
    assert.equal(resolveRequirementFields({ payTo: CLEAN, amount: "1000", asset }).conflict, ASSET_MALFORMED);
  }
  for (const network of [["solana"], ["solana-devnet"], { id: "solana" }, 101]) {
    assert.equal(resolveRequirementFields({ payTo: CLEAN, amount: "1000", network }).conflict, NETWORK_MALFORMED);
  }
  for (const amount of [["1000"], [["5000000"]], { value: "1" }, true]) {
    const f = resolveRequirementFields({ payTo: CLEAN, amount });
    assert.equal(f.conflict, "amount_malformed", JSON.stringify(amount));
    assert.equal(f.amount, undefined);
  }
  assert.equal(resolveRequirementFields({ payTo: CLEAN, amount: "1000", maxAmountRequired: ["1000"] }).conflict, "amount_malformed");
});

test("wash seat: an array payTo is refused, not skipped and not scored as its first element", async () => {
  for (const payTo of [[], [CLEAN]]) {
    const intel = allowingIntel();
    const result = await evaluateWashOnlyBeforePayment(
      { payTo, amount: "50000" } as never,
      { fetch: intel.fetch },
    );
    assert.equal(aborted(result), true, `payTo ${JSON.stringify(payTo)} must abort`);
    assert.match(reasonOf(result), /payto_malformed/);
    assert.deepEqual(intel.calls, [], "refused before any lookup");
  }
  // Control: the same seller as a string is looked up and approved.
  const intel = allowingIntel();
  const control = await evaluateWashOnlyBeforePayment({ payTo: CLEAN, amount: "50000" }, { fetch: intel.fetch });
  assert.equal(control, undefined);
  assert.equal(intel.calls.length, 1);
});

test("x402-solana seat: a byte-array asset is refused before intel", async () => {
  const intel = allowingIntel();
  const hook = createTwzrdBeforePaymentHook({ fetch: intel.fetch });
  const offer = { payTo: CLEAN, network: "solana", amount: "1000000", resource: PAID_URL };

  const asArray = await hook({ ...offer, asset: MINT_BYTES } as never);
  assert.equal(aborted(asArray), true);
  assert.match(reasonOf(asArray), /asset_malformed/);
  assert.deepEqual(intel.calls, [], "no preflight for a requirement the gate cannot read");

  const arrayPayTo = await hook({ ...offer, asset: USDC, payTo: [CLEAN] } as never);
  assert.equal(aborted(arrayPayTo), true);
  assert.match(reasonOf(arrayPayTo), /payto_malformed/);

  const arrayNetwork = await hook({ ...offer, asset: USDC, network: ["solana-devnet"] } as never);
  assert.equal(aborted(arrayNetwork), true);
  assert.match(reasonOf(arrayNetwork), /network_malformed/);
  assert.deepEqual(intel.calls, []);

  // Control: the same offer with USDC named as a string is evaluated.
  const control = await hook({ ...offer, asset: USDC } as never);
  assert.equal(aborted(control), false, reasonOf(control));
  assert.ok(intel.calls.length > 0);
});

test("intent adapter and evaluate_x402_resource refuse the array forms too", async () => {
  const base = { payTo: CLEAN, network: "solana", amount: "1000000", resource: PAID_URL };
  assert.throws(() => x402RequirementsToIntent({ ...base, asset: MINT_BYTES } as never), /asset_malformed/);
  assert.throws(() => x402RequirementsToIntent({ ...base, asset: USDC, payTo: [CLEAN] } as never), /payto_malformed/);
  // A non-USDC mint named as a string keeps its own refusal.
  assert.throws(
    () => x402RequirementsToIntent({ ...base, asset: "JArG9RUGPSdmHLFWir9KGHb5m8teHwWpHi9TS5psoqWq" } as never),
    TwzrdUnpricedAssetError,
  );

  const intel = allowingIntel();
  const evaluated = await evaluate_x402_resource(
    PAID_URL,
    { ...base, asset: MINT_BYTES } as unknown as X402PaymentRequirements,
    { fetch: intel.fetch },
  );
  assert.equal(evaluated.approved, false);
  assert.equal(evaluated.reason, ASSET_MALFORMED);
  assert.deepEqual(intel.calls, []);
});
