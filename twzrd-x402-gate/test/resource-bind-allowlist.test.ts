/**
 * Instruction allowlist on the bound-transfer legs check.
 *
 * A bound transfer may carry ComputeBudget limit and price, Memo instructions
 * (one bind memo, one other), one ATA create for ATA(pay_to, asset), and one
 * TransferChecked. The same transaction with any other instruction riding
 * along is refused with BOUND_TX_INSTRUCTION_REFUSED + a fixed code, wherever
 * the rider sits.
 *
 * Run: npx tsx --test test/resource-bind-allowlist.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOUND_TX_INSTRUCTION_REFUSED,
  evaluateResourceBindLegsFromSvmTx,
  type ResourceBindLeafFields,
} from "../src/resource-bind-tx.js";
import { BOUND_TX_INSTRUCTION_REFUSED as indexPrefix } from "../src/index.js";
import { resourceBindMemo } from "../src/resource-bind.js";
import { twzrd, verifyOfferBindingAfterPay } from "../src/spend-control.js";
import { isFatalGateRefusal } from "../src/binding-plane.js";

const PAYER = "Cswv9ZWHwzv3rypAeW99HBqksKJMmbZdV4FxFYRwymAQ";
const FEE_PAYER = "7U1AChqBBzhXDShbNnKPCU3fCn9UymTqioWJfENDkatp";
const SELLER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UNKNOWN_PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";

const AMOUNT = 50000n;
const LEAF = "aa".repeat(32);
const BIND_MEMO = resourceBindMemo(LEAF, 2);
const OTHER_BIND_MEMO = resourceBindMemo("bb".repeat(32), 2);
const refused = (code: string) => BOUND_TX_INSTRUCTION_REFUSED + code;

const FIELDS: ResourceBindLeafFields = {
  leaf_hash: LEAF, pay_to: SELLER, asset: USDC, amount_raw: AMOUNT.toString(), payer: PAYER,
};

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

type Kit = typeof import("@solana/kit");
type Instruction = Parameters<Kit["appendTransactionMessageInstruction"]>[0];

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

/** The instructions a bound transfer is built from, plus the riders the tests add. */
async function parts() {
  const kit = await import("@solana/kit");
  const token = await import("@solana-program/token");
  const addr = kit.address;
  const R = kit.AccountRole;
  const ataOf = async (owner: string) =>
    (await token.findAssociatedTokenPda({
      owner: addr(owner), mint: addr(USDC), tokenProgram: token.TOKEN_PROGRAM_ADDRESS,
    }))[0];
  const source = await ataOf(PAYER);
  const dest = await ataOf(SELLER);
  const otherAta = await ataOf(OTHER);

  const ix = (programAddress: string, accounts: Array<[string, number]>, data: Uint8Array): Instruction => ({
    programAddress: addr(programAddress),
    accounts: accounts.map(([address, role]) => ({ address: addr(address), role })),
    data,
  }) as Instruction;

  const transfer = (to: string = dest, amount: bigint = AMOUNT) => token.getTransferCheckedInstruction({
    source, mint: addr(USDC), destination: addr(to), authority: addr(PAYER), amount, decimals: 6,
  }) as Instruction;
  const memo = (text: string, accounts: Array<[string, number]> = []) =>
    ix(MEMO_PROGRAM, accounts, new TextEncoder().encode(text));
  const ataCreate = (owner: string, ata: string, data: number[] = [1], mint: string = USDC) => ix(
    ASSOCIATED_TOKEN,
    [[FEE_PAYER, R.WRITABLE_SIGNER], [ata, R.WRITABLE], [owner, R.READONLY], [mint, R.READONLY],
      [SYSTEM, R.READONLY], [TOKEN, R.READONLY]],
    Uint8Array.from(data),
  );

  return {
    kit, dest, source, otherAta, transfer, memo, ataCreate, ix, R,
    limit: (units = 20000) => ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([2]), u32le(units)])),
    price: (micro = 1n) => ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([3]), u64le(micro)])),
    heapFrame: () => ix(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([1]), u32le(65536)])),
    systemTransfer: () => ix(
      SYSTEM, [[PAYER, R.WRITABLE_SIGNER], [OTHER, R.WRITABLE]],
      Buffer.concat([u32le(2), u64le(1_000_000n)]),
    ),
    /** SPL Token Approve (opcode 4): source, delegate, owner. */
    approve: () => ix(
      TOKEN, [[source, R.WRITABLE], [OTHER, R.READONLY], [PAYER, R.READONLY_SIGNER]],
      Buffer.concat([Buffer.from([4]), u64le(2n ** 64n - 1n)]),
    ),
    /** SPL Token Transfer (opcode 3, unchecked): source, destination, authority. */
    plainTransfer: () => ix(
      TOKEN, [[source, R.WRITABLE], [otherAta, R.WRITABLE], [PAYER, R.READONLY_SIGNER]],
      Buffer.concat([Buffer.from([3]), u64le(1n)]),
    ),
    unknown: () => ix(UNKNOWN_PROGRAM, [[PAYER, R.WRITABLE_SIGNER]], Uint8Array.from([9, 9, 9])),
  };
}

async function wire(instructions: Instruction[]): Promise<string> {
  const kit = await import("@solana/kit");
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(kit.address(FEE_PAYER), m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: kit.blockhash(SYSTEM), lastValidBlockHeight: 0n }, m,
    ),
    (m) => kit.appendTransactionMessageInstructions(instructions, m),
  );
  return kit.getBase64EncodedWireTransaction(kit.compileTransaction(msg));
}

test("index re-exports the refusal prefix", () => {
  assert.equal(indexPrefix, BOUND_TX_INSTRUCTION_REFUSED);
});

test("a bound transfer built only from allowlisted instructions is hard", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const shapes: Record<string, Instruction[]> = {
    "transfer + bind memo": [p.transfer(), p.memo(BIND_MEMO)],
    "limit + price + transfer + bind memo": [p.limit(), p.price(), p.transfer(), p.memo(BIND_MEMO)],
    "with the x402 client's own memo": [p.limit(), p.price(), p.transfer(), p.memo("0f".repeat(16)), p.memo(BIND_MEMO)],
    "with a create-idempotent for the recipient ATA": [
      p.limit(), p.price(), p.ataCreate(SELLER, p.dest), p.transfer(), p.memo(BIND_MEMO),
    ],
    "with a plain create for the recipient ATA": [
      p.ataCreate(SELLER, p.dest, [0]), p.transfer(), p.memo(BIND_MEMO),
    ],
    "with a create encoded as empty data": [p.ataCreate(SELLER, p.dest, []), p.transfer(), p.memo(BIND_MEMO)],
  };
  for (const [name, instructions] of Object.entries(shapes)) {
    const d = await evaluateResourceBindLegsFromSvmTx(await wire(instructions), FIELDS);
    assert.equal(d.strength, "hard", `${name}: ${d.reason}`);
    assert.match(d.reason, /same tx/);
  }
});

test("the same bound transfer with a rider instruction is refused, wherever the rider sits", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const base = () => [p.limit(), p.price(), p.transfer(), p.memo(BIND_MEMO)];
  const control = await evaluateResourceBindLegsFromSvmTx(await wire(base()), FIELDS);
  assert.equal(control.strength, "hard");

  const riders: Array<[string, Instruction, string]> = [
    ["system transfer", p.systemTransfer(), `program_not_allowed:${SYSTEM}`],
    ["second TransferChecked", p.transfer(p.otherAta, 1n), "duplicate_transfer"],
    ["second TransferChecked to the bound recipient", p.transfer(), "duplicate_transfer"],
    ["token Approve", p.approve(), "token_instruction_not_allowed"],
    ["unchecked token Transfer", p.plainTransfer(), "token_instruction_not_allowed"],
    ["unknown program", p.unknown(), `program_not_allowed:${UNKNOWN_PROGRAM}`],
    ["ComputeBudget RequestHeapFrame", p.heapFrame(), "compute_budget_instruction_not_allowed"],
    ["second compute unit limit", p.limit(1), "duplicate_compute_unit_limit"],
    ["second compute unit price", p.price(9n), "duplicate_compute_unit_price"],
    ["second bind memo", p.memo(OTHER_BIND_MEMO), "duplicate_bind_memo"],
    ["memo naming an account", p.memo("note", [[PAYER, p.R.READONLY_SIGNER]]), "memo_has_accounts"],
    ["empty memo", p.memo(""), "memo_empty"],
    ["ATA RecoverNested", p.ataCreate(SELLER, p.dest, [2]), "ata_instruction_not_allowed"],
    ["ATA create for another owner", p.ataCreate(OTHER, p.otherAta), "ata_create_not_for_bound_recipient"],
    ["ATA create naming the recipient but another account", p.ataCreate(SELLER, p.otherAta),
      "ata_create_not_for_bound_recipient"],
    ["ATA create for another mint", p.ataCreate(SELLER, p.dest, [1], "So11111111111111111111111111111111111111112"),
      "ata_create_not_for_bound_recipient"],
  ];
  for (const [name, rider, code] of riders) {
    for (const [where, instructions] of [
      ["first", [rider, ...base()]],
      ["before the transfer", [p.limit(), p.price(), rider, p.transfer(), p.memo(BIND_MEMO)]],
      ["last", [...base(), rider]],
    ] as Array<[string, Instruction[]]>) {
      const d = await evaluateResourceBindLegsFromSvmTx(await wire(instructions), FIELDS);
      assert.equal(d.strength, "refuse", `${name} (${where})`);
      assert.equal(d.reason, refused(code), `${name} (${where})`);
      assert.equal(d.evidence_level, "unbound");
    }
  }
});

test("a third memo, a second ATA create, and non-UTF-8 memo bytes are refused", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const cases: Array<[string, Instruction[], string]> = [
    ["two plain memos", [p.transfer(), p.memo("a"), p.memo("b"), p.memo(BIND_MEMO)], "duplicate_memo"],
    ["two ATA creates", [p.ataCreate(SELLER, p.dest), p.ataCreate(SELLER, p.dest), p.transfer(), p.memo(BIND_MEMO)],
      "duplicate_ata_create"],
    ["memo bytes that are not UTF-8", [p.transfer(), p.memo(BIND_MEMO),
      p.ix(MEMO_PROGRAM, [], Uint8Array.from([0xff, 0xfe, 0xfd]))], "memo_not_utf8"],
    ["TransferChecked with a fifth account", [p.memo(BIND_MEMO), (() => {
      const x = p.transfer() as unknown as { accounts: unknown[] };
      return {
        ...x, accounts: [...x.accounts, { address: p.kit.address(OTHER), role: p.R.READONLY }],
      } as unknown as Instruction;
    })()], "transfer_bad_accounts"],
    ["ComputeBudget naming an account", [p.ix(COMPUTE_BUDGET, [[PAYER, p.R.READONLY]],
      Buffer.concat([Buffer.from([2]), u32le(1)])), p.transfer(), p.memo(BIND_MEMO)], "compute_budget_has_accounts"],
  ];
  for (const [name, instructions, code] of cases) {
    const d = await evaluateResourceBindLegsFromSvmTx(await wire(instructions), FIELDS);
    assert.equal(d.strength, "refuse", name);
    assert.equal(d.reason, refused(code), name);
  }
});

test("the first violation in instruction order is the one reported, on every run", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const tx = await wire([p.unknown(), p.systemTransfer(), p.transfer(), p.transfer(), p.memo(BIND_MEMO)]);
  const reasons = new Set<string>();
  for (let i = 0; i < 3; i++) reasons.add((await evaluateResourceBindLegsFromSvmTx(tx, FIELDS)).reason);
  assert.deepEqual([...reasons], [refused(`program_not_allowed:${UNKNOWN_PROGRAM}`)]);
});

test("a rider outranks every other reason: no memo, wrong amount, and wrong recipient still report the rider", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const want = refused(`program_not_allowed:${SYSTEM}`);
  const noMemo = await wire([p.transfer(), p.systemTransfer()]);
  assert.equal((await evaluateResourceBindLegsFromSvmTx(noMemo, FIELDS)).reason, want);
  const wrongAmount = await wire([p.transfer(p.dest, 1n), p.memo(BIND_MEMO), p.systemTransfer()]);
  assert.equal((await evaluateResourceBindLegsFromSvmTx(wrongAmount, FIELDS)).reason, want);
  const wrongRecipient = await wire([p.transfer(p.otherAta), p.memo(BIND_MEMO), p.systemTransfer()]);
  assert.equal((await evaluateResourceBindLegsFromSvmTx(wrongRecipient, FIELDS)).reason, want);
  const riderOnly = await wire([p.systemTransfer()]);
  assert.equal((await evaluateResourceBindLegsFromSvmTx(riderOnly, FIELDS)).reason, want);
});

test("the pay path blocks a rider with bind_unexpected_instruction and keeps bind_mismatch for the rest", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const args = { leafHash: LEAF, payTo: SELLER, asset: USDC, amountRaw: AMOUNT.toString(), scheme: "exact" };

  const clean = await verifyOfferBindingAfterPay({
    ...args, transactionBase64: await wire([p.limit(), p.price(), p.transfer(), p.memo(BIND_MEMO)]),
  });
  assert.equal(clean.verdict, "allow");
  assert.equal(clean.receipt.strength, "hard");

  const ridden = await verifyOfferBindingAfterPay({
    ...args,
    transactionBase64: await wire([p.limit(), p.price(), p.transfer(), p.memo(BIND_MEMO), p.systemTransfer()]),
  });
  assert.equal(ridden.verdict, "block");
  assert.equal(ridden.reason, "bind_unexpected_instruction");
  assert.equal(ridden.detail, refused(`program_not_allowed:${SYSTEM}`));
  assert.equal(ridden.receipt.strength, "refuse");

  const unbound = await verifyOfferBindingAfterPay({ ...args, transactionBase64: await wire([p.transfer()]) });
  assert.equal(unbound.verdict, "block");
  assert.equal(unbound.reason, "bind_mismatch");
  assert.equal(unbound.detail, undefined);

  assert.equal(isFatalGateRefusal("bind_unexpected_instruction"), true);
  assert.equal(isFatalGateRefusal("bind_mismatch"), true);
});

test("safeFetch pays the bound transfer and refuses the same transfer with a rider before pay() runs", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const resource = "https://merchant.example/paid";
  const offer = {
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "solana", payTo: SELLER, amount: AMOUNT.toString(), asset: USDC, resource }],
  };
  const fetch402 = (async () => new Response(JSON.stringify(offer), {
    status: 402, headers: { "content-type": "application/json" },
  })) as typeof fetch;

  /** Run safeFetch with the bound transfer plus `riders`, appended after the bind memo or put first. */
  const run = async (riders: Instruction[], first = false) => {
    let composed: string | undefined;
    const paid: string[] = [];
    const result = await twzrd.safeFetch(resource, {
      fetch: fetch402,
      requireOfferBinding: true,
      composeBoundTransaction: async ({ memo }) => {
        const bound = [p.limit(), p.price(), p.transfer(), p.memo(memo)];
        composed = await wire(first ? [...riders, ...bound] : [...bound, ...riders]);
        return { transactionBase64: composed };
      },
      pay: async ({ transactionBase64 }) => {
        paid.push(String(transactionBase64));
        return { response: new Response("ok", { status: 200 }) };
      },
    });
    return { result, composed, paid };
  };

  const clean = await run([]);
  assert.equal(clean.result.verdict, "allow");
  assert.equal(clean.result.receipt?.strength, "hard");
  assert.equal(clean.result.detail, undefined);
  assert.deepEqual(clean.paid, [clean.composed]);

  const riders: Array<[string, Instruction[], string]> = [
    ["a System transfer", [p.systemTransfer()], `program_not_allowed:${SYSTEM}`],
    ["a second TransferChecked to another account", [p.transfer(p.otherAta)], "duplicate_transfer"],
    ["an unchecked SPL Transfer", [p.plainTransfer()], "token_instruction_not_allowed"],
    ["an SPL Approve", [p.approve()], "token_instruction_not_allowed"],
    ["an unknown program", [p.unknown()], `program_not_allowed:${UNKNOWN_PROGRAM}`],
  ];
  for (const [name, extra, code] of riders) {
    for (const first of [false, true]) {
      const where = `${name}, ${first ? "first" : "last"}`;
      // A second TransferChecked put first is the one the legs check reads, so the bound one is the duplicate.
      const ridden = await run(extra, first);
      assert.equal(ridden.result.verdict, "block", where);
      assert.equal(ridden.result.reason, "bind_unexpected_instruction", where);
      assert.equal(ridden.result.detail, refused(code), where);
      assert.equal(ridden.result.receipt?.strength, "refuse", where);
      assert.equal(ridden.result.signerInvocations, 0, where);
      assert.deepEqual(ridden.paid, [], where);
      assert.equal(ridden.result.response, undefined, where);
    }
  }
});

test("a bound transaction is read from canonical base64 only: any other spelling is not bound", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const { extractSvmPayerFromTransaction } = await import("../src/seller-hook.js");
  // The second memo's length makes the wire length 2 mod 3, so the text ends in one '='.
  let tx = "";
  for (let pad = 0; pad < 3 && !tx.endsWith("="); pad++) {
    tx = await wire([p.limit(), p.price(), p.transfer(), p.memo(`n${"0".repeat(pad)}`), p.memo(BIND_MEMO)]);
  }
  assert.match(tx, /=$/);
  assert.match(tx, /[+/]/);
  assert.equal((await evaluateResourceBindLegsFromSvmTx(tx, FIELDS)).strength, "hard");
  assert.equal(await extractSvmPayerFromTransaction(tx), PAYER);

  const args = { leafHash: LEAF, payTo: SELLER, asset: USDC, amountRaw: AMOUNT.toString(), scheme: "exact" };
  const respelled: Record<string, string> = {
    "trailing newline": `${tx}\n`,
    "leading space": ` ${tx}`,
    "a space inside": `${tx.slice(0, 40)} ${tx.slice(40)}`,
    "padding removed": tx.replace(/=+$/, ""),
    "one '=' too many": `${tx}=`,
    "URL-safe alphabet": tx.replace(/\+/g, "-").replace(/\//g, "_"),
    "text after the padding": `${tx}AAAA`,
  };
  for (const [name, text] of Object.entries(respelled)) {
    assert.deepEqual(Buffer.from(text, "base64"), Buffer.from(tx, "base64"), `${name}: Node reads other bytes`);
    const d = await evaluateResourceBindLegsFromSvmTx(text, FIELDS);
    assert.notEqual(d.strength, "hard", name);
    const pay = await verifyOfferBindingAfterPay({ ...args, transactionBase64: text });
    assert.equal(pay.verdict, "block", name);
    assert.equal(pay.reason, "bind_mismatch", name);
    assert.equal(await extractSvmPayerFromTransaction(text), null, name);
  }
});

test("a transaction that loads accounts from an address lookup table is refused", async (t) => {
  if (!(await peersOk())) return t.skip("optional SVM peers not installed");
  const p = await parts();
  const kit = p.kit;
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(kit.address(FEE_PAYER), m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: kit.blockhash(SYSTEM), lastValidBlockHeight: 0n }, m,
    ),
    (m) => kit.appendTransactionMessageInstructions([p.transfer(), p.memo(BIND_MEMO)], m),
  );
  // The recipient ATA and the mint move out of the static account list into a table.
  const compressed = kit.compressTransactionMessageUsingAddressLookupTables(msg, {
    [kit.address(OTHER)]: [kit.address(p.dest), kit.address(USDC)],
  });
  const compiled = kit.compileTransaction(compressed);
  const decoded = kit.getCompiledTransactionMessageDecoder().decode(compiled.messageBytes) as {
    addressTableLookups?: unknown[];
  };
  assert.equal(decoded.addressTableLookups?.length, 1, "the fixture really uses a lookup table");
  const d = await evaluateResourceBindLegsFromSvmTx(kit.getBase64EncodedWireTransaction(compiled), FIELDS);
  assert.equal(d.strength, "refuse");
  assert.equal(d.reason, refused("address_lookup_tables_not_allowed"));
});
