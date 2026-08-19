/**
 * quick-tier ($0.001) contract test — no real network / no real x402 spend.
 * Run: npx tsx test/quick.test.ts
 *
 * Locks the cheap qualify rung: quickCheck settles $0.001 to GET /v1/intel/quick/
 * {seller} via the caller's x402Fetch and parses tier+score. Fail-soft: never
 * throws (it's enrichment, not the gate).
 */
import assert from "node:assert/strict";

import { quickCheck, QUICK_PRICE_USDC } from "../src/quick.js";
import { CLIENT_VERSION } from "../src/version.js";

const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function x402Mock(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fn = (async (url: string | URL, init?: { headers?: RequestInit["headers"] }) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { calls: typeof calls };
  (fn as { calls: typeof calls }).calls = calls;
  return fn as typeof fetch & { calls: typeof calls };
}

async function run() {
  assert.equal(QUICK_PRICE_USDC, 0.001, "quick price is $0.001");

  // 1. happy path: x402Fetch settles -> tier+score parsed, hits the quick endpoint.
  {
    const x402 = x402Mock({
      pubkey: SELLER, tier: "Gold", score: 120, payments: 7,
      last_seen: "2026-06-26T00:00:00Z", paid: true, charged_amount_usdc: 0.001,
    });
    const r = await quickCheck(SELLER, { x402Fetch: x402 });
    assert.equal(x402.calls.length, 1, "one paid quick call");
    assert.match(x402.calls[0].url, /\/v1\/intel\/quick\//, "hits the quick endpoint, not trust");
    assert.match(x402.calls[0].url, new RegExp(SELLER), "targets the seller wallet");
    assert.equal(r.available, true);
    assert.equal(r.tier, "Gold");
    assert.equal(r.score, 120);
    assert.equal(r.payments, 7);
    assert.equal(r.lastSeen, "2026-06-26T00:00:00Z");
    assert.equal(r.paid, true);
    assert.equal(r.chargedUsdc, 0.001);
    // caller_id gap fix: this call previously sent {accept} only.
    assert.equal(
      x402.calls[0].headers.get("x-twzrd-client"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "quick-tier call must stamp X-TWZRD-Client (previously unstamped)",
    );
    assert.equal(
      x402.calls[0].headers.get("x-twzrd-caller"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "quick-tier call must stamp X-Twzrd-Caller (previously unstamped)",
    );
  }

  // 1b. attribution configured -> narrows X-Twzrd-Caller, same as preflight/trust.
  {
    const x402 = x402Mock({ tier: "Silver", score: 55 });
    await quickCheck(SELLER, {
      x402Fetch: x402,
      attribution: { integration: "payai-x402-solana-pr38", runId: "run-quick-1" },
    });
    assert.equal(
      x402.calls[0].headers.get("x-twzrd-caller"),
      `payai-x402-solana-pr38@${CLIENT_VERSION}`,
      "quick-tier call narrows X-Twzrd-Caller when attribution is configured",
    );
  }

  // 2. no x402Fetch -> available=false (quick tier needs a paying fetch); never throws.
  {
    const r = await quickCheck(SELLER, {});
    assert.equal(r.available, false);
    assert.equal(r.paid, false);
    assert.match(r.reason, /no x402Fetch/);
  }

  // 3. non-200 (e.g. the x402Fetch failed to settle, server still 402) -> fail-soft.
  {
    const x402 = x402Mock({ error: "payment_required" }, 402);
    const r = await quickCheck(SELLER, { x402Fetch: x402 });
    assert.equal(r.available, false);
    assert.match(r.reason, /quick HTTP 402/);
  }

  // 4. x402Fetch throws -> fail-soft (no throw, available=false).
  {
    const throwing = (async () => { throw new Error("settle blew up"); }) as unknown as typeof fetch;
    const r = await quickCheck(SELLER, { x402Fetch: throwing });
    assert.equal(r.available, false);
    assert.match(r.reason, /quick unreachable/);
  }

  // 5. empty seller -> available=false, no call attempted.
  {
    const x402 = x402Mock({ tier: "Gold", score: 120 });
    const r = await quickCheck("", { x402Fetch: x402 });
    assert.equal(r.available, false);
    assert.equal(x402.calls.length, 0, "no call without a seller");
  }

  console.log("quick.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("quick.test.ts FAILED:", e);
  process.exit(1);
});
