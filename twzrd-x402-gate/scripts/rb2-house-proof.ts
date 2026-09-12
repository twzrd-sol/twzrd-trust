/**
 * House proof (no broadcast): recompute the pinned v2 golden, then compose an
 * unsigned SVM tx whose Memo IX is rb2:… and extract it back.
 *
 *   npx tsx scripts/rb2-house-proof.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resourceBindLeafHashV2,
  resourceBindMemo,
} from "../src/resource-bind.js";
import { extractSvmMemoFromTransaction } from "../src/resource-bind-tx.js";
import type { ResourceBindReq } from "../src/resource-bind.js";

const golden = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/resource-bind-v2-golden.json"),
    "utf8",
  ),
) as {
  decision_id: string;
  preflight_id: number;
  req: ResourceBindReq;
  leaf_hash: string;
  memo: string;
};

const leaf = resourceBindLeafHashV2(golden.req, {
  decision_id: golden.decision_id,
  preflight_id: golden.preflight_id,
});
const memo = resourceBindMemo(leaf, 2);
assert.equal(leaf, golden.leaf_hash);
assert.equal(memo, golden.memo);
assert.equal(memo.length, 47);
assert.ok(memo.startsWith("rb2:"));
console.log("golden recompute: ok");
console.log(`  leaf_hash=${leaf}`);
console.log(`  memo=${memo}`);

try {
  await import("@x402/svm");
  await import("@solana/kit");
} catch {
  console.log("compose-and-decode: skipped (no @x402/svm peer)");
  process.exit(0);
}

const kit = await import("@solana/kit");
const b64 = kit.getBase64EncodedWireTransaction(
  kit.compileTransaction(
    kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(
        kit.address("11111111111111111111111111111111"),
        m,
      ),
      (m) => kit.setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: kit.blockhash("11111111111111111111111111111111"),
          lastValidBlockHeight: 0n,
        },
        m,
      ),
      (m) => kit.appendTransactionMessageInstruction(
        {
          programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          accounts: [],
          data: new TextEncoder().encode(memo),
        },
        m,
      ),
    ),
  ),
);
const extracted = await extractSvmMemoFromTransaction(b64);
assert.equal(extracted, memo);
console.log("compose-and-decode: ok (unsigned, not broadcast)");
console.log("claim: a payer-signed Solana tx can commit to decision_id via rb2:");
console.log("unclaimed: closed loop, Path B/G, block-side chain evidence, settle requiring memo");
