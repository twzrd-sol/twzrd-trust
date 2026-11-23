/**
 * wrapFetchWithTwzrdGate contract test: the 402 gate must block BEFORE the caller pays.
 * Run: npx tsx test/wrap-fetch.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";

// injected preflight fetch (config.fetch) returns a ReadinessCard
const preflightFetch = (card: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ readiness_card: card, wash_flagged: false, confidence: "full" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

// the merchant call (innerFetch) returns a real x402 402 with accepts[].payTo
const merchant402: typeof fetch = (async () =>
  new Response(
    JSON.stringify({
      x402Version: 1,
      accepts: [{ payTo: "MERCHANT_WALLET", maxAmountRequired: "3000", resource: "https://merchant/paid" }],
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

async function run() {
  // 1. BLOCK decision -> gate throws before the caller can attach payment
  {
    const cfg = resolveConfig({ fetch: preflightFetch({ decision: "block", trust_score: 10 }) });
    const gated = wrapFetchWithTwzrdGate(merchant402, cfg);
    await assert.rejects(() => gated("https://merchant/paid"), /payment blocked: twzrd_decision_block/);
  }

  // 2. ALLOW -> returns the ORIGINAL 402 so the x402 client pays + retries
  {
    const cfg = resolveConfig({ fetch: preflightFetch({ decision: "allow", trust_score: 90, can_spend: true }) });
    const gated = wrapFetchWithTwzrdGate(merchant402, cfg);
    const resp = await gated("https://merchant/paid");
    assert.equal(resp.status, 402, "approved 402 is returned untouched for the caller to pay");
  }

  // Intel's maximum cap applies to the quote wrapper too, including warn cards.
  {
    const cfg = resolveConfig({ fetch: preflightFetch({ decision: "warn", can_spend: false, trust_score: 45, recommended_cap_usdc: 0.01, maximum_recommended_spend_usdc: 0.001 }) });
    const quote: typeof fetch = (async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{ payTo: "MERCHANT_WALLET", amount: "3000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", network: "solana:mainnet" }] }), { status: 402 })) as typeof fetch;
    await assert.rejects(() => wrapFetchWithTwzrdGate(quote, cfg)("https://merchant/paid"), /intel_recommended_cap_exceeded/);
  }

  // 3. non-402 passes through; preflight is never called
  {
    let preflightCalled = false;
    const cfg = resolveConfig({
      fetch: (async () => {
        preflightCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const ok: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const resp = await wrapFetchWithTwzrdGate(ok, cfg)("https://merchant/free");
    assert.equal(resp.status, 200);
    assert.equal(preflightCalled, false, "200 responses must not trigger preflight");
  }

  // 4. 402 with an unparseable body -> nothing to gate on, pass through
  {
    const cfg = resolveConfig({ fetch: preflightFetch({ decision: "block" }) });
    const bad402: typeof fetch = (async () => new Response("not json", { status: 402 })) as unknown as typeof fetch;
    const resp = await wrapFetchWithTwzrdGate(bad402, cfg)("https://merchant/paid");
    assert.equal(resp.status, 402);
  }

  // 5. fail-open: preflight unreachable -> allow (returns the 402)
  {
    const cfg = resolveConfig({
      failOpen: true,
      fetch: (async () => {
        throw new Error("preflight down");
      }) as unknown as typeof fetch,
    });
    const resp = await wrapFetchWithTwzrdGate(merchant402, cfg)("https://merchant/paid");
    assert.equal(resp.status, 402, "fail-open must not hard-block the payment path");
  }

  console.log("wrap-fetch.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("wrap-fetch.test.ts FAILED:", e);
  process.exit(1);
});
