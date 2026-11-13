/**
 * The bind leaf is the leaf of the offer in the 402 being paid.
 *
 * A v1 402 body is remembered by URL so the leaf can use the seller's own
 * spelling when the client only shows the hook the CAIP form. That memory is
 * process-wide and outlives the response it came from, and stampResourceBind
 * preferred it over the 402 in hand. An earlier response (the same seller's, or
 * another seller naming this resource in its accepts[]) could so decide the
 * leaf of a later payment: the receipt came back `hard` for a leaf that was not
 * the current offer's.
 *
 * Run: npx tsx --test test/resource-bind-current-offer.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  rawInvoiceByResource, rememberRawInvoice, resourceBindLeafHash, stampResourceBind,
  wrapFetchRememberInvoice, type ResourceBindReq,
} from "../src/resource-bind.js";
import { twzrd } from "../src/spend-control.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const URL_PAID = "https://merchant.example/paid";

/** The offer the buyer is paying now: x402 v2, CAIP network, resource on the envelope. */
const CURRENT_ENTRY = { scheme: "exact", network: CAIP, payTo: SELLER, amount: "5000", asset: USDC };
const CURRENT_402 = { x402Version: 2, resource: { url: URL_PAID }, accepts: [CURRENT_ENTRY] };
const SELECTED: ResourceBindReq = { ...CURRENT_ENTRY, resource: URL_PAID };
const CURRENT_LEAF = resourceBindLeafHash(SELECTED);

/** A v1 body for the same payee, amount and asset. `over` is what differs. */
const v1Body = (over: Record<string, unknown>) => ({
  x402Version: 1,
  accepts: [{
    scheme: "exact", network: "solana", payTo: SELLER, maxAmountRequired: "5000",
    asset: USDC, resource: URL_PAID, ...over,
  }],
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => rawInvoiceByResource.clear());

test("an earlier 402 from the same URL does not decide the leaf of the current one", () => {
  // Request 1 was answered with an offer for another resource; it is remembered under the URL.
  rememberRawInvoice(v1Body({ resource: "https://merchant.example/elsewhere" }), URL_PAID);
  const stamped = stampResourceBind({ ...SELECTED }, CURRENT_402);
  assert.equal(stamped.strength, "soft");
  assert.equal(stamped.leaf_hash, CURRENT_LEAF);
});

test("another seller's 402 that names this resource does not decide the leaf", () => {
  // Remembered under accepts[].resource: any 402 can name any resource there.
  rememberRawInvoice(v1Body({ scheme: "upto" }), "https://other-seller.example/anything");
  assert.ok(rawInvoiceByResource.get(URL_PAID), "the foreign body is filed under this resource");
  assert.equal(stampResourceBind({ ...SELECTED }, CURRENT_402).leaf_hash, CURRENT_LEAF);
});

test("a remembered offer with another asset or amount is not used", () => {
  for (const over of [{ asset: undefined }, { maxAmountRequired: undefined, amount: undefined }]) {
    rawInvoiceByResource.clear();
    rememberRawInvoice(v1Body(over), URL_PAID);
    assert.equal(stampResourceBind({ ...SELECTED }, CURRENT_402).leaf_hash, CURRENT_LEAF, JSON.stringify(over));
  }
});

test("the seller's own v1 spelling of the same offer is still what the leaf hashes", () => {
  // One response, two forms: a v1 body ("solana") and a v2 header (CAIP). The
  // client shows the hook the header; the leaf keeps the body's spelling.
  const body = v1Body({});
  rememberRawInvoice(body, URL_PAID);
  const rawLeaf = resourceBindLeafHash({ ...body.accepts[0], amount: "5000" } as ResourceBindReq);
  assert.notEqual(rawLeaf, CURRENT_LEAF);
  assert.equal(stampResourceBind({ ...SELECTED }, CURRENT_402).leaf_hash, rawLeaf);
});

test("currentInvoiceOnly stamps from the 402 in hand and nothing else", () => {
  rememberRawInvoice(v1Body({}), URL_PAID);
  const stamped = stampResourceBind({ ...SELECTED }, CURRENT_402, undefined, { currentInvoiceOnly: true });
  assert.equal(stamped.leaf_hash, CURRENT_LEAF);
});

test("a 402 with no v1 body forgets what an earlier response from that URL left", async () => {
  const answers = [json(v1Body({}), 402), json(CURRENT_402, 402)];
  const wrapped = wrapFetchRememberInvoice((async () => answers.shift()!) as unknown as typeof fetch);
  await wrapped(URL_PAID);
  assert.ok(rawInvoiceByResource.get(URL_PAID));
  await wrapped(URL_PAID);
  assert.equal(rawInvoiceByResource.get(URL_PAID), undefined);
});

test("safeFetch binds the second request to the second 402, not to the first", async () => {
  const answers = [v1Body({ resource: "https://merchant.example/elsewhere" }), CURRENT_402];
  const merchant = (async () => json(answers.shift(), 402)) as unknown as typeof fetch;
  const leaves: string[] = [];
  const options = {
    fetch: merchant,
    requireOfferBinding: true,
    // Unsigned bytes that bind nothing: the call ends in bind_mismatch, after
    // the gate has said which leaf the transaction had to carry.
    composeBoundTransaction: async ({ leafHash }: { leafHash: string }) => {
      leaves.push(leafHash);
      return { transactionBase64: Buffer.from("not-a-tx").toString("base64") };
    },
    pay: async () => { throw new Error("an unbound transaction is never paid"); },
  };
  const first = await twzrd.safeFetch(URL_PAID, options);
  const second = await twzrd.safeFetch(URL_PAID, options);
  assert.equal(first.reason, "bind_mismatch");
  assert.equal(second.reason, "bind_mismatch");
  assert.equal(leaves.length, 2);
  assert.equal(leaves[1], CURRENT_LEAF, "the leaf handed to the composer is the current offer's");
  assert.equal(second.receipt?.leaf_hash ?? leaves[1], CURRENT_LEAF);
});
