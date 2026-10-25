import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { base58 } from "@scure/base";

import {
  DEMAND_DESK_AUTHORIZATION_VERSION,
  demandDeskAuthorizationPreimage,
  immutableVaultInstructionHash,
  verifyDemandDeskAuthorization,
  type DemandDeskAuthorization,
  type DemandDeskAuthorizationExpectation,
  type SolanaInstructionForAuthorization,
} from "../src/demand-desk-authorization.js";

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

test("accepts one exact, current, trusted Desk authorization", () => {
  const result = verifyDemandDeskAuthorization(issue(), expectation());
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("accepts the same Ed25519 signature encoded as base58", () => {
  const body = unsigned();
  const authorization: DemandDeskAuthorization = {
    ...body,
    signature: base58.encode(sign(null, demandDeskAuthorizationPreimage(body), pair.privateKey)),
  };
  const result = verifyDemandDeskAuthorization(authorization, expectation());
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("refuses expiry before any transaction authorization", () => {
  const result = verifyDemandDeskAuthorization(issue(), expectation({ nowMs: NOW + 30_000 }));
  assert.deepEqual(result, { ok: false, code: "expired", message: "Demand Desk authorization is expired" });
});

test("covers authorization id, timestamps, evidence, constraints, and decision with the signature", () => {
  for (const mutate of [
    (a: DemandDeskAuthorization) => { a.authorization_id = "550e8400-e29b-41d4-a716-446655440001"; },
    (a: DemandDeskAuthorization) => { a.expires_at_ms += 1; },
    (a: DemandDeskAuthorization) => { a.evidence_binding.transparency_leaf_index += 1; },
    (a: DemandDeskAuthorization) => { a.settlement_constraints.max_network_fee_lamports += 1; },
    (a: DemandDeskAuthorization) => { a.decision = { status: "REFUSE", reason_code: "REFUSE_STALE_EVIDENCE" }; },
  ]) {
    const authorization = structuredClone(issue());
    mutate(authorization);
    const result = verifyDemandDeskAuthorization(authorization, expectation());
    assert.equal(result.ok, false);
    assert.equal(result.code, "signature_invalid");
  }
});

test("refuses a valid signature from an unpinned Desk key", () => {
  const result = verifyDemandDeskAuthorization(issue(), expectation({ trustedDemandDeskPubkeys: [key()] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "untrusted_desk");
});

test("refuses one-byte instruction drift and additional instructions", () => {
  const changed = { ...instruction, data: Uint8Array.from([1, 2, 3, 4, 6]) };
  const drift = verifyDemandDeskAuthorization(issue(), expectation({ instructions: [changed] }));
  assert.equal(drift.ok, false);
  assert.equal(drift.code, "instruction_mismatch");

  const extra = verifyDemandDeskAuthorization(issue(), expectation({ instructions: [instruction, instruction] }));
  assert.equal(extra.ok, false);
  assert.equal(extra.code, "instruction_mismatch");
});

test("refuses resource, facilitator, network, recipient, asset, and amount drift", () => {
  for (const field of Object.keys(unsigned().intent) as Array<keyof ReturnType<typeof unsigned>["intent"]>) {
    const intent = { ...unsigned().intent, [field]: field === "amount_units" ? "10001" : `${unsigned().intent[field]}-drift` };
    const result = verifyDemandDeskAuthorization(issue(), expectation({ intent }));
    assert.equal(result.ok, false, field);
    assert.equal(result.code, "intent_mismatch", field);
  }
});

test("refuses vault, program, policy, account membership, and fee drift", () => {
  for (const settlement of [
    { vaultAddress: key(), vaultProgramId: PROGRAM, policyPda: POLICY },
    { vaultAddress: VAULT, vaultProgramId: key(), policyPda: POLICY },
    { vaultAddress: VAULT, vaultProgramId: PROGRAM, policyPda: key() },
  ]) {
    const result = verifyDemandDeskAuthorization(issue(), expectation({ settlement }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "settlement_mismatch");
  }

  const missingRecipient = {
    ...instruction,
    accounts: instruction.accounts.filter((account) => account.pubkey !== RECIPIENT),
  };
  const missingAccount = verifyDemandDeskAuthorization(
    issue(),
    expectation({ instructions: [missingRecipient] }),
  );
  assert.equal(missingAccount.ok, false);
  assert.equal(missingAccount.code, "instruction_mismatch");

  const fee = verifyDemandDeskAuthorization(issue(), expectation({ networkFeeLamports: 10_001 }));
  assert.equal(fee.ok, false);
  assert.equal(fee.code, "fee_exceeded");
});

test("a signed REFUSE never authorizes signing", () => {
  const body = { ...unsigned(), decision: { status: "REFUSE" as const, reason_code: "REFUSE_WASH_THRESHOLD_EXCEEDED" as const } };
  const authorization: DemandDeskAuthorization = {
    ...body,
    signature: sign(null, demandDeskAuthorizationPreimage(body), pair.privateKey).toString("hex"),
  };
  const result = verifyDemandDeskAuthorization(authorization, expectation());
  assert.equal(result.ok, false);
  assert.equal(result.code, "decision_refused");
});

test("strict shape rejects extra fields and malformed key material without throwing", () => {
  const extra = { ...issue(), injected: true };
  const extraResult = verifyDemandDeskAuthorization(extra, expectation());
  assert.equal(extraResult.ok, false);
  if (extraResult.ok) assert.fail("extra field unexpectedly accepted");
  assert.equal(extraResult.code, "invalid_shape");

  const malformed = { ...issue(), demand_desk_pubkey: "not-a-solana-key" };
  const malformedResult = verifyDemandDeskAuthorization(malformed, expectation());
  assert.equal(malformedResult.ok, false);
  if (malformedResult.ok) assert.fail("malformed key unexpectedly accepted");
  assert.equal(malformedResult.code, "invalid_shape");
});
