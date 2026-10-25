/**
 * 0.13.0 default refusals, through the shipped before-payment hook (an abort is
 * a refusal before the signer) and twzrdApprovePayment.
 *
 * - An evaluated warn is paid only under the card's finite recommended_cap_usdc,
 *   at a known price (twzrd_warn_no_cap, twzrd_warn_unknown_price). Opt out:
 *   refuseUncappedWarn:false or TWZRD_REFUSE_UNCAPPED_WARN=0|false.
 * - refuseWashUnknown is on: a reachable merchant card without full, fresh,
 *   ring-evaluated coverage refuses with twzrd_wash_unknown, including a wallet
 *   intel has never seen. An unreachable card stays failOpen's. Opt out:
 *   refuseWashUnknown:false or TWZRD_REFUSE_WASH_UNKNOWN=0|false.
 * - A card with no wash_flagged boolean has not answered the wash question,
 *   even beside confidence full: twzrd_wash_unknown on both engines.
 *
 * Run: npx tsx test/release-0130.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { createTwzrdWashBeforePaymentHook } from "../src/wash-default.js";
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

async function washUnknown() {
  const allow = { decision: "allow", trust_score: 80, can_spend: true };
  const partial = { wash_flagged: false, wash_confidence: "partial_inbound_only" };
  // Live shape of a pubkey intel has never seen (2026-10-25): 200, no wash answer.
  const neverSeen = { wash_flagged: null, confidence: null, next_action: { decision: "insufficient_evidence" } };
  const hook = (merchant: Record<string, unknown>, extra = {}) =>
    createTwzrdBeforePaymentHook({ fetch: intel(allow, merchant), ...extra });

  assert.equal(resolveConfig({}).refuseWashUnknown, true, "default on in 0.13.0");

  for (const [name, card] of [["partial", partial], ["never seen", neverSeen]] as const) {
    const r = await hook(card)(req("10000"));
    assert.ok(r && r.abort === true, `${name} card aborts before the signer`);
    assert.match(String(r.reason), /twzrd_wash_unknown/);
  }
  const clean = await hook(CLEAN_CARD)(req("10000"));
  assert.ok(!clean || clean.abort !== true, `full coverage pays: ${clean?.reason}`);

  const optOut = await hook(partial, { refuseWashUnknown: false })(req("10000"));
  assert.ok(!optOut || optOut.abort !== true, `refuseWashUnknown:false pays: ${optOut?.reason}`);
  for (const off of ["0", "false"]) {
    await withEnv("TWZRD_REFUSE_WASH_UNKNOWN", off, async () => {
      const viaEnv = await hook(neverSeen)(req("10000"));
      assert.ok(!viaEnv || viaEnv.abort !== true, `env ${off} pays: ${viaEnv?.reason}`);
    });
  }
  await withEnv("TWZRD_REFUSE_WASH_UNKNOWN", "flase", async () => {
    assert.equal(resolveConfig({}).refuseWashUnknown, true, "a typo leaves the refusal on");
  });

  // An unreachable card is an outage, not unknown coverage.
  const down = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/preflight")) return jsonResponse({ readiness_card: allow });
    return jsonResponse({ error: "down" }, 503);
  }) as unknown as typeof fetch;
  const closed = await createTwzrdBeforePaymentHook({ fetch: down })(req("10000"));
  assert.ok(closed && closed.abort === true);
  assert.match(String(closed.reason), /twzrd_card_unreachable_fail_closed/);
  const open = await createTwzrdBeforePaymentHook({ fetch: down, failOpen: true })(req("10000"));
  assert.ok(!open || open.abort !== true, `failOpen still opens an outage: ${open?.reason}`);
  console.log("ok  unknown wash coverage refuses by default; opt-out by option and env; outage stays failOpen's");
}

async function washFlaggedNull() {
  const allow = { decision: "allow", trust_score: 80, can_spend: true };
  const fullNoAnswer = { wash_flagged: null, wash_confidence: "full" };
  const full = await createTwzrdBeforePaymentHook({ fetch: intel(allow, fullNoAnswer) })(req("10000"));
  assert.ok(full && full.abort === true, "full engine: confidence full without wash_flagged aborts");
  assert.match(String(full.reason), /twzrd_wash_unknown/);

  const wash = await createTwzrdWashBeforePaymentHook({ fetch: intel(allow, fullNoAnswer) })(req("10000"));
  assert.ok(wash && wash.abort === true, "wash engine agrees");
  assert.match(String(wash.reason), /twzrd_wash_unknown/);

  const optOut = await createTwzrdBeforePaymentHook({ fetch: intel(allow, fullNoAnswer), refuseWashUnknown: false })(req("10000"));
  assert.ok(!optOut || optOut.abort !== true, `refuseWashUnknown:false pays: ${optOut?.reason}`);
  console.log("ok  wash_flagged null is not coverage, on both engines");
}

async function run() {
  await warnCap();
  await washUnknown();
  await washFlaggedNull();
  console.log("release-0130.test.ts: ALL PASSED");
}

run().catch((err) => {
  console.error("release-0130.test.ts FAILED:", err);
  process.exit(1);
});
