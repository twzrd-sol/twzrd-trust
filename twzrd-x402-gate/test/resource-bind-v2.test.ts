/** Bind-v2: payer commits to decision_id via a 47-byte rb2: memo. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECISION_ID_MAX_BYTES,
  RESOURCE_BIND_MEMO_MAX,
  RESOURCE_BIND_MEMO_PREFIX,
  RESOURCE_BIND_V2_MEMO_PREFIX,
  evaluateResourceBind,
  memoContainsResourceBind,
  pickBindMemo,
  resourceBindLeafHash,
  resourceBindLeafHashV2,
  resourceBindMemo,
  stampResourceBind,
  type ResourceBindReq,
} from "../src/resource-bind.js";

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "resource-bind-v2-golden.json",
);

const req: ResourceBindReq = {
  payTo: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  amount: "1000",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  resource: "https://merchant.example/paid?b=2&a=1#frag",
  scheme: "exact",
};
const bind = { decision_id: "decision-test-1", preflight_id: 42 };

const v1 = resourceBindLeafHash(req);
const v2 = resourceBindLeafHashV2(req, bind);
assert.notEqual(v1, v2, "v2 leaf is not the v1 leaf");
assert.notEqual(
  resourceBindLeafHashV2(req, { decision_id: "decision-test-2", preflight_id: 42 }),
  v2,
  "flipping decision_id changes the v2 hash",
);
assert.notEqual(
  resourceBindLeafHashV2(req, { decision_id: "decision-test-1" }),
  v2,
  "omitting preflight_id changes the v2 hash",
);
assert.equal(
  resourceBindLeafHashV2(req, { decision_id: "decision-test-1", preflight_id: 42.5 }),
  resourceBindLeafHashV2(req, { decision_id: "decision-test-1" }),
  "non-integer preflight_id is omitted",
);
assert.throws(() => resourceBindLeafHashV2(req, { decision_id: "" }), /decision_id/);
assert.throws(
  () => resourceBindLeafHashV2(req, { decision_id: "x".repeat(DECISION_ID_MAX_BYTES + 1) }),
  /decision_id/,
);

const memoV1 = resourceBindMemo(v1);
const memoV2 = resourceBindMemo(v2, 2);
assert.ok(memoV1.startsWith(RESOURCE_BIND_MEMO_PREFIX));
assert.ok(memoV2.startsWith(RESOURCE_BIND_V2_MEMO_PREFIX));
assert.ok(memoV2.length <= RESOURCE_BIND_MEMO_MAX);
assert.equal(memoV2.length, 47);
assert.ok(memoContainsResourceBind(memoV2, v2, 2));
assert.equal(memoContainsResourceBind(memoV2, v2, 1), false);
assert.ok(memoContainsResourceBind(memoV2, v2), "schema-less match accepts rb2");
assert.equal(evaluateResourceBind({ leaf_hash: v2, tx_memo: memoV2 }).strength, "hard");
assert.equal(evaluateResourceBind({ leaf_hash: v2, tx_memo: memoV1 }).strength, "soft");
assert.equal(evaluateResourceBind({ leaf_hash: v1, tx_memo: memoV2 }).strength, "soft");

assert.equal(pickBindMemo([memoV1, memoV2]), memoV2);
assert.equal(pickBindMemo(["hello", memoV1]), memoV1);
assert.equal(pickBindMemo(["hello"]), "hello");

const stampedV1 = stampResourceBind(req);
assert.equal(stampedV1.leaf_hash, v1);
const stampedV2 = stampResourceBind(req, undefined, bind);
assert.equal(stampedV2.leaf_hash, v2);
assert.equal(stampResourceBind(req, undefined, { decision_id: "" }).leaf_hash, v1);
assert.equal(stampResourceBind(req, undefined, { decision_id: "x".repeat(129) }).strength, "refuse");

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  decision_id: string;
  preflight_id: number;
  req: ResourceBindReq;
  leaf_hash: string;
  memo: string;
};
assert.equal(golden.memo.length, 47);
assert.equal(resourceBindLeafHashV2(golden.req, {
  decision_id: golden.decision_id,
  preflight_id: golden.preflight_id,
}), golden.leaf_hash);
assert.equal(resourceBindMemo(golden.leaf_hash, 2), golden.memo);
assert.equal(v2, golden.leaf_hash);
assert.equal(memoV2, golden.memo);

console.log("resource-bind-v2.test.ts: ALL PASSED");
