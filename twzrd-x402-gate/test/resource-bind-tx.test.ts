import assert from "node:assert/strict";
import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as FIX } from "./fixtures/exact-svm-transfer-checked.js";
import {
  extractSvmMemoFromTransaction,
  extractSvmTransferLegs,
  evaluateResourceBindFromSvmTx,
  evaluateResourceBindLegsFromSvmTx,
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

  const legs = await extractSvmTransferLegs(FIX.transactionBase64);
  assert.ok(legs);
  assert.equal(legs.mint, FIX.mint);
  assert.equal(legs.authority, FIX.expectedTokenPayer);
  assert.equal(legs.amount, "50000");
  const fields = {
    leaf_hash: leaf, pay_to: "11111111111111111111111111111111",
    asset: legs.mint, amount_raw: legs.amount, payer: legs.authority,
  };
  assert.equal((await evaluateResourceBindLegsFromSvmTx(FIX.transactionBase64, fields)).strength, "refuse");
  assert.equal((await evaluateResourceBindLegsFromSvmTx(b64, fields)).reason, "no TransferChecked in tx");

  const token = await import("@solana-program/token");
  const owner = kit.address(FIX.expectedTokenPayer);
  const mint = kit.address(FIX.mint);
  const [ata] = await token.findAssociatedTokenPda({
    owner, mint, tokenProgram: token.TOKEN_PROGRAM_ADDRESS,
  });
  const xfer = token.getTransferCheckedInstruction({
    source: ata, mint, destination: ata, authority: owner, amount: 50000n, decimals: 6,
  });
  const lifetime = {
    blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n,
  };
  const xferOnly = kit.getBase64EncodedWireTransaction(kit.compileTransaction(kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(owner, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => kit.appendTransactionMessageInstruction(xfer, m),
  )));
  const match = {
    leaf_hash: leaf, pay_to: FIX.expectedTokenPayer, asset: FIX.mint, amount_raw: "50000",
    payer: FIX.expectedTokenPayer,
  };
  const soft = await evaluateResourceBindLegsFromSvmTx(xferOnly, match);
  assert.equal(soft.strength, "soft");
  assert.match(soft.reason, /memo unbound/);
  const both = kit.getBase64EncodedWireTransaction(kit.compileTransaction(kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(owner, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => kit.appendTransactionMessageInstructions([xfer, {
      programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      accounts: [],
      data: new TextEncoder().encode(want),
    }], m),
  )));
  const hard = await evaluateResourceBindLegsFromSvmTx(both, match);
  assert.equal(hard.strength, "hard");
  assert.match(hard.reason, /same tx/);
}
console.log("resource-bind-tx.test.ts: ALL PASSED");
