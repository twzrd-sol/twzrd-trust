// createGuardedX402SolanaFetch on the stock x402-solana client. The seller is
// in this process (the transport below answers with Response objects). The
// client reads the chain from the loopback RPC stub (lib/solana-rpc.mjs), so
// these tests open loopback sockets; the last test checks that none went
// anywhere else.
//
// The x402-solana seat is opt-in. Without its packages (npm run
// setup:x402-solana) every test here is skipped, and the skip says why.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { X402_SOLANA_SETUP, createDemoSolanaWallet, loadX402Solana, readTransfer } from "../lib/agent.mjs";
import { createGuardedX402SolanaFetch } from "../lib/guarded-fetch.mjs";
import { installNetGuard } from "../lib/net-guard.mjs";
import { RAILS, demoAddress, demoKey } from "../lib/rails.mjs";
import { loadReceipt } from "../lib/receipt.mjs";
import { paymentRequired } from "../lib/seller.mjs";

const seat = await loadX402Solana();
const skip = seat.available ? false : `x402-solana seat not installed (${seat.missing.join(", ")}); ${X402_SOLANA_SETUP} adds it`;
const { createX402Client } = seat;
const { PublicKey, VersionedTransaction } = seat.available ? await import("@solana/web3.js") : {};
const { DEMO_BLOCKHASH, startSolanaRpc, tokenAccountOf } = seat.available ? await import("../lib/solana-rpc.mjs") : {};

const guard = installNetGuard();
const scratchDirs = [];
const stubs = [];
after(async () => {
  for (const stub of stubs) await stub.close();
  guard.uninstall();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const SOL = RAILS.solana;
const ORIGIN = "http://seller.invalid";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const toBase64Json = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const fromBase64Json = (text) => JSON.parse(Buffer.from(text, "base64").toString("utf8"));

/** A seller in this process: a 402 carrying `required` for an unpaid request, a 200 with `body` for a paid one. */
function fakeSeller({ path = "/good", body = { content: "demo" }, required = paymentRequired(path, ORIGIN) } = {}) {
  const seen = { requests: 0, unpaid: 0, paid: 0, payments: [] };
  async function transport(input, init) {
    const request = new Request(input, init);
    seen.requests += 1;
    const signature = request.headers.get("payment-signature");
    if (!signature) {
      seen.unpaid += 1;
      return new Response(JSON.stringify(required), {
        status: 402,
        headers: { "content-type": "application/json", "payment-required": toBase64Json(required) },
      });
    }
    seen.paid += 1;
    seen.payments.push(fromBase64Json(signature));
    const settlement = { success: true, network: SOL.network, transaction: "demo-no-chain", payer: SOL.buyer };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", "payment-response": toBase64Json(settlement) },
    });
  }
  return { url: `${ORIGIN}${path}`, seen, transport };
}

/** A fresh RPC stub holding the buyer's and the good seller's USDC token accounts. */
async function rpcStub() {
  const stub = await startSolanaRpc({ mint: SOL.usdc, holders: [SOL.buyer, SOL.sellers.good] });
  stubs.push(stub);
  return stub;
}

function sentinelFiles() {
  const dir = mkdtempSync(join(tmpdir(), "x402-guarded-solana-"));
  scratchDirs.push(dir);
  return { stateDir: dir, killFilePath: join(dir, ".kill"), pauseFilePath: join(dir, ".pause") };
}

function wire({ seller, stub, files = sentinelFiles(), ...options }) {
  const { wallet, signer } = createDemoSolanaWallet(SOL.buyer);
  const events = { decisions: [], kills: [], receipts: [] };
  const pay = createGuardedX402SolanaFetch({
    createX402Client,
    wallet,
    rpcUrl: stub.url,
    customFetch: seller.transport,
    maxPricePerCall: "0.10",
    allowedRecipients: [SOL.sellers.good],
    twzrd: { disabled: true, ...files },
    onDecision: (record) => events.decisions.push(record),
    onKill: (record) => events.kills.push(record),
    onReceiptVerified: (event) => events.receipts.push(event),
    ...options,
  });
  return { pay, events, files, signer };
}

const pick = (record, keys) => Object.fromEntries(keys.map((k) => [k, record[k]]));
const KEYS = ["decision", "reason", "stage", "signerInvocations", "status", "receiptVerified", "chain", "asset", "amountUsdc", "payTo"];
const reads = (stub) => {
  const c = stub.calls();
  return c.getAccountInfo + c.getLatestBlockhash + c.other;
};
const hookRefusal = (reason) => (error) => error.message === `Payment aborted by beforePayment hook: [twzrd-guarded-fetch] ${reason}`;
/** Wait until `reached` settles, failing at once if `call` settles first. */
const reach = (reached, call) =>
  Promise.race([reached, call.then(() => Promise.reject(new Error("the call settled before reaching its hold")))]);

test("allow: the client builds a USDC transfer for the approved offer, the wallet is asked once, and the receipt verifies", { skip }, async () => {
  const stub = await rpcStub();
  const seller = fakeSeller({ path: "/receipt", body: { twzrd_receipt: loadReceipt() } });
  const { pay, events, signer } = wire({ seller, stub, receipt: true });

  const response = await pay(seller.url);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).twzrd_receipt, "the caller still reads the body");
  assert.deepEqual(pick(seller.seen, ["requests", "unpaid", "paid"]), { requests: 2, unpaid: 1, paid: 1 });

  // The wallet was handed one TransferChecked that pays the offer from the buyer's token account.
  const source = tokenAccountOf(SOL.buyer, SOL.usdc);
  const destination = tokenAccountOf(SOL.sellers.good, SOL.usdc);
  const transfer = {
    transfers: 1,
    feePayer: SOL.feePayer,
    blockhash: DEMO_BLOCKHASH,
    source,
    mint: SOL.usdc,
    destination,
    owner: SOL.buyer,
    amount: "10000",
    decimals: 6,
  };
  assert.equal(signer.calls, 1);
  assert.deepEqual(signer.transfers, [transfer]);
  // The seller got that transaction for the Solana offer (unsigned: the demo wallet holds no key).
  const [payment] = seller.seen.payments;
  assert.equal(payment.accepted.network, SOL.network);
  assert.equal(payment.accepted.payTo, SOL.sellers.good);
  assert.deepEqual(readTransfer(VersionedTransaction.deserialize(Buffer.from(payment.payload.transaction, "base64"))), transfer);

  // What it read from the chain: the mint, the two token accounts and a blockhash.
  const c = stub.calls();
  assert.deepEqual([...new Set(c.accountsRead)].sort(), [SOL.usdc, source, destination].sort());
  assert.equal(c.getLatestBlockhash, 1);
  assert.equal(c.other, 0);

  assert.equal(events.decisions.length, 1);
  assert.deepEqual(pick(events.decisions[0], KEYS), {
    decision: "allow",
    reason: null,
    stage: "pre_sign",
    signerInvocations: 1,
    status: 200,
    receiptVerified: true,
    chain: "solana",
    asset: "USDC",
    amountUsdc: "0.01",
    payTo: SOL.sellers.good,
  });
  assert.equal(events.kills.length, 0);
  assert.equal(events.receipts.length, 1);
  assert.equal(events.receipts[0].valid, true);
});

test("block: a recipient off the allowlist, a price over the cap and a token that is not USDC are refused in the hook, before any chain read or wallet call", { skip }, async () => {
  const stub = await rpcStub();
  const cases = [
    { path: "/flagged", reason: "unauthorized_recipient" },
    { path: "/pricey", reason: "price_cap_exceeded" },
    { path: "/wrong-asset", reason: "unsupported_or_non_usdc_asset" },
  ];
  for (const { path, reason } of cases) {
    const seller = fakeSeller({ path });
    const { pay, events, signer } = wire({ seller, stub });
    await assert.rejects(pay(seller.url), hookRefusal(reason), path);
    assert.deepEqual(pick(seller.seen, ["requests", "unpaid", "paid"]), { requests: 1, unpaid: 1, paid: 0 }, path);
    assert.equal(signer.calls, 0, path);
    assert.equal(events.decisions.length, 1, path);
    assert.deepEqual(
      pick(events.decisions[0], ["decision", "reason", "stage", "signerInvocations", "chain"]),
      { decision: "block", reason, stage: "pre_sign", signerInvocations: 0, chain: "solana" },
      path,
    );
    assert.equal(events.kills.length, 0, path);
  }
  assert.equal(reads(stub), 0, "no refusal read the chain");
});

test("network: the stock client takes the first Solana offer on any cluster; one off the configured cluster is refused", { skip }, async () => {
  const stub = await rpcStub();
  const mainnet = paymentRequired("/good", ORIGIN);
  const offer = mainnet.accepts.find((o) => o.network === SOL.network);
  // A devnet offer first: x402-solana selects it, whatever network the client was configured with.
  const required = { ...mainnet, accepts: [{ ...offer, network: DEVNET, asset: DEVNET_USDC }, offer] };
  const seller = fakeSeller({ required });
  const { pay, events, signer } = wire({ seller, stub });
  await assert.rejects(pay(seller.url), hookRefusal("network_not_allowed"));
  assert.equal(signer.calls, 0);
  assert.equal(seller.seen.paid, 0);
  assert.equal(reads(stub), 0);
  assert.deepEqual(pick(events.decisions[0], ["decision", "reason", "stage", "chain", "network"]), {
    decision: "block",
    reason: "network_not_allowed",
    stage: "pre_sign",
    chain: "solana-devnet",
    network: DEVNET,
  });
});

test("a malformed amount is the client's own error, before the hook: recorded as an error, nothing read or signed", { skip }, async () => {
  const stub = await rpcStub();
  const required = paymentRequired("/good", ORIGIN);
  required.accepts = required.accepts.map((o) => (o.network === SOL.network ? { ...o, amount: "0.01" } : o));
  const seller = fakeSeller({ required });
  const { pay, events, signer } = wire({ seller, stub });
  await assert.rejects(pay(seller.url), /Invalid amount in payment requirements/);
  assert.equal(signer.calls, 0);
  assert.equal(reads(stub), 0);
  assert.equal(events.decisions.length, 1);
  assert.equal(events.decisions[0].decision, "error");
  assert.match(events.decisions[0].reason, /Invalid amount/);
  assert.equal(events.decisions[0].chain, null, "the hook never saw the offer");
});

test("halt: with .kill or an active .pause nothing is sent or read from the chain, and onKill fires", { skip }, async () => {
  const stub = await rpcStub();
  const cases = [
    { write: (f) => writeFileSync(f.killFilePath, "halt\n"), reason: "twzrd_kill_switch" },
    {
      write: (f) => writeFileSync(f.pauseFilePath, JSON.stringify({ until_unix_ms: Date.now() + 60_000, reason: "operator_review" })),
      reason: "twzrd_payment_paused (operator_review)",
    },
    { write: (f) => writeFileSync(f.pauseFilePath, "not json\n"), reason: "twzrd_pause_corrupt" },
  ];
  for (const { write, reason } of cases) {
    const files = sentinelFiles();
    write(files);
    const seller = fakeSeller();
    const { pay, events, signer } = wire({ seller, stub, files });
    await assert.rejects(pay(seller.url), (error) => error.message === `[twzrd-guarded-fetch] ${reason}`);
    assert.equal(seller.seen.requests, 0, reason);
    assert.equal(signer.calls, 0, reason);
    assert.deepEqual(pick(events.decisions[0], ["decision", "reason", "stage", "signerInvocations", "chain"]), {
      decision: "block",
      reason,
      stage: "entry",
      signerInvocations: 0,
      chain: null,
    });
    assert.deepEqual(events.kills, events.decisions, reason);
  }
  assert.equal(reads(stub), 0);
});

test("kill after the hook approved: a .kill written while the client reads the chain is found in the wallet, before the signer, and the reservation is released", { skip, timeout: 15_000 }, async () => {
  const stub = await rpcStub();
  const seller = fakeSeller();
  const { pay, events, signer, files } = wire({ seller, stub, hourlyBudgetCap: "0.01" });

  const held = stub.holdNextBlockhash();
  const first = pay(seller.url);
  await reach(held.reached, first); // the hook approved; the client waits on its blockhash
  writeFileSync(files.killFilePath, "halt\n");
  held.release();
  await assert.rejects(first, (error) => error.message === "[twzrd-guarded-fetch] twzrd_kill_switch");
  assert.equal(signer.calls, 0);
  assert.deepEqual(pick(seller.seen, ["unpaid", "paid"]), { unpaid: 1, paid: 0 });
  assert.equal(stub.calls().getLatestBlockhash, 1, "the client had finished its chain reads");
  assert.deepEqual(pick(events.decisions[0], ["decision", "reason", "stage", "signerInvocations"]), {
    decision: "block",
    reason: "twzrd_kill_switch",
    stage: "pre_sign",
    signerInvocations: 0,
  });
  assert.deepEqual(events.kills, events.decisions);

  // The 0.01 reserved for that call was released: with .kill gone, one 0.01
  // payment fits the 0.01 cap ...
  unlinkSync(files.killFilePath);
  assert.equal((await pay(seller.url)).status, 200);
  assert.equal(signer.calls, 1);
  // ... and the payment the wallet was asked to sign counts against it.
  const before = reads(stub);
  await assert.rejects(pay(seller.url), hookRefusal("hourly_budget_exceeded"));
  assert.equal(reads(stub), before);
  assert.equal(signer.calls, 1);
});

test("concurrent calls: an approved amount stays reserved while the client reads the chain, so a second call cannot overspend the hourly cap", { skip, timeout: 15_000 }, async () => {
  const stub = await rpcStub();
  const seller = fakeSeller();
  const { pay, events, signer } = wire({ seller, stub, hourlyBudgetCap: "0.01" });

  const held = stub.holdNextBlockhash();
  const first = pay(seller.url);
  await reach(held.reached, first);
  const before = reads(stub);
  await assert.rejects(pay(seller.url), hookRefusal("hourly_budget_exceeded"));
  assert.equal(reads(stub), before, "the refused call read nothing from the chain");
  held.release();
  assert.equal((await first).status, 200);
  assert.equal(signer.calls, 1);
  assert.deepEqual(
    events.decisions.map((d) => [d.decision, d.reason]),
    [
      ["block", "hourly_budget_exceeded"],
      ["allow", null],
    ],
  );
});

test("refuses what it would not enforce: an unknown option, x402-solana's own amount and beforePayment, an unknown network, a bad limit", { skip }, () => {
  const { wallet } = createDemoSolanaWallet(SOL.buyer);
  const base = { createX402Client, wallet };
  const refused = (options, message) => assert.throws(() => createGuardedX402SolanaFetch(options), { name: "TypeError", message });
  refused({ ...base, amount: 10_000n }, /does not take amount/);
  refused({ ...base, beforePayment: async () => undefined }, /does not take beforePayment/);
  refused({ ...base, maxSpend: "0.10" }, /does not take maxSpend/);
  refused({ ...base, network: "mainnet-beta" }, /network must be/);
  refused({ ...base, maxPricePerCall: "0.0000001" }, /maxPricePerCall must be/);
  refused({ ...base, hourlyBudgetCap: "-1" }, /hourlyBudgetCap must be/);
  refused({ ...base, allowedRecipients: SOL.sellers.good }, /allowedRecipients must be/);
  refused({ wallet }, /needs createX402Client/);
  refused({ createX402Client, wallet: { address: SOL.buyer } }, /needs a wallet with signTransaction/);
});

test("demo keys derive from public labels, and every wallet address is on the curve, as token account derivation needs", { skip }, () => {
  assert.equal(demoKey("buyer/solana"), SOL.buyer);
  assert.equal(demoKey("fee-payer/solana"), SOL.feePayer);
  assert.equal(demoKey("blockhash/solana"), DEMO_BLOCKHASH);
  assert.equal(demoAddress("good", "solana"), SOL.sellers.good);
  for (const address of [SOL.buyer, SOL.feePayer, SOL.sellers.good, SOL.sellers.flagged]) {
    assert.ok(PublicKey.isOnCurve(new PublicKey(address).toBytes()), address);
  }
});

test("every connection this file opened was loopback (the RPC stub)", { skip }, () => {
  assert.ok(guard.stats.connections > 0);
  assert.equal(guard.stats.refused, 0, guard.stats.refused_targets.join(", "));
});
