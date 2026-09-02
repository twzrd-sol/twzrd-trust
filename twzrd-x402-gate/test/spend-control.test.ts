/** Product twzrd.safeFetch — not AgentCash ./safe-fetch. Run: npx tsx test/spend-control.test.ts */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySpendLedger } from "../src/policy-runtime.js";
import { createFileSpendLedger } from "../src/spend-ledger-file.js";
import { twzrd, verifyOfferBindingAfterPay } from "../src/spend-control.js";
import { resourceBindLeafHash, resourceBindMemo } from "../src/resource-bind.js";
import { EXACT_SVM_TRANSFER_CHECKED_FIXTURE as FIX } from "./fixtures/exact-svm-transfer-checked.js";

const SOL = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const body402 = (over: Record<string, unknown> = {}) => ({
  x402Version: 1,
  accepts: [{
    scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC,
    resource: "https://merchant.example/paid", ...over,
  }],
});
const fetch402 = (b: unknown = body402()): typeof fetch =>
  (async () => new Response(JSON.stringify(b), { status: 402, headers: { "content-type": "application/json" } })) as typeof fetch;

async function run() {
  let signs = 0;
  const pay = async () => {
    signs += 1;
    return { response: new Response("paid", { status: 200 }) };
  };

  const allow = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), maxSpend: "0.10", allowNetworks: ["solana"], pay, preflight: async () => ({ decision: "allow" }),
  });
  assert.equal(allow.verdict, "allow");
  assert.equal(allow.signerInvocations, 1);

  const warn = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), pay, preflight: async () => ({ decision: "warn" }),
  });
  assert.equal(warn.verdict, "warn");

  signs = 0;
  const blocked = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), pay, preflight: async () => ({ decision: "block" }),
  });
  assert.equal(blocked.verdict, "block");
  assert.equal(blocked.signerInvocations, 0);
  assert.equal(signs, 0);

  signs = 0;
  const over = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), maxSpend: "0.001", allowNetworks: ["solana"], pay,
  });
  assert.equal(over.verdict, "block");
  assert.equal(over.reason, "over_max_spend");
  assert.equal(over.signerInvocations, 0);

  signs = 0;
  const net = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), allowNetworks: ["base"], pay,
  });
  assert.equal(net.verdict, "block");
  assert.equal(net.reason, "network_not_allowed");
  assert.equal(net.signerInvocations, 0);

  const led = createMemorySpendLedger();
  const opts = { fetch: fetch402(), maxSpend: "0.025", ledger: led, agentId: "a1", mandateId: "m1", pay };
  assert.equal((await twzrd.safeFetch("https://merchant.example/paid", opts)).verdict, "allow");
  assert.equal((await twzrd.safeFetch("https://merchant.example/paid", opts)).verdict, "allow");
  const third = await twzrd.safeFetch("https://merchant.example/paid", opts);
  assert.equal(third.verdict, "block");
  assert.equal(third.reason, "over_cumulative_spend");
  assert.equal(third.signerInvocations, 0);

  const merch = createMemorySpendLedger();
  const merchOpts = { fetch: fetch402(), maxSpend: "0.015", ledger: merch, pay };
  assert.equal((await twzrd.safeFetch("https://merchant.example/paid", { ...merchOpts, agentId: "a1" })).verdict, "allow");
  const merchBlock = await twzrd.safeFetch("https://merchant.example/paid", { ...merchOpts, agentId: "a2" });
  assert.equal(merchBlock.verdict, "block");
  assert.equal(merchBlock.reason, "over_cumulative_spend");
  assert.equal(merchBlock.signerInvocations, 0);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "twzrd-sf-")), "ledger.jsonl");
  const fileOpts = {
    fetch: fetch402(), maxSpend: "0.025", ledgerFile: ledgerPath, agentId: "a1", mandateId: "m1", pay,
  };
  assert.equal((await twzrd.safeFetch("https://merchant.example/paid", fileOpts)).verdict, "allow");
  assert.equal((await twzrd.safeFetch("https://merchant.example/paid", fileOpts)).verdict, "allow");
  const reopened = createFileSpendLedger(ledgerPath);
  const fileThird = await twzrd.safeFetch("https://merchant.example/paid", { ...fileOpts, ledger: reopened });
  assert.equal(fileThird.verdict, "block");
  assert.equal(fileThird.reason, "over_cumulative_spend");
  assert.equal(fileThird.signerInvocations, 0);

  // Omitting `ledger` still enforces a cumulative cap within this process.
  const defaultLedgerOpts = {
    fetch: fetch402(body402({ payTo: "DEFAULT_LEDGER_SELLER", amount: "10000" })),
    maxSpend: "0.025", agentId: "default-ledger-test", mandateId: "default-ledger-test", pay,
  };
  assert.equal((await twzrd.safeFetch("https://merchant.example/default-ledger", defaultLedgerOpts)).verdict, "allow");
  assert.equal((await twzrd.safeFetch("https://merchant.example/default-ledger", defaultLedgerOpts)).verdict, "allow");
  const defaultLedgerThird = await twzrd.safeFetch("https://merchant.example/default-ledger", defaultLedgerOpts);
  assert.equal(defaultLedgerThird.verdict, "block");
  assert.equal(defaultLedgerThird.reason, "over_cumulative_spend");
  assert.equal(defaultLedgerThird.signerInvocations, 0);

  // Omitting `pay` entirely must not record a spend: no signer ran, the
  // caller gets the raw 402 back, and nothing was actually paid.
  const noPayLedger = createMemorySpendLedger();
  const noPay = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), maxSpend: "0.10", allowNetworks: ["solana"],
    ledger: noPayLedger, agentId: "no-pay-test", mandateId: "no-pay-test",
  });
  assert.equal(noPay.verdict, "allow");
  assert.equal(noPay.signerInvocations, 0);
  assert.equal(noPayLedger.spentMicro("agent:no-pay-test", 365 * 24 * 3600 * 1000, Date.now()), 0n);

  let bindPayCalls = 0;
  const noCompose = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), requireOfferBinding: true,
    pay: async () => { bindPayCalls += 1; return { response: new Response("paid") }; },
  });
  assert.equal(noCompose.verdict, "block");
  assert.equal(noCompose.reason, "bind_required_no_compose");
  assert.equal(noCompose.signerInvocations, 0);
  assert.equal(bindPayCalls, 0);

  const afterPay = await verifyOfferBindingAfterPay({
    transactionBase64: undefined,
    leafHash: "leaf",
    payTo: SOL,
    asset: USDC,
    amountRaw: "10000",
  });
  assert.equal(afterPay.verdict, "block");
  assert.equal(afterPay.reason, "bind_required_no_settlement");
  assert.equal(afterPay.receipt.strength, "refuse");

  // A null leafHash must refuse explicitly, not silently verify against "".
  const noLeafHash = await verifyOfferBindingAfterPay({
    transactionBase64: Buffer.from("not-a-tx").toString("base64"),
    leafHash: null,
    payTo: SOL,
    asset: USDC,
    amountRaw: "10000",
  });
  assert.equal(noLeafHash.verdict, "block");
  assert.equal(noLeafHash.reason, "bind_required_no_leaf_hash");
  assert.equal(noLeafHash.receipt.strength, "refuse");
  assert.equal(noLeafHash.receipt.leaf_hash, null);

  bindPayCalls = 0;
  const mismatch = await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(), requireOfferBinding: true,
    composeBoundTransaction: async () => ({ transactionBase64: Buffer.from("not-a-tx").toString("base64") }),
    pay: async () => { bindPayCalls += 1; throw new Error("must not pay an unbound transaction"); },
  });
  assert.equal(mismatch.verdict, "block");
  assert.equal(mismatch.reason, "bind_mismatch");
  assert.equal(mismatch.signerInvocations, 0);
  assert.equal(bindPayCalls, 0);

  let v2Composed = false;
  const v2body = {
    x402Version: 2,
    resource: { url: "https://merchant.example/paid" },
    accepts: [{ scheme: "exact", network: "solana", payTo: SOL, amount: "10000", asset: USDC }],
  };
  await twzrd.safeFetch("https://merchant.example/paid", {
    fetch: fetch402(v2body), requireOfferBinding: true,
    composeBoundTransaction: async ({ selected }) => {
      v2Composed = true;
      const extra = selected.extra as { memo?: string; twzrd_resource_bind?: string } | undefined;
      assert.equal(selected.resource, "https://merchant.example/paid");
      assert.equal(extra?.twzrd_resource_bind, undefined);
      return { transactionBase64: Buffer.from("not-a-tx").toString("base64") };
    },
    pay: async () => ({ response: new Response("x") }),
  });
  assert.equal(v2Composed, true);

  try {
    await import("@x402/svm");
    await import("@solana/kit");
    await import("@solana-program/token");
  } catch {
    console.log("spend-control.test.ts: ALL PASSED (bind-hard skipped, no svm peer)");
    return;
  }
  const kit = await import("@solana/kit");
  const token = await import("@solana-program/token");
  const owner = kit.address(FIX.expectedTokenPayer);
  const mint = kit.address(FIX.mint);
  const [ata] = await token.findAssociatedTokenPda({ owner, mint, tokenProgram: token.TOKEN_PROGRAM_ADDRESS });
  const xfer = token.getTransferCheckedInstruction({
    source: ata, mint, destination: ata, authority: owner, amount: 50000n, decimals: 6,
  });
  const resource = "https://merchant.example/paid";
  const lifetime = { blockhash: kit.blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n };
  let seenMemo: string | undefined;
  let preparedTx: string | undefined;
  let submittedTx: string | undefined;
  const bound = await twzrd.safeFetch(resource, {
    fetch: fetch402(body402({ payTo: FIX.expectedTokenPayer, amount: "50000", asset: FIX.mint })),
    requireOfferBinding: true,
    composeBoundTransaction: async ({ selected, memo }) => {
      const extra = selected.extra as { memo?: string; twzrd_resource_bind?: string } | undefined;
      assert.equal(extra?.memo, undefined);
      assert.equal(extra?.twzrd_resource_bind, undefined);
      seenMemo = memo;
      assert.equal(memo, resourceBindMemo(resourceBindLeafHash(selected)));
      const both = kit.getBase64EncodedWireTransaction(kit.compileTransaction(kit.pipe(
        kit.createTransactionMessage({ version: 0 }),
        (m) => kit.setTransactionMessageFeePayer(owner, m),
        (m) => kit.setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => kit.appendTransactionMessageInstructions([xfer, {
          programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
          accounts: [], data: new TextEncoder().encode(String(seenMemo)),
        }], m),
      )));
      preparedTx = both;
      return { transactionBase64: both };
    },
    pay: async ({ transactionBase64 }) => {
      submittedTx = transactionBase64;
      return { response: new Response("ok", { status: 200 }) };
    },
  });
  assert.ok(String(seenMemo).startsWith("rb1:"));
  assert.equal(bound.verdict, "allow");
  assert.equal(bound.receipt?.strength, "hard");
  assert.equal(bound.receipt?.fact_type, "resource_bound");
  assert.equal(submittedTx, preparedTx);
  console.log("spend-control.test.ts: ALL PASSED");
}
await run();
