/**
 * requireOfferBinding against an offer that sets its own `extra.memo`.
 *
 * When a Solana exact offer carries `extra.memo`, the x402 facilitator settles
 * only a transaction with exactly one Memo instruction whose text is that
 * memo. A bound transaction must carry the bind memo, so it cannot settle: two
 * memos fail the count, and the bind memo alone fails the match. The gate
 * refuses before it asks for a transaction, and nothing is signed.
 *
 * Run: npx tsx --test test/bind-seller-memo.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BIND_SELLER_MEMO_CONFLICT, offerSetsSellerMemo, twzrd } from "../src/spend-control.js";
import { isFatalGateRefusal } from "../src/binding-plane.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const URL_ = "https://merchant.example/paid";
const offer = (over: Record<string, unknown> = {}) => ({
  scheme: "exact", network: "solana", payTo: SELLER, amount: "10000", asset: USDC, resource: URL_, ...over,
});
const fetch402 = (o: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ x402Version: 1, accepts: [o] }), {
    status: 402, headers: { "content-type": "application/json" },
  })) as typeof fetch;

test("offerSetsSellerMemo reads extra.memo the way the facilitator does", () => {
  assert.equal(offerSetsSellerMemo(offer({ extra: { memo: "order-123" } })), true);
  // The facilitator tests the value for truthiness, whatever its type.
  assert.equal(offerSetsSellerMemo(offer({ extra: { memo: 7 } })), true);
  assert.equal(offerSetsSellerMemo(offer({ extra: { memo: ["x"] } })), true);
  assert.equal(offerSetsSellerMemo(offer({ extra: { memo: "" } })), false);
  assert.equal(offerSetsSellerMemo(offer({ extra: { memo: null } })), false);
  assert.equal(offerSetsSellerMemo(offer({ extra: {} })), false);
  assert.equal(offerSetsSellerMemo(offer()), false);
  assert.equal(offerSetsSellerMemo(offer({ extra: "memo" })), false);
  assert.equal(offerSetsSellerMemo(null), false);
});

test("a bound payment to an offer with its own memo is refused before compose and before pay", async () => {
  let composed = 0;
  let paid = 0;
  const args = {
    requireOfferBinding: true,
    composeBoundTransaction: async () => { composed += 1; return { transactionBase64: "AA==" }; },
    pay: async () => { paid += 1; return { response: new Response("paid") }; },
  };
  const blocked = await twzrd.safeFetch(URL_, { ...args, fetch: fetch402(offer({ extra: { memo: "order-123" } })) });
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.reason, BIND_SELLER_MEMO_CONFLICT);
  assert.equal(blocked.reason, "bind_seller_memo_conflict");
  assert.equal(blocked.signerInvocations, 0);
  assert.equal(blocked.receipt?.strength, "refuse");
  assert.equal(composed, 0, "no transaction was asked for");
  assert.equal(paid, 0);
  // An incompatible offer, not a hostile one: it never writes .pause.
  assert.equal(isFatalGateRefusal(BIND_SELLER_MEMO_CONFLICT), false);

  // Without a seller memo the same call goes on to compose (and fails there on the stub bytes).
  const control = await twzrd.safeFetch(URL_, { ...args, fetch: fetch402(offer({ extra: { feePayer: SELLER } })) });
  assert.equal(composed, 1, "compose was reached");
  assert.notEqual(control.reason, BIND_SELLER_MEMO_CONFLICT);
  assert.equal(paid, 0);
});

test("without requireOfferBinding an offer with its own memo is not refused for it", async () => {
  let paid = 0;
  const r = await twzrd.safeFetch(URL_, {
    fetch: fetch402(offer({ extra: { memo: "order-123" } })),
    pay: async () => { paid += 1; return { response: new Response("paid") }; },
  });
  assert.notEqual(r.reason, BIND_SELLER_MEMO_CONFLICT);
  assert.equal(paid, 1);
});
