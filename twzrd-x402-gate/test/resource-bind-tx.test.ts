import assert from "node:assert/strict";
import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as FIX } from "./fixtures/exact-svm-transfer-checked.js";
import {
  extractSvmMemoFromTransaction,
  evaluateResourceBindFromSvmTx,
} from "../src/resource-bind-tx.js";
import { resourceBindMemo } from "../src/resource-bind.js";

assert.equal(await extractSvmMemoFromTransaction(""), null);
assert.equal(await extractSvmMemoFromTransaction("not-base64!!!"), null);
const garbage = await evaluateResourceBindFromSvmTx("$$$$", "ab");
assert.equal(garbage.strength, "soft");

let peer = false;
try { await import("@x402/svm"); await import("@solana/kit"); peer = true; } catch { peer = false; }

if (!peer) {
  assert.equal(await extractSvmMemoFromTransaction(FIX.transactionBase64), null);
} else {
  // Frozen fixture is TransferChecked-only (no Memo IX). Extractor must be null, not soft-fake.
  assert.equal(await extractSvmMemoFromTransaction(FIX.transactionBase64), null);
  assert.equal((await evaluateResourceBindFromSvmTx(FIX.transactionBase64, "aa".repeat(32))).strength, "soft");

  const kit = await import("@solana/kit");
  const leaf = "aa".repeat(32);
  const want = resourceBindMemo(leaf);
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(kit.address("11111111111111111111111111111111"), m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n },
      m,
    ),
    (m) => kit.appendTransactionMessageInstruction({
      programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      accounts: [],
      data: new TextEncoder().encode(want),
    }, m),
  );
  const b64 = kit.getBase64EncodedWireTransaction(kit.compileTransaction(msg));
  const got = await extractSvmMemoFromTransaction(b64);
  assert.equal(got, want);
  const d = await evaluateResourceBindFromSvmTx(b64, leaf);
  assert.equal(d.strength, "hard");
  assert.match(d.reason, /inclusion only/i);
}
console.log("resource-bind-tx.test.ts: ALL PASSED");
