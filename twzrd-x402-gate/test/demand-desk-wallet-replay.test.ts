import assert from "node:assert/strict";
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
