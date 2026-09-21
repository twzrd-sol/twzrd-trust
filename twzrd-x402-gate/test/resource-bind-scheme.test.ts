/**
 * Compat A scheme-aware TransferChecked legs (0.9.10).
 * Missing / "" / null / undefined is exact ===. <= only when normalize === "upto".
 * Unknown present tokens refuse "scheme unknown". Overpay never hard.
 *
 * Run: npx tsx --test test/resource-bind-scheme.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as FIX } from "./fixtures/exact-svm-transfer-checked.js";
import {
  evaluateResourceBindLegsFromSvmTx,
  normalizeResourceBindScheme,
  transferAmountMatchesLeaf,
  type ResourceBindLeafFields,
} from "../src/resource-bind-tx.js";
import {
  normalizeResourceBindScheme as indexNormalize,
  transferAmountMatchesLeaf as indexMatches,
} from "../src/index.js";
import { resourceBindMemo } from "../src/resource-bind.js";

const CAP = "50000";
const LEAF = "aa".repeat(32);
const MEMO = resourceBindMemo(LEAF);
const MISMATCH = "transfer mint/amount mismatch vs leaf";
const UNKNOWN = "scheme unknown";
const NO_XFER = "no TransferChecked in tx";

test("package index re-exports scheme helpers for intel PR2", () => {
  assert.equal(indexNormalize, normalizeResourceBindScheme);
  assert.equal(indexMatches, transferAmountMatchesLeaf);
});

test("normalizeResourceBindScheme: Compat A missing / exact / upto / unknown", () => {
  assert.equal(normalizeResourceBindScheme(undefined), "missing");
  assert.equal(normalizeResourceBindScheme(null), "missing");
  assert.equal(normalizeResourceBindScheme(""), "missing");
  assert.equal(normalizeResourceBindScheme("   "), "missing");
  assert.equal(normalizeResourceBindScheme("exact"), "exact");
  assert.equal(normalizeResourceBindScheme("upto"), "upto");
  assert.equal(normalizeResourceBindScheme(" EXACT "), "exact");
  assert.equal(normalizeResourceBindScheme("Upto"), "upto");
  assert.equal(normalizeResourceBindScheme("batch-settlement"), "unknown");
  assert.equal(normalizeResourceBindScheme("upto_cap"), "unknown");
  assert.equal(normalizeResourceBindScheme("foo"), "unknown");
  assert.equal(normalizeResourceBindScheme("1"), "unknown");
  assert.equal(normalizeResourceBindScheme("ExactSvm"), "unknown");
  assert.equal(normalizeResourceBindScheme(1), "unknown");
});

test("transferAmountMatchesLeaf: missing and exact are ===; upto is <=; unknown false", () => {
  const leaf = (scheme?: string): Pick<ResourceBindLeafFields, "amount_raw" | "scheme"> =>
    scheme === undefined ? { amount_raw: CAP } : { amount_raw: CAP, scheme };

  for (const scheme of [undefined, "", "exact", " EXACT "] as const) {
    const l = scheme === undefined ? leaf() : leaf(scheme);
    assert.equal(transferAmountMatchesLeaf(CAP, l), true, `scheme=${String(scheme)} equal`);
    assert.equal(transferAmountMatchesLeaf("1", l), false, `scheme=${String(scheme)} under`);
    assert.equal(transferAmountMatchesLeaf("0", l), false, `scheme=${String(scheme)} zero`);
    assert.equal(transferAmountMatchesLeaf("50001", l), false, `scheme=${String(scheme)} over`);
  }

  for (const scheme of ["upto", "Upto"] as const) {
    const l = leaf(scheme);
    assert.equal(transferAmountMatchesLeaf(CAP, l), true, `${scheme} equal`);
    assert.equal(transferAmountMatchesLeaf("1", l), true, `${scheme} under`);
    assert.equal(transferAmountMatchesLeaf("0", l), true, `${scheme} zero`);
    assert.equal(transferAmountMatchesLeaf("50001", l), false, `${scheme} over`);
  }

  for (const scheme of ["batch-settlement", "upto_cap", "foo", "1", "ExactSvm"] as const) {
    const l = leaf(scheme);
    assert.equal(transferAmountMatchesLeaf(CAP, l), false, `${scheme} equal still unknown`);
    assert.equal(transferAmountMatchesLeaf("1", l), false, `${scheme} under still unknown`);
  }

  assert.equal(transferAmountMatchesLeaf("not-a-bigint", leaf("exact")), false);
  assert.equal(transferAmountMatchesLeaf(CAP, { amount_raw: "nope", scheme: "exact" }), false);
});

test("no bare <=: source uses paid <= cap only after normalize === upto", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/resource-bind-tx.ts"),
    "utf8",
  );
  const le = [...src.matchAll(/<=/g)];
  assert.equal(le.length, 1, "resource-bind-tx.ts must contain exactly one <=");
  assert.match(src, /if \(scheme === "upto"\) return paid <= cap/);
  assert.doesNotMatch(
    src.slice(src.indexOf("export async function evaluateResourceBindLegsFromSvmTx")),
    /<=/,
    "evaluateResourceBindLegsFromSvmTx must not compare amounts with bare <=",
  );
});

async function peersOk(): Promise<boolean> {
  try {
    await import("@x402/svm");
    await import("@solana/kit");
    await import("@solana-program/token");
    return true;
  } catch {
    return false;
  }
}

async function composeXfer(opts: { amount: bigint; memo?: string }): Promise<string> {
  const kit = await import("@solana/kit");
  const token = await import("@solana-program/token");
  const owner = kit.address(FIX.expectedTokenPayer);
  const mint = kit.address(FIX.mint);
  const [ata] = await token.findAssociatedTokenPda({
    owner, mint, tokenProgram: token.TOKEN_PROGRAM_ADDRESS,
  });
  const xfer = token.getTransferCheckedInstruction({
    source: ata, mint, destination: ata, authority: owner, amount: opts.amount, decimals: 6,
  });
  const lifetime = {
    blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n,
  };
  const ixs = [xfer];
  if (opts.memo) {
    ixs.push({
      programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      accounts: [],
      data: new TextEncoder().encode(opts.memo),
    });
  }
  return kit.getBase64EncodedWireTransaction(kit.compileTransaction(kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(owner, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => kit.appendTransactionMessageInstructions(ixs, m),
  )));
}

async function memoOnlyTx(): Promise<string> {
  const kit = await import("@solana/kit");
  return kit.getBase64EncodedWireTransaction(kit.compileTransaction(kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(kit.address("11111111111111111111111111111111"), m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n },
      m,
    ),
    (m) => kit.appendTransactionMessageInstruction({
      programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      accounts: [],
      data: new TextEncoder().encode(MEMO),
    }, m),
  )));
}

function fields(over: Partial<ResourceBindLeafFields> = {}): ResourceBindLeafFields {
  return {
    leaf_hash: LEAF,
    pay_to: FIX.expectedTokenPayer,
    asset: FIX.mint,
    amount_raw: CAP,
    payer: FIX.expectedTokenPayer,
    ...over,
  };
}

test("legs reject matrix: Compat A omit-scheme fixtures stay exact ===", async (t) => {
  if (!(await peersOk())) {
    t.skip("optional SVM peers not installed");
    return;
  }

  const equal = await composeXfer({ amount: 50000n, memo: MEMO });
  const under = await composeXfer({ amount: 1n, memo: MEMO });
  const zero = await composeXfer({ amount: 0n, memo: MEMO });
  const over = await composeXfer({ amount: 50001n, memo: MEMO });
  const equalSoft = await composeXfer({ amount: 50000n });
  const underUptoSoft = await composeXfer({ amount: 1n });
  const noXfer = await memoOnlyTx();

  const omit = fields();
  const empty = fields({ scheme: "" });
  const exact = fields({ scheme: "exact" });
  const exactPad = fields({ scheme: " EXACT " });
  const upto = fields({ scheme: "upto" });
  const uptoCase = fields({ scheme: "Upto" });

  const hardEqual = await evaluateResourceBindLegsFromSvmTx(equal, omit);
  assert.equal(hardEqual.strength, "hard");
  assert.match(hardEqual.reason, /same tx/);

  const softOmit = await evaluateResourceBindLegsFromSvmTx(equalSoft, omit);
  assert.equal(softOmit.strength, "soft");
  assert.match(softOmit.reason, /memo unbound/);

  for (const leaf of [omit, empty, exact, exactPad]) {
    for (const tx of [under, zero, over]) {
      const d = await evaluateResourceBindLegsFromSvmTx(tx, leaf);
      assert.equal(d.strength, "refuse", `scheme=${String(leaf.scheme)} must refuse non-equal`);
      assert.equal(d.reason, MISMATCH);
    }
  }

  for (const leaf of [upto, uptoCase]) {
    for (const tx of [equal, under, zero]) {
      const hard = await evaluateResourceBindLegsFromSvmTx(tx, leaf);
      assert.equal(hard.strength, "hard", `upto must hard on paid<=cap scheme=${leaf.scheme}`);
      assert.match(hard.reason, /same tx/);
    }
    const refused = await evaluateResourceBindLegsFromSvmTx(over, leaf);
    assert.equal(refused.strength, "refuse");
    assert.equal(refused.reason, MISMATCH);
  }

  const uptoSoft = await evaluateResourceBindLegsFromSvmTx(underUptoSoft, upto);
  assert.equal(uptoSoft.strength, "soft");
  assert.match(uptoSoft.reason, /memo unbound/);

  for (const scheme of ["batch-settlement", "upto_cap", "foo", "1", "ExactSvm"] as const) {
    const d = await evaluateResourceBindLegsFromSvmTx(equal, fields({ scheme }));
    assert.equal(d.strength, "refuse", `${scheme} must refuse`);
    assert.equal(d.reason, UNKNOWN);
    assert.notEqual(d.reason, "scheme missing or unknown");
  }

  const unknownNoXfer = await evaluateResourceBindLegsFromSvmTx(noXfer, fields({ scheme: "foo" }));
  assert.equal(unknownNoXfer.strength, "refuse");
  assert.equal(unknownNoXfer.reason, NO_XFER);

  const mintMismatch = await evaluateResourceBindLegsFromSvmTx(
    equal,
    fields({ asset: "So11111111111111111111111111111111111111112" }),
  );
  assert.equal(mintMismatch.strength, "refuse");
  assert.equal(mintMismatch.reason, MISMATCH);
});
