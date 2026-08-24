import assert from "node:assert/strict";
import {
  canonicalResourceUrl, evaluateResourceBind, resourceBindLeafHash,
  stampResourceBind, ZERO_BODY_HASH, type ResourceBindReq,
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
assert.equal(req.extra?.twzrd_resource_bind, stamped.leaf_hash);
assert.equal(stampResourceBind({ payTo: base.payTo }).strength, "refuse");
assert.equal(evaluateResourceBind({ leaf_hash: "ab", tx_contains_hash: true }).strength, "hard");
assert.equal(evaluateResourceBind({ leaf_hash: "ab", body_hash: "ff".repeat(32) }).strength, "refuse");
assert.equal(ZERO_BODY_HASH.length, 64);
console.log("resource-bind.test.ts: ALL PASSED");
