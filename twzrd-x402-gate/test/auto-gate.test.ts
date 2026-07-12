/**
 * installTwzrdAutoGate contract test — no real network / no real spend.
 * Run: npx tsx test/auto-gate.test.ts
 *
 * Locks the default-on composition: guard the RAW fetch, THEN hand it to the
 * caller's payWrap. Proves a blocked seller never reaches payWrap's "sign" step,
 * and that TWZRD_AUTO_GATE=0 / disabled:true bypasses the guard entirely.
 */
import assert from "node:assert/strict";

import { installTwzrdAutoGate } from "../src/auto-gate.js";

const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const URL_ = "https://merchant.example/paid";

function merchant402(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        accepts: [{ network: "solana", payTo: SELLER, maxAmountRequired: "50000", resource: URL_ }],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function preflightFetch(card: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Stand-in for an x402 client (agentcash/ClawRouter/@x402/svm): "signs" and returns 200. */
function fakePayClient() {
  let signed = 0;
  const wrap = (guarded: typeof fetch): typeof fetch =>
    (async (input: unknown, init?: unknown) => {
      const resp = await guarded(input as any, init as any);
      if (resp.status !== 402) return resp;
      signed += 1; // would sign USDC here
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  return { wrap, signedCount: () => signed };
}

async function run() {
  // 1. decision=block -> payWrap's client never signs (throws before "payment").
  {
    const client = fakePayClient();
    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: merchant402(),
      fetch: preflightFetch({ decision: "block", trust_score: 5 }),
    });
    await assert.rejects(
      () => payingFetch(URL_),
      /payment blocked/,
      "blocked seller throws before the pay client signs",
    );
    assert.equal(client.signedCount(), 0, "pay client never invoked its sign path");
  }

  // 2. decision=allow -> guard passes the 402 through, pay client signs.
  {
    const client = fakePayClient();
    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: merchant402(),
      fetch: preflightFetch({ decision: "allow", trust_score: 90 }),
    });
    const resp = await payingFetch(URL_);
    assert.equal(resp.status, 200, "allow -> pay client's 200 returned");
    assert.equal(client.signedCount(), 1, "pay client signed exactly once");
  }

  // 3. disabled:true -> raw fetch handed straight to payWrap, no guard call at all.
  {
    const client = fakePayClient();
    let guardHit = false;
    const raw = (async () => {
      guardHit = true;
      return new Response(
        JSON.stringify({ accepts: [{ network: "solana", payTo: SELLER, maxAmountRequired: "50000" }] }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const payingFetch = installTwzrdAutoGate(client.wrap, { rawFetch: raw, disabled: true });
    const resp = await payingFetch(URL_);
    assert.equal(guardHit, true, "raw fetch still invoked");
    assert.equal(resp.status, 200, "disabled -> pay client signs regardless of seller");
    assert.equal(client.signedCount(), 1);
  }

  // 3b. malformed 402 (accepts:[] -> no extractable payTo) fails closed -> zero
  // signer invocations, even though the preflight fetch would return an ALLOW if
  // it were ever called (it must not be called at all).
  {
    const client = fakePayClient();
    let preflightHit = false;
    const spyPreflight: typeof fetch = (async () => {
      preflightHit = true;
      return new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const malformed402: typeof fetch = (async () =>
      new Response(JSON.stringify({ accepts: [] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: malformed402,
      fetch: spyPreflight,
    });
    await assert.rejects(
      () => payingFetch(URL_),
      /twzrd_unidentifiable_payment_recipient/,
      "malformed 402 with no extractable payTo throws instead of falling through to a generic unknown-seller warn",
    );
    assert.equal(client.signedCount(), 0, "pay client never signs on a malformed 402");
    assert.equal(preflightHit, false, "the free preflight is never called for an unidentifiable recipient");
  }

  // 4. TWZRD_AUTO_GATE=0 env -> same bypass as disabled:true, no options override needed.
  {
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      const client = fakePayClient();
      const payingFetch = installTwzrdAutoGate(client.wrap, {
        rawFetch: merchant402(),
        fetch: preflightFetch({ decision: "block", trust_score: 5 }),
      });
      const resp = await payingFetch(URL_);
      assert.equal(resp.status, 200, "TWZRD_AUTO_GATE=0 bypasses even a block verdict");
      assert.equal(client.signedCount(), 1);
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
  }

  console.log("auto-gate.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("auto-gate.test.ts FAILED:", e);
  process.exit(1);
});
