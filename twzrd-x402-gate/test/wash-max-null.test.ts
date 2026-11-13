/**
 * washMaxUsdc: null is a decision, not a missing value.
 *
 * - null: no soft cap. wash_flagged always refuses and TWZRD_WASH_MAX_USDC is
 *   not read. Before 0.21.0 null fell back to the env variable, so a value set
 *   on the host could pay a wash-flagged seller under a config that said wash
 *   refuses.
 * - left out (undefined): TWZRD_WASH_MAX_USDC still applies, as before.
 * - a number: that cap, whatever the env says.
 *
 * Checked on both resolvers (resolveConfig, and the wash-default path's own)
 * and on the seats that resolve twice (withTwzrdGuard hands its resolved
 * config to evaluate_x402_resource, which resolves again).
 *
 * Run: npx tsx --test test/wash-max-null.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { createTwzrdGate } from "../src/gate.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { createTwzrdWashBeforePaymentHook, evaluateWashOnlyBeforePayment } from "../src/wash-default.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const PAID_URL = "https://merchant.example/paid";

const ALLOW = { decision: "allow", trust_score: 80, can_spend: true };
const FLAGGED = { wash_flagged: true, wash_confidence: "full" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Intel stub: an evaluated allow whose merchant card is wash-flagged. */
const flaggedIntel = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/v1/intel/preflight")) return jsonResponse({ readiness_card: ALLOW });
  if (url.includes("/v1/intel/merchant_card/")) return jsonResponse(FLAGGED);
  throw new Error(`unexpected intel url ${url}`);
}) as unknown as typeof fetch;

/** 0.01 USDC. */
const REQS = {
  payTo: SELLER,
  maxAmountRequired: "10000",
  resource: PAID_URL,
  network: "solana",
  asset: USDC,
} as X402PaymentRequirements;
const resource402 = (async () =>
  jsonResponse({ x402Version: 1, error: "payment_required", accepts: [{ ...REQS, scheme: "exact" }] }, 402)) as unknown as typeof fetch;
const hookReq = { payTo: SELLER, network: SOL, amount: "10000", asset: USDC, resource: PAID_URL };

async function withWashEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.TWZRD_WASH_MAX_USDC;
  if (value === undefined) delete process.env.TWZRD_WASH_MAX_USDC;
  else process.env.TWZRD_WASH_MAX_USDC = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TWZRD_WASH_MAX_USDC;
    else process.env.TWZRD_WASH_MAX_USDC = prev;
  }
}

const aborted = (r: { abort?: boolean } | void | undefined) => Boolean(r && r.abort === true);
const reasonOf = (r: { reason?: string } | void | undefined) => String(r?.reason ?? "");

test("resolveConfig: null ignores the env, undefined reads it, a number beats it", async () => {
  await withWashEnv("1000", () => {
    assert.equal(resolveConfig({ washMaxUsdc: null }).washMaxUsdc, null, "explicit null: env not read");
    assert.equal(resolveConfig({}).washMaxUsdc, 1000, "left out: env applies");
    assert.equal(resolveConfig({ washMaxUsdc: undefined }).washMaxUsdc, 1000, "undefined is left out");
    assert.equal(resolveConfig().washMaxUsdc, 1000);
    assert.equal(resolveConfig({ washMaxUsdc: 0.02 }).washMaxUsdc, 0.02, "an option beats the env");
    assert.equal(resolveConfig({ washMaxUsdc: 0 }).washMaxUsdc, 0, "zero is a cap, not a missing value");
  });
  await withWashEnv(undefined, () => {
    assert.equal(resolveConfig({ washMaxUsdc: null }).washMaxUsdc, null);
    assert.equal(resolveConfig({}).washMaxUsdc, null, "neither set: hard refuse");
  });
  // A value that is not a usable cap does not turn the env off; only null does.
  await withWashEnv("1000", () => {
    assert.equal(resolveConfig({ washMaxUsdc: Number.NaN }).washMaxUsdc, 1000);
  });
});

test("full-config seats: null refuses a wash-flagged seller the env would pay", async () => {
  const ctx = { payTo: SELLER, chain: SOL, priceUsdc: 0.01, asset: USDC };
  await withWashEnv("1000", async () => {
    // Left out: the env soft cap pays it. This is the behaviour null turns off.
    const viaEnv = await createTwzrdGate({ fetch: flaggedIntel }).approvePayment(ctx);
    assert.equal(viaEnv.approved, true);
    assert.match(viaEnv.reason, /twzrd_wash_capped_0\.01_le_1000/);
    const evalViaEnv = await evaluate_x402_resource(PAID_URL, REQS, { fetch: flaggedIntel });
    assert.equal(evalViaEnv.approved, true, evalViaEnv.reason);
    const guardViaEnv = await withTwzrdGuard(resource402, { fetch: flaggedIntel })(PAID_URL);
    assert.equal(guardViaEnv.status, 402, "handed back for the payer");

    // null: refused on each seat.
    const gate = await createTwzrdGate({ washMaxUsdc: null, fetch: flaggedIntel }).approvePayment(ctx);
    assert.equal(gate.approved, false);
    assert.equal(gate.reason, "twzrd_wash_flagged");

    const hook = await createTwzrdBeforePaymentHook({ washMaxUsdc: null, fetch: flaggedIntel })(hookReq);
    assert.equal(aborted(hook), true);
    assert.match(reasonOf(hook), /twzrd_wash_flagged/);

    const evaluated = await evaluate_x402_resource(PAID_URL, REQS, { washMaxUsdc: null, fetch: flaggedIntel });
    assert.equal(evaluated.approved, false);
    assert.equal(evaluated.reason, "twzrd_wash_flagged");

    await assert.rejects(
      () => withTwzrdGuard(resource402, { washMaxUsdc: null, fetch: flaggedIntel })(PAID_URL),
      /twzrd_wash_flagged/,
      "the null survives withTwzrdGuard's second resolve",
    );

    // A number still caps, and beats a looser env.
    const tight = await evaluate_x402_resource(PAID_URL, REQS, { washMaxUsdc: 0.005, fetch: flaggedIntel });
    assert.equal(tight.approved, false, "0.01 is over a 0.005 cap");
    const loose = await evaluate_x402_resource(PAID_URL, REQS, { washMaxUsdc: 0.05, fetch: flaggedIntel });
    assert.equal(loose.approved, true, loose.reason);
  });
});

test("withTwzrdGuard reads the wash cap once, when it is built", async () => {
  // Built with no cap anywhere: a later TWZRD_WASH_MAX_USDC does not soften the
  // guard, the same as its other settings (it used to re-read this one per call).
  const guard = await withWashEnv(undefined, () => withTwzrdGuard(resource402, { fetch: flaggedIntel }));
  await withWashEnv("1000", async () => {
    await assert.rejects(() => guard(PAID_URL), /twzrd_wash_flagged/);
  });
  // Built with the env cap set: it keeps paying under it after the env is gone.
  const capped = await withWashEnv("1000", () => withTwzrdGuard(resource402, { fetch: flaggedIntel }));
  await withWashEnv(undefined, async () => {
    const resp = await capped(PAID_URL);
    assert.equal(resp.status, 402);
  });
});

test("wash-default path: the same three cases", async () => {
  const cardOnly = (async () => jsonResponse(FLAGGED)) as unknown as typeof fetch;
  const selected = { payTo: SELLER, amount: "10000" };
  await withWashEnv("1000", async () => {
    const viaEnv = await evaluateWashOnlyBeforePayment(selected, { fetch: cardOnly });
    assert.equal(viaEnv, undefined, "left out: the env soft cap pays");

    const hard = await evaluateWashOnlyBeforePayment(selected, { washMaxUsdc: null, fetch: cardOnly });
    assert.equal(aborted(hard), true);
    assert.match(reasonOf(hard), /twzrd_wash_flagged/);

    const hookHard = await createTwzrdWashBeforePaymentHook({ washMaxUsdc: null, fetch: cardOnly })(selected);
    assert.equal(aborted(hookHard), true);
    assert.match(reasonOf(hookHard), /twzrd_wash_flagged/);

    const tight = await evaluateWashOnlyBeforePayment(selected, { washMaxUsdc: 0.005, fetch: cardOnly });
    assert.equal(aborted(tight), true, "a number beats a looser env");
  });
  await withWashEnv(undefined, async () => {
    const plain = await evaluateWashOnlyBeforePayment(selected, { fetch: cardOnly });
    assert.equal(aborted(plain), true, "neither set: hard refuse, as before");
  });
});
