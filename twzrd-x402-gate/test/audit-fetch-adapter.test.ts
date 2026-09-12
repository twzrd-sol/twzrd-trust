/**
 * AUDIT: fetch-adapter gate vs x402 v2 PAYMENT-REQUIRED header.
 *
 * @x402/fetch (verified in node_modules/@x402/core: x402HTTPClient.
 * getPaymentRequiredResponse) pays from the base64 `PAYMENT-REQUIRED` header
 * FIRST and only falls back to an x402Version:1 JSON body. The fetch adapter
 * (withTwzrdGuard / wrapFetchWithTwzrdGate / installTwzrdAutoGate(payWrap))
 * read ONLY the body, so a v2 seller whose challenge lives in the header:
 *   - empty / non-JSON body  -> "nothing to gate on", 402 handed to payer -> SIGNS
 *   - decoy JSON body        -> gate scores the decoy payTo, payer pays the header payTo
 * Offline, deterministic, no network. Run: npx tsx test/audit-fetch-adapter.test.ts
 */
import assert from "node:assert/strict";

import { installTwzrdAutoGate } from "../src/auto-gate.js";
import { resolveConfig } from "../src/config.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";
import { twzrd } from "../src/spend-control.js";

const BAD = "7G73PLwash1111111111111111111111111111111111";
const GOOD = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const URL_ = "https://merchant.example/paid";

const v2Challenge = (payTo: string) => ({
  x402Version: 2,
  resource: { url: URL_ },
  accepts: [{ scheme: "exact", network: SOL, payTo, amount: "50000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }],
});
const headerFor = (payTo: string) =>
  Buffer.from(JSON.stringify(v2Challenge(payTo)), "utf8").toString("base64");

/** Raw fetch: 402 with the v2 header and an arbitrary body. */
const raw402 = (payTo: string, body: string | null): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": headerFor(payTo), "content-type": "application/json" },
    })) as unknown as typeof fetch;

/** Preflight mock keyed on the seller the gate actually asked about. */
const intel = (seen: string[]): typeof fetch =>
  (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes("/merchant_card/")) return new Response("{}", { status: 404 });
    const seller = String(JSON.parse(String(init?.body ?? "{}")).seller_wallet ?? "");
    seen.push(seller);
    const card = seller === BAD ? { decision: "block", trust_score: 5 } : { decision: "allow", trust_score: 90 };
    return new Response(JSON.stringify({ readiness_card: card }), { status: 200 });
  }) as unknown as typeof fetch;

/** Stand-in for @x402/fetch: reads the HEADER, signs, returns 200. */
function payClient() {
  let signed = 0;
  let paidTo = "";
  const wrap = (guarded: typeof fetch): typeof fetch =>
    (async (input: unknown, init?: unknown) => {
      const resp = await guarded(input as never, init as never);
      if (resp.status !== 402) return resp;
      const h = resp.headers.get("PAYMENT-REQUIRED");
      if (!h) throw new Error("payer: no header, would parse v1 body");
      paidTo = JSON.parse(Buffer.from(h, "base64").toString("utf8")).accepts[0].payTo;
      signed += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  return { wrap, signed: () => signed, paidTo: () => paidTo };
}

async function run() {
  // 1. Header challenge + EMPTY body: block seller must never reach the payer.
  {
    const c = payClient();
    const seen: string[] = [];
    const paying = installTwzrdAutoGate(c.wrap, { rawFetch: raw402(BAD, null), fetch: intel(seen) });
    await assert.rejects(() => paying(URL_), /blocked/i, "header-only 402 must be gated");
    assert.equal(c.signed(), 0, "signer invoked on a header-only 402 the gate never scored");
    assert.deepEqual(seen, [BAD], "gate must score the header payTo");
  }

  // 2. Decoy body: body names GOOD (v1 shape), header names BAD. Payer pays header.
  {
    const c = payClient();
    const seen: string[] = [];
    const decoy = JSON.stringify({ x402Version: 1, accepts: [{ network: "solana", payTo: GOOD, maxAmountRequired: "50000", resource: URL_ }] });
    const paying = installTwzrdAutoGate(c.wrap, { rawFetch: raw402(BAD, decoy), fetch: intel(seen) });
    await assert.rejects(() => paying(URL_), /blocked/i, "decoy body must not launder the header payTo");
    assert.equal(c.signed(), 0, `signed to ${c.paidTo()} after scoring ${seen.join(",")}`);
    assert.ok(seen.includes(BAD), "gate scored the decoy, not the payee");
  }

  // 3. Same bypass through the lower-level wrapFetchWithTwzrdGate.
  {
    const seen: string[] = [];
    const cfg = resolveConfig({ fetch: intel(seen) });
    await assert.rejects(() => wrapFetchWithTwzrdGate(raw402(BAD, ""), cfg)(URL_), /blocked/i);
    assert.deepEqual(seen, [BAD]);
  }

  // 4. Positive control: header challenge for a clean seller is scored and approved
  //    (not false-blocked as twzrd_unidentifiable_payment_recipient on a `{}` body).
  {
    const c = payClient();
    const seen: string[] = [];
    const paying = installTwzrdAutoGate(c.wrap, { rawFetch: raw402(GOOD, "{}"), fetch: intel(seen) });
    const resp = await paying(URL_);
    assert.equal(resp.status, 200);
    assert.equal(c.signed(), 1);
    assert.equal(c.paidTo(), GOOD);
    assert.deepEqual(seen, [GOOD]);
  }

  // 5. twzrd.safeFetch: header-only v2 challenge must be evaluated, not `unparseable_402`.
  {
    let signs = 0;
    const r = await twzrd.safeFetch(URL_, {
      fetch: raw402(GOOD, ""), maxSpend: "0.01", allowNetworks: ["solana"],
      pay: async () => { signs += 1; return { response: new Response("ok", { status: 200 }) }; },
    });
    assert.equal(r.verdict, "block");
    assert.equal(r.reason, "over_max_spend", "header challenge ($0.05) must hit the cap, not parse failure");
    assert.equal(signs, 0);
  }

  console.log("audit-fetch-adapter.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("audit-fetch-adapter.test.ts FAILED:", e);
  process.exit(1);
});
