import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { base58 } from "@scure/base";

import {
  COMPUTE_BUDGET_PROGRAM_ID,
  DEMAND_DESK_AUTHORIZATION_VERSION,
  DEMAND_DESK_AUTHORIZATION_VERSION_2_1,
  MEMO_PROGRAM_ID,
  demandDeskAuthorizationPreimage,
  immutableVaultInstructionHash,
  verifyDemandDeskAuthorization,
  type DemandDeskAuthorization,
  type DemandDeskAuthorizationExpectation,
  type DemandDeskAuthorizationVerification,
  type DemandDeskSettlementConstraintsV2_1,
  type SolanaInstructionForAuthorization,
  type UnsignedDemandDeskAuthorization,
} from "../src/demand-desk-authorization.js";
import { createDemandDeskWallet, demandDeskMessageHash, DemandDeskReplayError, DEMAND_DESK_REPLAY_REASON } from "../src/demand-desk-wallet.js";
import { createMemoryOutcomeLedger, type ApprovalBinding, type OutcomeLedger } from "../src/outcome-ledger.js";

const NOW = Date.parse("2026-10-25T02:00:00.000Z");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROGRAM = "4sJCaNbz7HUz58qsA6vtFefPq2RBaN9o4mZ1gXBZryGS";
const CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const key = () => base58.encode(randomBytes(32));
const AGENT = key();
const RECIPIENT = key();
const VAULT = key();
const POLICY = key();

const pair = generateKeyPairSync("ed25519");
const deskRaw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const DESK = base58.encode(deskRaw);
const spendData = Buffer.alloc(49);
createHash("sha256").update("global:spend_with_policy").digest().copy(spendData, 0, 0, 8);
spendData.writeBigUInt64LE(10000n, 8);

const instruction: SolanaInstructionForAuthorization = {
  programId: PROGRAM,
  accounts: [
    { pubkey: POLICY, isSigner: false, isWritable: true },
    { pubkey: VAULT, isSigner: false, isWritable: true },
    { pubkey: RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: USDC, isSigner: false, isWritable: false },
    { pubkey: AGENT, isSigner: true, isWritable: false },
    { pubkey: DESK, isSigner: true, isWritable: false },
    { pubkey: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: false },
  ],
  data: spendData,
};

function unsigned() {
  return {
    contract_version: DEMAND_DESK_AUTHORIZATION_VERSION,
    authorization_id: "550e8400-e29b-41d4-a716-446655440000",
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30_000,
    demand_desk_pubkey: DESK,
    intent: {
      agent_pubkey: AGENT,
      resource_uri: "https://merchant.example/pay/weather?city=berlin",
      facilitator_id: "cdp-bazaar",
      network: CHAIN,
      merchant_recipient: RECIPIENT,
      asset_mint: USDC,
      amount_units: "10000",
    },
    evidence_binding: {
      wash_score: 0.03,
      freshness_epoch_sec: Math.floor((NOW - 5_000) / 1000),
      evidence_digest: "ab".repeat(32),
      transparency_leaf_index: 42,
    },
    settlement_constraints: {
      vault_address: VAULT,
      vault_program_id: PROGRAM,
      policy_pda: POLICY,
      instruction_hash: immutableVaultInstructionHash(instruction),
      max_network_fee_lamports: 10_000,
    },
    decision: { status: "ALLOW" as const, reason_code: "APPROVED" as const },
  };
}

function issue(): DemandDeskAuthorization {
  const body = unsigned();
  return {
    ...body,
    signature: sign(null, demandDeskAuthorizationPreimage(body), pair.privateKey).toString("hex"),
  };
}

function expectation(overrides: Partial<DemandDeskAuthorizationExpectation> = {}): DemandDeskAuthorizationExpectation {
  const body = unsigned();
  return {
    trustedDemandDeskPubkeys: [DESK],
    nowMs: NOW,
    intent: body.intent,
    settlement: {
      vaultAddress: VAULT,
      vaultProgramId: PROGRAM,
      policyPda: POLICY,
    },
    instructions: [instruction],
    networkFeeLamports: 5_000,
    ...overrides,
  };
}

// ---- replay guard ----
type Tx = { bytes: Uint8Array; id: string };
const TX: Tx = { bytes: new Uint8Array([1, 2, 3, 4]), id: "tx1" };
const HASH = "11".repeat(32);
const approval: ApprovalBinding = {
  payTo: RECIPIENT, network: CHAIN, asset: USDC, amountAtomic: "10000",
  request: { method: "GET", url: "https://merchant.example/pay/weather", bodyHash: "" },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  validation: { ruleVersion: "v1" },
};

function rig(ledger: OutcomeLedger) {
  const signCalls: string[] = [];
  const wallet = createDemandDeskWallet<Tx>({
    messageBytes: (tx) => tx.bytes,
    expectation: () => expectation(),
    signTransaction: async (tx) => { signCalls.push(tx.id); return tx; },
    sendTransaction: async () => "sig",
    isActive: () => true,
    replayGuard: { ledger, intentHash: () => HASH },
  });
  const ctx = { authorization: issue(), messageHash: demandDeskMessageHash(TX.bytes) };
  return { wallet, ctx, signCalls };
}

async function refusedBeforeSigning(p: Promise<unknown>, state: string, signCalls: string[], before: number) {
  await assert.rejects(p, (e: unknown) => e instanceof DemandDeskReplayError && e.code === DEMAND_DESK_REPLAY_REASON && e.message === "vault_spend_replay" && e.state === state);
  assert.equal(signCalls.length, before, "signer must not be called");
}

test("replay: first spend on an approved intent marks signing then signs", async () => {
  const ledger = createMemoryOutcomeLedger();
  ledger.begin({ intentHash: HASH, decisionId: "d1", approval });
  const { wallet, ctx, signCalls } = rig(ledger);
  await wallet.signTransaction(TX, ctx);
  assert.deepEqual(signCalls, ["tx1"]);
  assert.equal(ledger.get(HASH)!.state, "signing");
});

test("replay: second spend while signing is refused before any signing call", async () => {
  const ledger = createMemoryOutcomeLedger();
  ledger.begin({ intentHash: HASH, decisionId: "d1", approval });
  const { wallet, ctx, signCalls } = rig(ledger);
  await wallet.signTransaction(TX, ctx);
  await refusedBeforeSigning(wallet.signTransaction(TX, ctx), "signing", signCalls, 1);
  await refusedBeforeSigning(wallet.signAndSendTransaction(TX, ctx), "signing", signCalls, 1);
  await refusedBeforeSigning(wallet.signAllTransactions([{ transaction: TX, context: ctx }]), "signing", signCalls, 1);
});

test("replay: unknown refuses (the signer may have run)", async () => {
  const ledger = createMemoryOutcomeLedger();
  ledger.begin({ intentHash: HASH, decisionId: "d1", approval });
  ledger.markSigning(HASH);
  ledger.markUnknown(HASH, { cause: "timeout" });
  const { wallet, ctx, signCalls } = rig(ledger);
  await refusedBeforeSigning(wallet.signTransaction(TX, ctx), "unknown", signCalls, 0);
});

for (const ok of [true, false]) {
  const state = ok ? "completed" : "paid_incomplete";
  test(`replay: ${state} refuses before signing`, async () => {
    const ledger = createMemoryOutcomeLedger();
    ledger.begin({ intentHash: HASH, decisionId: "d1", approval });
    ledger.markSigning(HASH);
    ledger.complete(HASH, { settlement: { settlementTx: "tx", amountAtomic: "10000" }, validation: { ok, ruleVersion: "v1" } });
    assert.equal(ledger.get(HASH)!.state, state);
    const { wallet, ctx, signCalls } = rig(ledger);
    await refusedBeforeSigning(wallet.signTransaction(TX, ctx), state, signCalls, 0);
  });
}

test("replay: refused, expired and not_settled allow a new spend", async () => {
  const cases: [string, (l: OutcomeLedger) => void][] = [
    ["refused", (l) => { l.begin({ intentHash: HASH, decisionId: "d1", approval }); l.refuse(HASH, { reasonCodes: ["x"] }); }],
    ["expired", (l) => { l.begin({ intentHash: HASH, decisionId: "d1", approval: { ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() } }); l.lapse(HASH); }],
    ["not_settled", (l) => { l.begin({ intentHash: HASH, decisionId: "d1", approval }); l.markSigning(HASH); l.markUnknown(HASH, { cause: "t" }); l.markNotSettled(HASH, {}); }],
  ];
  for (const [state, setup] of cases) {
    const ledger = createMemoryOutcomeLedger();
    setup(ledger);
    assert.equal(ledger.get(HASH)!.state, state);
    const { wallet, ctx, signCalls } = rig(ledger);
    await wallet.signTransaction(TX, ctx);
    assert.deepEqual(signCalls, ["tx1"], state);
  }
});

test("replay: the same intent twice in one batch signs neither", async () => {
  const ledger = createMemoryOutcomeLedger();
  ledger.begin({ intentHash: HASH, decisionId: "d1", approval });
  const { wallet, ctx, signCalls } = rig(ledger);
  await refusedBeforeSigning(wallet.signAllTransactions([{ transaction: TX, context: ctx }, { transaction: TX, context: ctx }]), "duplicate_in_batch", signCalls, 0);
  assert.equal(ledger.get(HASH)!.state, "approved");
});

test("replay: without replayGuard the facade stays stateless", async () => {
  const calls: string[] = [];
  const wallet = createDemandDeskWallet<Tx>({
    messageBytes: (tx) => tx.bytes, expectation: () => expectation(),
    signTransaction: async (tx) => { calls.push(tx.id); return tx; }, sendTransaction: async () => "s", isActive: () => true,
  });
  const ctx = { authorization: issue(), messageHash: demandDeskMessageHash(TX.bytes) };
  await wallet.signTransaction(TX, ctx);
  await wallet.signTransaction(TX, ctx);
  assert.equal(calls.length, 2);
});

// ---- .kill / .pause: the facade is a signer of its own ----
async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-wallet-"));
  const names = ["TWZRD_STATE_DIR", "KILLSWITCH_KILL_FILE", "KILLSWITCH_PAUSE_FILE"];
  const prev = names.map((n) => process.env[n]);
  for (const n of names) delete process.env[n];
  process.env.TWZRD_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    names.forEach((n, i) => { if (prev[i] === undefined) delete process.env[n]; else process.env[n] = prev[i]; });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const dropKill = (dir: string) => fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
const dropPause = (dir: string) =>
  fs.writeFileSync(path.join(dir, ".pause"), JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: Date.now() + 60_000, reason: "payment_gate_halt" }));

test("halt: an authorized spend is not signed while .kill is on disk, and the ledger stays approved", async () => {
  await withStateDir(async (dir) => {
    const ledger = createMemoryOutcomeLedger();
    ledger.begin({ intentHash: HASH, decisionId: "d1", approval });
    const { wallet, ctx, signCalls } = rig(ledger);
    dropKill(dir);
    await assert.rejects(wallet.signTransaction(TX, ctx), /twzrd_kill_switch/);
    assert.equal(signCalls.length, 0, "signer must not be called");
    assert.equal(ledger.get(HASH)!.state, "approved", "a refused spend is not moved to signing");

    // Not a replay: once the file is gone the same authorized spend signs.
    fs.rmSync(path.join(dir, ".kill"));
    await wallet.signTransaction(TX, ctx);
    assert.deepEqual(signCalls, ["tx1"]);
  });
});

test("halt: an active .pause refuses the spend; batch and sign-and-send stop where the halt lands", async () => {
  await withStateDir(async (dir) => {
    const { wallet, ctx, signCalls } = rig(createMemoryOutcomeLedger());
    dropPause(dir);
    await assert.rejects(wallet.signTransaction(TX, ctx), /twzrd_payment_paused/);
    await assert.rejects(wallet.signAllTransactions([{ transaction: TX, context: ctx }]), /twzrd_payment_paused/);
    await assert.rejects(wallet.signAndSendTransaction(TX, ctx), /twzrd_payment_paused/);
    assert.equal(signCalls.length, 0);
  });

  // Lands while the first item of a batch is being signed: the second is not signed.
  await withStateDir(async (dir) => {
    const signed: string[] = [];
    const wallet = createDemandDeskWallet<Tx>({
      messageBytes: (tx) => tx.bytes, expectation: () => expectation(), isActive: () => true,
      signTransaction: async (tx) => { signed.push(tx.id); dropKill(dir); return tx; },
      sendTransaction: async () => "sig",
    });
    const ctx = { authorization: issue(), messageHash: demandDeskMessageHash(TX.bytes) };
    await assert.rejects(wallet.signAllTransactions([{ transaction: TX, context: ctx }, { transaction: TX, context: ctx }]), /twzrd_kill_switch/);
    assert.equal(signed.length, 1, "the batch kept signing past .kill");
  });

  // Lands while signing: the signed transaction is not sent.
  await withStateDir(async (dir) => {
    let sent = 0;
    const wallet = createDemandDeskWallet<Tx>({
      messageBytes: (tx) => tx.bytes, expectation: () => expectation(), isActive: () => true,
      signTransaction: async (tx) => { dropKill(dir); return tx; },
      sendTransaction: async () => { sent += 1; return "sig"; },
    });
    const ctx = { authorization: issue(), messageHash: demandDeskMessageHash(TX.bytes) };
    await assert.rejects(wallet.signAndSendTransaction(TX, ctx), /twzrd_kill_switch/);
    assert.equal(sent, 0, "the transaction was sent past .kill");
  });
});

test("halt: a configured sentinel directory is read without the environment", async () => {
  await withStateDir(async (dir) => {
    delete process.env.TWZRD_STATE_DIR;
    const signCalls: string[] = [];
    const wallet = createDemandDeskWallet<Tx>({
      messageBytes: (tx) => tx.bytes, expectation: () => expectation(), isActive: () => true,
      signTransaction: async (tx) => { signCalls.push(tx.id); return tx; },
      sendTransaction: async () => "sig",
      sentinel: { stateDir: dir },
    });
    const ctx = { authorization: issue(), messageHash: demandDeskMessageHash(TX.bytes) };
    dropKill(dir);
    await assert.rejects(wallet.signTransaction(TX, ctx), /twzrd_kill_switch/);
    assert.equal(signCalls.length, 0);
  });
});

// ---- batch: what was verified is what is signed ----
const TX2: Tx = { bytes: new Uint8Array([5, 6, 7, 8]), id: "tx2" };
const EVIL: Tx = { bytes: new Uint8Array([9, 9, 9, 9]), id: "evil" };
const ctxFor = (tx: Tx) => ({ authorization: issue(), messageHash: demandDeskMessageHash(tx.bytes) });

/** A wallet whose signer runs `during` while the first item of a batch is being signed. */
function batchRig(during: () => void, isActive: () => boolean = () => true) {
  const signed: string[] = [];
  const wallet = createDemandDeskWallet<Tx>({
    messageBytes: (tx) => tx.bytes, expectation: () => expectation(), isActive,
    signTransaction: async (tx) => {
      signed.push(tx.id);
      if (signed.length === 1) during();
      await new Promise((resolve) => setImmediate(resolve));
      return tx;
    },
    sendTransaction: async () => "sig",
  });
  return { wallet, signed };
}

test("batch: control, the unauthorized transaction is refused on its own", async () => {
  const { wallet, signed } = batchRig(() => {});
  // EVIL's bytes do not hash to the message the authorization context names.
  await assert.rejects(wallet.signTransaction(EVIL, ctxFor(TX)), /transaction_message_mismatch/);
  await assert.rejects(wallet.signAllTransactions([{ transaction: EVIL, context: ctxFor(TX) }]), /transaction_message_mismatch/);
  assert.deepEqual(signed, []);
  assert.deepEqual((await wallet.signAllTransactions([
    { transaction: TX, context: ctxFor(TX) }, { transaction: TX2, context: ctxFor(TX2) },
  ])).map((tx) => tx.id), ["tx1", "tx2"]);
});

test("batch: an item swapped in after verification is not signed", async () => {
  const items = [{ transaction: TX, context: ctxFor(TX) }, { transaction: TX2, context: ctxFor(TX2) }];
  const { wallet, signed } = batchRig(() => { items[1] = { transaction: EVIL, context: ctxFor(TX2) }; });
  const out = await wallet.signAllTransactions(items);
  assert.deepEqual(signed, ["tx1", "tx2"], "the verified second item was signed, not the one swapped in");
  assert.deepEqual(out.map((tx) => tx.id), ["tx1", "tx2"]);
});

test("batch: an item appended after verification is not signed", async () => {
  const items = [{ transaction: TX, context: ctxFor(TX) }];
  const { wallet, signed } = batchRig(() => { items.push({ transaction: EVIL, context: ctxFor(TX) }); });
  const out = await wallet.signAllTransactions(items);
  assert.deepEqual(signed, ["tx1"]);
  assert.equal(out.length, 1);
});

test("batch: a transaction changed in place after verification is refused", async () => {
  const second: Tx = { bytes: new Uint8Array(TX2.bytes), id: "tx2" };
  const items = [{ transaction: TX, context: ctxFor(TX) }, { transaction: second, context: ctxFor(TX2) }];
  const { wallet, signed } = batchRig(() => { second.bytes = EVIL.bytes; second.id = "evil"; });
  await assert.rejects(wallet.signAllTransactions(items), /transaction_message_mismatch/);
  assert.deepEqual(signed, ["tx1"], "the changed transaction never reached the signer");
});

test("batch: a context rewritten after verification does not re-point an item", async () => {
  // The caller's context object is rewritten to match the evil bytes; the copy still names TX2.
  const second: Tx = { bytes: new Uint8Array(TX2.bytes), id: "tx2" };
  const context = ctxFor(TX2);
  const items = [{ transaction: TX, context: ctxFor(TX) }, { transaction: second, context }];
  const { wallet, signed } = batchRig(() => {
    second.bytes = EVIL.bytes; second.id = "evil";
    context.messageHash = demandDeskMessageHash(EVIL.bytes);
  });
  await assert.rejects(wallet.signAllTransactions(items), /transaction_message_mismatch/);
  assert.deepEqual(signed, ["tx1"]);
});

test("batch: a mandate revoked while the first item is signed stops the rest", async () => {
  let active = true;
  const items = [{ transaction: TX, context: ctxFor(TX) }, { transaction: TX2, context: ctxFor(TX2) }];
  const { wallet, signed } = batchRig(() => { active = false; }, () => active);
  await assert.rejects(wallet.signAllTransactions(items), /mandate_inactive/);
  assert.deepEqual(signed, ["tx1"]);
});

test("batch: an intent hash that changes between verification and signing is refused", async () => {
  const ledger = createMemoryOutcomeLedger();
  const hashes = new Map<string, string>([["tx1", "11".repeat(32)], ["tx2", "22".repeat(32)]]);
  for (const h of [...hashes.values(), "33".repeat(32)]) ledger.begin({ intentHash: h, decisionId: `d-${h.slice(0, 2)}`, approval });
  const signed: string[] = [];
  const wallet = createDemandDeskWallet<Tx>({
    messageBytes: (tx) => tx.bytes, expectation: () => expectation(), isActive: () => true,
    signTransaction: async (tx) => {
      signed.push(tx.id);
      // The guard's key for the second item moves to another approved intent.
      hashes.set("tx2", "33".repeat(32));
      await new Promise((resolve) => setImmediate(resolve));
      return tx;
    },
    sendTransaction: async () => "sig",
    replayGuard: { ledger, intentHash: (tx) => hashes.get(tx.id)! },
  });
  await assert.rejects(wallet.signAllTransactions([
    { transaction: TX, context: ctxFor(TX) }, { transaction: TX2, context: ctxFor(TX2) },
  ]), /batch_item_changed/);
  assert.deepEqual(signed, ["tx1"]);
  assert.equal(ledger.get("22".repeat(32))!.state, "approved");
  assert.equal(ledger.get("33".repeat(32))!.state, "approved");
});
