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

test("refuses even a one-millisecond future issuance by default", () => {
  const body = { ...unsigned(), issued_at_ms: NOW + 1 };
  const token: DemandDeskAuthorization = {
    ...body,
    signature: sign(null, demandDeskAuthorizationPreimage(body), pair.privateKey).toString("hex"),
  };
  const result = verifyDemandDeskAuthorization(token, expectation());
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_yet_valid");
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

// 2.1.0: capped Compute Budget instructions and one signed Memo before the spend.
const MEMO_TEXT = "twzrd-domain:example.com";
const memoDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const cuLimit = (units: number): SolanaInstructionForAuthorization => {
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(units, 1);
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
};
const cuPrice = (microLamports: bigint): SolanaInstructionForAuthorization => {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(microLamports, 1);
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
};
const memoIx = (bytes: Uint8Array = Buffer.from(MEMO_TEXT)): SolanaInstructionForAuthorization =>
  ({ programId: MEMO_PROGRAM_ID, accounts: [], data: bytes });

function issueV2_1(constraints: Partial<DemandDeskSettlementConstraintsV2_1> = {}): DemandDeskAuthorization {
  const base = unsigned();
  const body: UnsignedDemandDeskAuthorization = {
    ...base,
    contract_version: DEMAND_DESK_AUTHORIZATION_VERSION_2_1,
    settlement_constraints: {
      ...base.settlement_constraints,
      memo_sha256: memoDigest(Buffer.from(MEMO_TEXT)),
      max_compute_unit_limit: 200_000,
      ...constraints,
    },
  };
  return { ...body, signature: sign(null, demandDeskAuthorizationPreimage(body), pair.privateKey).toString("hex") };
}

const noMemo = { memo_sha256: null };
const codeOf = (result: DemandDeskAuthorizationVerification) => (result.ok ? "ok" : result.code);

test("2.0.0 still refuses a Compute Budget or Memo instruction beside the spend", () => {
  for (const before of [[cuLimit(40_000)], [memoIx()], [cuLimit(40_000), cuPrice(1n), memoIx()]]) {
    const result = verifyDemandDeskAuthorization(issue(), expectation({ instructions: [...before, instruction] }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "instruction_mismatch");
  }
});

test("2.1.0 accepts the spend after every ordered subset of [limit, price, memo]", () => {
  const shapes: Array<[SolanaInstructionForAuthorization[], boolean]> = [
    [[], false],
    [[memoIx()], true],
    [[cuLimit(40_000)], false],
    [[cuLimit(40_000), memoIx()], true],
    [[cuLimit(40_000), cuPrice(2_500n)], false],
    [[cuLimit(40_000), cuPrice(2_500n), memoIx()], true],
  ];
  for (const [before, withMemo] of shapes) {
    const token = issueV2_1(withMemo ? {} : noMemo);
    const result = verifyDemandDeskAuthorization(token, expectation({ instructions: [...before, instruction] }));
    assert.equal(result.ok, true, `${before.length} ${withMemo} ${JSON.stringify(result)}`);
  }
});

test("2.1.0 binds the memo: present exactly when signed, byte for byte", () => {
  const cases: Array<[DemandDeskAuthorization, SolanaInstructionForAuthorization[]]> = [
    [issueV2_1(noMemo), [memoIx(), instruction]],
    [issueV2_1(), [instruction]],
    [issueV2_1(), [memoIx(Buffer.from(`${MEMO_TEXT}x`)), instruction]],
    [issueV2_1(), [{ ...memoIx(), accounts: [{ pubkey: AGENT, isSigner: true, isWritable: false }] }, instruction]],
    [issueV2_1(), [{ ...memoIx(), programId: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo" }, instruction]],
  ];
  for (const bytes of [Buffer.from("café"), Buffer.from("tab\there"), Buffer.alloc(513, 0x61)]) {
    // A digest that matches is still refused when the bytes are not a settlement memo.
    cases.push([issueV2_1({ memo_sha256: memoDigest(bytes) }), [memoIx(bytes), instruction]]);
  }
  for (const [token, instructions] of cases) {
    const result = verifyDemandDeskAuthorization(token, expectation({ instructions }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "instruction_mismatch");
  }
  const longest = Buffer.alloc(512, 0x61);
  const accepted = verifyDemandDeskAuthorization(issueV2_1({ memo_sha256: memoDigest(longest) }),
    expectation({ instructions: [memoIx(longest), instruction] }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("2.1.0 refuses reordered, repeated, extra, and malformed Compute Budget slots", () => {
  const token = issueV2_1(noMemo);
  const heapFrame: SolanaInstructionForAuthorization = { programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: Buffer.from([1, 0, 0, 1, 0]) };
  const keyed = { ...cuLimit(40_000), accounts: [{ pubkey: AGENT, isSigner: false, isWritable: false }] };
  const long = { ...cuLimit(40_000), data: Buffer.concat([Buffer.from(cuLimit(40_000).data), Buffer.from([0])]) };
  for (const instructions of [
    [cuPrice(1n), cuLimit(40_000), instruction],
    [cuLimit(40_000), cuLimit(40_000), instruction],
    [cuPrice(1n), instruction],
    [heapFrame, instruction],
    [keyed, instruction],
    [long, instruction],
    [cuLimit(40_000), { ...cuPrice(1n), data: Buffer.from(cuPrice(1n).data).subarray(0, 5) }, instruction],
    [instruction, cuLimit(40_000)],
    [cuLimit(40_000)],
    [],
  ]) {
    const result = verifyDemandDeskAuthorization(token, expectation({ instructions }));
    assert.equal(result.ok, false, JSON.stringify(instructions.map((i) => [i.programId, i.data[0]])));
    assert.equal(result.code, "instruction_mismatch");
  }
  const memoToken = issueV2_1();
  for (const instructions of [
    [memoIx(), cuLimit(40_000), instruction],
    [memoIx(), memoIx(), instruction],
    [cuLimit(40_000), memoIx(), cuPrice(1n), instruction],
  ]) {
    const result = verifyDemandDeskAuthorization(memoToken, expectation({ instructions }));
    assert.equal(result.ok, false);
    assert.equal(result.code, "instruction_mismatch");
  }
});

test("2.1.0 caps the unit limit and counts the priority fee against the signed fee cap", () => {
  const over = verifyDemandDeskAuthorization(issueV2_1({ ...noMemo, max_compute_unit_limit: 50_000 }),
    expectation({ instructions: [cuLimit(50_001), instruction] }));
  assert.equal(over.ok, false);
  assert.equal(over.code, "instruction_mismatch");
  const zero = verifyDemandDeskAuthorization(issueV2_1(noMemo), expectation({ instructions: [cuLimit(0), instruction] }));
  assert.equal(codeOf(zero), "instruction_mismatch");
  const none = verifyDemandDeskAuthorization(issueV2_1({ ...noMemo, max_compute_unit_limit: 0 }),
    expectation({ instructions: [cuLimit(1), instruction] }));
  assert.equal(codeOf(none), "instruction_mismatch");

  // Base 5,000 + ceil(200,000 * 25,000 / 1e6) = 10,000 lamports, exactly the signed cap.
  const atCap = verifyDemandDeskAuthorization(issueV2_1(noMemo),
    expectation({ instructions: [cuLimit(200_000), cuPrice(25_000n), instruction] }));
  assert.equal(atCap.ok, true, JSON.stringify(atCap));
  // ceil(200,000 * 25,001 / 1e6) = 5,001, one lamport over.
  const overCap = verifyDemandDeskAuthorization(issueV2_1(noMemo),
    expectation({ instructions: [cuLimit(200_000), cuPrice(25_001n), instruction] }));
  assert.equal(overCap.ok, false);
  assert.equal(overCap.code, "fee_exceeded");
  const huge = verifyDemandDeskAuthorization(issueV2_1(noMemo),
    expectation({ instructions: [cuLimit(1), cuPrice(2n ** 64n - 1n), instruction] }));
  assert.equal(codeOf(huge), "fee_exceeded");
});

test("2.1.0 signs the memo digest and unit ceiling, and each version keeps its exact fields", () => {
  for (const mutate of [
    (a: DemandDeskAuthorization) => { (a.settlement_constraints as DemandDeskSettlementConstraintsV2_1).memo_sha256 = "cd".repeat(32); },
    (a: DemandDeskAuthorization) => { (a.settlement_constraints as DemandDeskSettlementConstraintsV2_1).max_compute_unit_limit += 1; },
  ]) {
    const token = structuredClone(issueV2_1());
    mutate(token);
    const result = verifyDemandDeskAuthorization(token, expectation({ instructions: [memoIx(), instruction] }));
    assert.equal(codeOf(result), "signature_invalid");
  }

  const oldWithNewField = { ...issue(), settlement_constraints: { ...issue().settlement_constraints, memo_sha256: null } };
  assert.equal(codeOf(verifyDemandDeskAuthorization(oldWithNewField, expectation())), "invalid_shape");
  const v2_1 = issueV2_1();
  const { memo_sha256: _dropped, ...withoutDigest } = v2_1.settlement_constraints as DemandDeskSettlementConstraintsV2_1;
  assert.equal(codeOf(verifyDemandDeskAuthorization({ ...v2_1, settlement_constraints: withoutDigest }, expectation())), "invalid_shape");
  const badDigest = { ...v2_1, settlement_constraints: { ...v2_1.settlement_constraints, memo_sha256: "zz" } };
  assert.equal(codeOf(verifyDemandDeskAuthorization(badDigest, expectation())), "invalid_shape");
  const later = { ...issue(), contract_version: "2.2.0-demand-desk" };
  assert.equal(codeOf(verifyDemandDeskAuthorization(later, expectation())), "unsupported_version");
});
