/**
 * 0.13.0 default refusals, through the shipped before-payment hook (an abort is
 * a refusal before the signer) and twzrdApprovePayment.
 *
 * - An evaluated warn is paid only under the card's finite recommended_cap_usdc,
 *   at a known price (twzrd_warn_no_cap, twzrd_warn_unknown_price). Opt out:
 *   refuseUncappedWarn:false or TWZRD_REFUSE_UNCAPPED_WARN=0|false.
 *
 * Run: npx tsx test/release-0130.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const CLEAN_CARD = { wash_flagged: false, wash_confidence: "full" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function intel(readiness: Record<string, unknown>, merchant: Record<string, unknown> = CLEAN_CARD): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/preflight")) return jsonResponse({ readiness_card: readiness });
    if (url.includes("/v1/intel/merchant_card/")) return jsonResponse(merchant);
    throw new Error(`unexpected intel url ${url}`);
  }) as unknown as typeof fetch;
}

const req = (amount: string) => ({
  payTo: SELLER,
  network: SOL,
  amount,
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  resource: "https://merchant.example/paid",
});

function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[name];
  process.env[name] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

async function warnCap() {
  const warn = { decision: "warn", trust_score: 50, can_spend: true };
  const capped = { ...warn, recommended_cap_usdc: 0.01 };
  const hook = (card: Record<string, unknown>, extra = {}) =>
    createTwzrdBeforePaymentHook({ fetch: intel(card), ...extra });

  assert.equal(resolveConfig({}).refuseUncappedWarn, true, "default on in 0.13.0");

  const noCap = await hook(warn)(req("10000"));
  assert.ok(noCap && noCap.abort === true, "uncapped warn aborts before the signer");
  assert.match(String(noCap.reason), /twzrd_warn_no_cap/);

  const within = await hook(capped)(req("10000"));
  assert.ok(!within || within.abort !== true, `warn at its cap pays: ${within?.reason}`);

  const over = await hook(capped)(req("20000"));
  assert.ok(over && over.abort === true, "warn over its cap still aborts");
  assert.match(String(over.reason), /twzrd_over_recommended_cap_0\.02_gt_0\.01/);

  const optOut = await hook(warn, { refuseUncappedWarn: false })(req("10000"));
  assert.ok(!optOut || optOut.abort !== true, `refuseUncappedWarn:false pays an uncapped warn: ${optOut?.reason}`);

  for (const off of ["0", "false", "OFF"]) {
    await withEnv("TWZRD_REFUSE_UNCAPPED_WARN", off, async () => {
      assert.equal(resolveConfig({}).refuseUncappedWarn, false, `env ${off} turns it off`);
      const viaEnv = await hook(warn)(req("10000"));
      assert.ok(!viaEnv || viaEnv.abort !== true, `env ${off} pays an uncapped warn`);
    });
  }
  await withEnv("TWZRD_REFUSE_UNCAPPED_WARN", "flase", async () => {
    assert.equal(resolveConfig({}).refuseUncappedWarn, true, "a typo leaves the refusal on");
  });
  await withEnv("TWZRD_REFUSE_UNCAPPED_WARN", "0", async () => {
    assert.equal(resolveConfig({ refuseUncappedWarn: true }).refuseUncappedWarn, true, "an explicit option wins over env");
  });

  // No price: the cap cannot be checked.
  const unpriced = await twzrdApprovePayment({ payTo: SELLER, chain: SOL }, resolveConfig({ fetch: intel(capped) }));
  assert.equal(unpriced.approved, false);
  assert.equal(unpriced.reason, "twzrd_warn_unknown_price");
  assert.equal(unpriced.verdict, "block");

  // allow is not a warn: no cap or price needed.
  const allow = await twzrdApprovePayment(
    { payTo: SELLER, chain: SOL },
    resolveConfig({ fetch: intel({ decision: "allow", trust_score: 80, can_spend: true }) }),
  );
  assert.equal(allow.approved, true, allow.reason);
  console.log("ok  evaluated warn needs a finite cap and a known price; opt-out by option and env");
}

async function run() {
  await warnCap();
  console.log("release-0130.test.ts: ALL PASSED");
}

run().catch((err) => {
  console.error("release-0130.test.ts FAILED:", err);
  process.exit(1);
});
