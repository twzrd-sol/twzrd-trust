import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalResourceUrl, evaluateResourceBind, memoContainsResourceBind,
  RESOURCE_BIND_MEMO_PREFIX, resourceBindLeafHash, resourceBindMemo,
  rememberRawInvoice, rawInvoiceByResource, stampResourceBind, ZERO_BODY_HASH,
  type ResourceBindReq,
} from "../src/resource-bind.js";

const base = {
  payTo: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "1000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  resource: "https://merchant.example/paid?b=2&a=1#frag",
};
assert.equal(canonicalResourceUrl(base.resource), "https://merchant.example/paid?a=1&b=2");
assert.notEqual(resourceBindLeafHash(base), resourceBindLeafHash({ ...base, resource: "https://merchant.example/other" }));
const req: ResourceBindReq = { ...base };
const stamped = stampResourceBind(req);
assert.equal(stamped.strength, "soft");
assert.equal(stamped.extra_stamped, false);
assert.equal(req.extra?.twzrd_resource_bind, undefined);
assert.equal(req.extra?.memo, undefined);
assert.equal(stamped.strength, "soft");
const leaf = stamped.leaf_hash as string;
const tx_memo = resourceBindMemo(leaf); // modeled as UTF-8 of settled Memo IX, not extra.memo
assert.ok(memoContainsResourceBind(tx_memo, leaf));
assert.equal(evaluateResourceBind({ leaf_hash: leaf, tx_memo }).strength, "hard");
assert.ok(tx_memo.startsWith(RESOURCE_BIND_MEMO_PREFIX));
assert.ok(tx_memo.length <= 48);
// Memo CU ≈ 1320 + 358*bytes; 48 B ≈ 18.5k < ExactSvm 20_000 budget.
const kept: ResourceBindReq = { ...base, extra: { feePayer: "FP", memo: "seller-memo" } };
stampResourceBind(kept);
assert.equal(kept.extra?.memo, "seller-memo");
assert.equal(kept.extra?.feePayer, "FP");
assert.equal(stampResourceBind({ payTo: base.payTo }).strength, "refuse");
assert.equal(evaluateResourceBind({ leaf_hash: "ab", tx_contains_hash: true }).strength, "hard");
assert.equal(evaluateResourceBind({ leaf_hash: "ab", body_hash: "ff".repeat(32) }).strength, "refuse");
assert.equal(ZERO_BODY_HASH.length, 64);

const reader402 = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "reader-outbid-402.json"), "utf8",
));
const rawSol = (reader402.accepts as ResourceBindReq[]).find((a) => String(a.network).includes("solana"))!;
const rawLeaf = resourceBindLeafHash({ ...rawSol, resource: rawSol.resource, amount: rawSol.maxAmountRequired ?? rawSol.amount });
const normalized: ResourceBindReq = {
  ...rawSol,
  amount: rawSol.maxAmountRequired ?? rawSol.amount,
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  resource: rawSol.resource,
};
const stampedRaw = stampResourceBind({ ...normalized }, reader402);
assert.equal(stampedRaw.leaf_hash, rawLeaf);
assert.notEqual(stampedRaw.leaf_hash, resourceBindLeafHash(normalized));

// Official client passes PAYMENT-REQUIRED header (CAIP) as paymentRequired.
rawInvoiceByResource.clear();
rememberRawInvoice(reader402);
const headerV2 = { x402Version: 2, accepts: [{ ...normalized, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] };
const fromHeader = stampResourceBind({ ...normalized }, headerV2);
assert.equal(fromHeader.leaf_hash, rawLeaf);
console.log("resource-bind.test.ts: ALL PASSED");
