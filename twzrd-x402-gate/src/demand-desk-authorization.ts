/**
 * Demand Desk spend authorization v2.
 *
 * The Desk signature is the trust root, but a wallet still compares the signed
 * authorization with its own intent and the exact immutable-vault instruction
 * it is about to sign. Every mismatch fails closed.
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalJson } from "./intent.js";

/** Strict: the message is exactly the vault spend. */
export const DEMAND_DESK_AUTHORIZATION_VERSION = "2.0.0-demand-desk" as const;
/**
 * Adds a signed memo digest and compute-unit ceiling. The message may carry
 * [SetComputeUnitLimit?, SetComputeUnitPrice?, Memo?] before the vault spend.
 */
export const DEMAND_DESK_AUTHORIZATION_VERSION_2_1 = "2.1.0-demand-desk" as const;
export const DEMAND_DESK_AUTHORIZATION_DOMAIN = "twzrd.demand_desk_authorization.v2\n";
export const IMMUTABLE_VAULT_INSTRUCTION_DOMAIN = "twzrd.solana.instruction.v1\n";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
/** SPL Memo v2. Memo v1 and other memo programs are extra instructions. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MAX_SETTLEMENT_MEMO_BYTES = 512;

export const DEMAND_DESK_REASON_CODES = [
  "APPROVED",
  "REFUSE_WASH_THRESHOLD_EXCEEDED",
  "REFUSE_STALE_EVIDENCE",
  "REFUSE_BUDGET_LIMIT_EXCEEDED",
  "REFUSE_UNVERIFIED_FACILITATOR",
  "REFUSE_DESTINATION_MISMATCH",
] as const;

export type DemandDeskReasonCode = (typeof DEMAND_DESK_REASON_CODES)[number];

export type DemandDeskAuthorizationIntent = {
  agent_pubkey: string;
  resource_uri: string;
  facilitator_id: string;
  /** CAIP-2, e.g. Solana mainnet-beta's genesis hash. */
  network: string;
  /** Exact recipient token account, not an unbound merchant label. */
  merchant_recipient: string;
  asset_mint: string;
  amount_units: string;
};

export type DemandDeskEvidenceBinding = {
  wash_score: number;
  /** Unix seconds at which the cited evidence state was evaluated. */
  freshness_epoch_sec: number;
  evidence_digest: string;
  transparency_leaf_index: number;
};

export type DemandDeskSettlementConstraints = {
  vault_address: string;
  vault_program_id: string;
  policy_pda: string;
  instruction_hash: string;
  /** Ceiling for the base fee plus the priority fee the Compute Budget instructions set. */
  max_network_fee_lamports: number;
};

export type DemandDeskSettlementConstraintsV2_1 = DemandDeskSettlementConstraints & {
  /** SHA-256 hex of the one Memo instruction's data bytes, or null when the message carries no Memo. */
  memo_sha256: string | null;
  /** Ceiling for SetComputeUnitLimit. Zero refuses any Compute Budget instruction. */
  max_compute_unit_limit: number;
};

export type DemandDeskAuthorizationDecision = {
  status: "ALLOW" | "REFUSE";
  reason_code: DemandDeskReasonCode;
};

type UnsignedAuthorizationBody<Version, Constraints> = {
  contract_version: Version;
  authorization_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  demand_desk_pubkey: string;
  intent: DemandDeskAuthorizationIntent;
  evidence_binding: DemandDeskEvidenceBinding;
  settlement_constraints: Constraints;
  decision: DemandDeskAuthorizationDecision;
};

export type UnsignedDemandDeskAuthorization =
  | UnsignedAuthorizationBody<typeof DEMAND_DESK_AUTHORIZATION_VERSION, DemandDeskSettlementConstraints>
  | UnsignedAuthorizationBody<typeof DEMAND_DESK_AUTHORIZATION_VERSION_2_1, DemandDeskSettlementConstraintsV2_1>;

export type DemandDeskAuthorization = UnsignedDemandDeskAuthorization & {
  /** Hex or base58 Ed25519 signature over demandDeskAuthorizationPreimage(). */
  signature: string;
};

export type SolanaInstructionAccountForAuthorization = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type SolanaInstructionForAuthorization = {
  programId: string;
  accounts: readonly SolanaInstructionAccountForAuthorization[];
  data: Uint8Array;
};

export type DemandDeskAuthorizationExpectation = {
  /** Local trust configuration. A key carried only by the token is never trusted. */
  trustedDemandDeskPubkeys: readonly string[];
  /** The intent the caller believes it is signing. Compared field-for-field. */
  intent: DemandDeskAuthorizationIntent;
  settlement: {
    vaultAddress: string;
    vaultProgramId: string;
    policyPda: string;
  };
  /**
   * Every instruction of the compiled message, in order. 2.0.0 allows exactly
   * the vault spend; 2.1.0 allows [SetComputeUnitLimit?, SetComputeUnitPrice?,
   * Memo?, vault spend].
   */
  instructions: readonly SolanaInstructionForAuthorization[];
  /** Locally computed base (signature) fee. The verifier adds the priority fee it computes from the message. */
  networkFeeLamports: number;
  /** Locally computed v3 approval receipt commitment, when supplied. */
  receiptHashHex?: string;
  nowMs?: number;
  maxClockSkewMs?: number;
  maxTtlMs?: number;
};

export type DemandDeskAuthorizationFailureCode =
  | "invalid_shape"
  | "unsupported_version"
  | "untrusted_desk"
  | "signature_invalid"
  | "not_yet_valid"
  | "expired"
  | "ttl_exceeded"
  | "decision_refused"
  | "intent_mismatch"
  | "settlement_mismatch"
  | "instruction_mismatch"
  | "fee_exceeded";

export type DemandDeskAuthorizationVerification =
  | { ok: true; authorization: DemandDeskAuthorization }
  | { ok: false; code: DemandDeskAuthorizationFailureCode; message: string };

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32 = /^[0-9a-f]{64}$/i;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/i;
const CAIP_2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const POSITIVE_UNITS = /^[0-9]+$/;
const DEFAULT_CLOCK_SKEW_MS = 0;
const DEFAULT_MAX_TTL_MS = 120_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const TOP_LEVEL_FIELDS = [
  "contract_version",
  "authorization_id",
  "issued_at_ms",
  "expires_at_ms",
  "demand_desk_pubkey",
  "intent",
  "evidence_binding",
  "settlement_constraints",
  "decision",
  "signature",
] as const;
const INTENT_FIELDS = [
  "agent_pubkey",
  "resource_uri",
  "facilitator_id",
  "network",
  "merchant_recipient",
  "asset_mint",
  "amount_units",
] as const;
const EVIDENCE_FIELDS = [
  "wash_score",
  "freshness_epoch_sec",
  "evidence_digest",
  "transparency_leaf_index",
] as const;
const SETTLEMENT_FIELDS = [
  "vault_address",
  "vault_program_id",
  "policy_pda",
  "instruction_hash",
  "max_network_fee_lamports",
] as const;
const SETTLEMENT_FIELDS_V2_1 = [...SETTLEMENT_FIELDS, "memo_sha256", "max_compute_unit_limit"] as const;
const DECISION_FIELDS = ["status", "reason_code"] as const;

function failure(
  code: DemandDeskAuthorizationFailureCode,
  message: string,
): DemandDeskAuthorizationVerification {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeBase58(value: string, maxChars = 128): Uint8Array | null {
  if (!value || value.length > maxChars) return null;
  let n = 0n;
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) return null;
    n = n * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.push(Number(n & 0xffn));
    n >>= 8n;
  }
  body.reverse();
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...body]);
}

function isPubkey(value: unknown): value is string {
  return typeof value === "string" && decodeBase58(value, 44)?.length === 32;
}

function isHttpUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseAuthorization(value: unknown): DemandDeskAuthorization | null {
  if (!isRecord(value) || !hasExactFields(value, TOP_LEVEL_FIELDS)) return null;
  const intent = value.intent;
  const evidence = value.evidence_binding;
  const settlement = value.settlement_constraints;
  const decision = value.decision;
  // Each version has its own exact settlement fields.
  const v2_1 = value.contract_version === DEMAND_DESK_AUTHORIZATION_VERSION_2_1;
  if (
    !isRecord(intent) || !hasExactFields(intent, INTENT_FIELDS) ||
    !isRecord(evidence) || !hasExactFields(evidence, EVIDENCE_FIELDS) ||
    !isRecord(settlement) || !hasExactFields(settlement, v2_1 ? SETTLEMENT_FIELDS_V2_1 : SETTLEMENT_FIELDS) ||
    !isRecord(decision) || !hasExactFields(decision, DECISION_FIELDS)
  ) return null;

  if (
    typeof value.contract_version !== "string" ||
    typeof value.authorization_id !== "string" || !UUID_V4.test(value.authorization_id) ||
    !isSafeNonnegativeInteger(value.issued_at_ms) ||
    !isSafeNonnegativeInteger(value.expires_at_ms) ||
    !isPubkey(value.demand_desk_pubkey) ||
    typeof value.signature !== "string"
  ) return null;

  if (
    !isPubkey(intent.agent_pubkey) ||
    !isHttpUri(intent.resource_uri) ||
    typeof intent.facilitator_id !== "string" || intent.facilitator_id.length < 1 || intent.facilitator_id.length > 128 ||
    typeof intent.network !== "string" || !CAIP_2.test(intent.network) ||
    !isPubkey(intent.merchant_recipient) ||
    !isPubkey(intent.asset_mint) ||
    typeof intent.amount_units !== "string" || !POSITIVE_UNITS.test(intent.amount_units) || BigInt(intent.amount_units) <= 0n
  ) return null;

  if (
    typeof evidence.wash_score !== "number" || !Number.isFinite(evidence.wash_score) || evidence.wash_score < 0 || evidence.wash_score > 1 ||
    !isSafeNonnegativeInteger(evidence.freshness_epoch_sec) ||
    typeof evidence.evidence_digest !== "string" || !HEX_32.test(evidence.evidence_digest) ||
    !isSafeNonnegativeInteger(evidence.transparency_leaf_index)
  ) return null;

  if (
    !isPubkey(settlement.vault_address) ||
    !isPubkey(settlement.vault_program_id) ||
    !isPubkey(settlement.policy_pda) ||
    typeof settlement.instruction_hash !== "string" || !HEX_32.test(settlement.instruction_hash) ||
    !isSafeNonnegativeInteger(settlement.max_network_fee_lamports)
  ) return null;
  if (
    v2_1 && (
      (settlement.memo_sha256 !== null && (typeof settlement.memo_sha256 !== "string" || !HEX_32.test(settlement.memo_sha256))) ||
      !isSafeNonnegativeInteger(settlement.max_compute_unit_limit)
    )
  ) return null;

  if (
    (decision.status !== "ALLOW" && decision.status !== "REFUSE") ||
    typeof decision.reason_code !== "string" ||
    !(DEMAND_DESK_REASON_CODES as readonly string[]).includes(decision.reason_code)
  ) return null;

  return value as DemandDeskAuthorization;
}

function unsignedAuthorization(
  authorization: DemandDeskAuthorization,
): UnsignedDemandDeskAuthorization {
  const { signature: _signature, ...unsigned } = authorization;
  return unsigned;
}

/** Every field except the signature is signed, including identity and expiry. */
export function demandDeskAuthorizationPreimage(
  authorization: UnsignedDemandDeskAuthorization,
): Buffer {
  return Buffer.concat([
    Buffer.from(DEMAND_DESK_AUTHORIZATION_DOMAIN, "utf8"),
    Buffer.from(canonicalJson(authorization), "utf8"),
  ]);
}

function signatureBytes(signature: string): Uint8Array | null {
  if (HEX_SIGNATURE.test(signature)) return Uint8Array.from(Buffer.from(signature, "hex"));
  const decoded = decodeBase58(signature, 90);
  return decoded?.length === 64 ? decoded : null;
}

function verifyAuthorizationSignature(authorization: DemandDeskAuthorization): boolean {
  const rawKey = decodeBase58(authorization.demand_desk_pubkey, 44);
  const signature = signatureBytes(authorization.signature);
  if (!rawKey || rawKey.length !== 32 || !signature) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawKey)]),
      format: "der",
      type: "spki",
    });
    return edVerify(
      null,
      demandDeskAuthorizationPreimage(unsignedAuthorization(authorization)),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

function assertInstruction(instruction: SolanaInstructionForAuthorization): void {
  if (!isPubkey(instruction.programId)) throw new Error("programId is not a Solana public key");
  if (!(instruction.data instanceof Uint8Array)) throw new Error("instruction data is not bytes");
  if (!Array.isArray(instruction.accounts) || instruction.accounts.length === 0) {
    throw new Error("instruction has no accounts");
  }
  for (const account of instruction.accounts) {
    if (!isRecord(account) || !hasExactFields(account, ["pubkey", "isSigner", "isWritable"])) {
      throw new Error("instruction account shape is invalid");
    }
    if (!isPubkey(account.pubkey) || typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean") {
      throw new Error("instruction account value is invalid");
    }
  }
}

/**
 * Deterministic digest of one compiled instruction projection. Account order,
 * signer/writable flags, program id, and data bytes are all committed.
 */
export function immutableVaultInstructionHash(
  instruction: SolanaInstructionForAuthorization,
): string {
  assertInstruction(instruction);
  const projection = {
    program_id: instruction.programId,
    accounts: instruction.accounts.map((account) => ({
      pubkey: account.pubkey,
      is_signer: account.isSigner,
      is_writable: account.isWritable,
    })),
    data_base64: Buffer.from(instruction.data).toString("base64"),
  };
  return createHash("sha256")
    .update(IMMUTABLE_VAULT_INSTRUCTION_DOMAIN)
    .update(canonicalJson(projection))
    .digest("hex");
}

type MessageShape =
  | { ok: true; spend: SolanaInstructionForAuthorization; priorityFeeLamports: bigint }
  | { ok: false; message: string };

function isAccountlessInstruction(instruction: SolanaInstructionForAuthorization): boolean {
  return Array.isArray(instruction.accounts) && instruction.accounts.length === 0 &&
    instruction.data instanceof Uint8Array;
}

function isComputeBudget(instruction: SolanaInstructionForAuthorization | undefined, tag: number): boolean {
  return instruction?.programId === COMPUTE_BUDGET_PROGRAM_ID && instruction.data?.[0] === tag;
}

/**
 * 2.1.0 message shape: [SetComputeUnitLimit?, SetComputeUnitPrice?, Memo?, spend],
 * each slot at most once and in that order. The Memo is committed by its signed
 * digest and the Compute Budget values by the signed caps; the priority fee,
 * ceil(limit * price / 1e6) lamports, is computed here, never taken from a caller.
 */
function messageShapeV2_1(
  instructions: readonly SolanaInstructionForAuthorization[],
  constraints: DemandDeskSettlementConstraintsV2_1,
): MessageShape {
  const refuse = (message: string): MessageShape => ({ ok: false, message });
  let index = 0;
  let limit: number | null = null;
  let price: bigint | null = null;
  let memo: Buffer | null = null;

  if (isComputeBudget(instructions[index], 2)) {
    const instruction = instructions[index]!;
    if (!isAccountlessInstruction(instruction) || instruction.data.length !== 5) {
      return refuse("SetComputeUnitLimit must have no accounts and 5 data bytes");
    }
    limit = Buffer.from(instruction.data).readUInt32LE(1);
    index += 1;
  }
  if (isComputeBudget(instructions[index], 3)) {
    const instruction = instructions[index]!;
    if (!isAccountlessInstruction(instruction) || instruction.data.length !== 9) {
      return refuse("SetComputeUnitPrice must have no accounts and 9 data bytes");
    }
    price = Buffer.from(instruction.data).readBigUInt64LE(1);
    index += 1;
  }
  if (instructions[index]?.programId === MEMO_PROGRAM_ID) {
    const instruction = instructions[index]!;
    if (!isAccountlessInstruction(instruction)) return refuse("The Memo instruction must have no accounts");
    memo = Buffer.from(instruction.data);
    index += 1;
  }
  if (instructions.length !== index + 1) {
    return refuse("Message is not [SetComputeUnitLimit?, SetComputeUnitPrice?, Memo?, vault spend]");
  }

  if (price !== null && limit === null) return refuse("A compute unit price needs a compute unit limit");
  if (limit !== null && (limit < 1 || limit > constraints.max_compute_unit_limit)) {
    return refuse("Compute unit limit exceeds the authorized ceiling");
  }
  if (constraints.memo_sha256 === null) {
    if (memo) return refuse("Authorization binds no memo, but the message carries one");
  } else {
    if (!memo) return refuse("Authorization binds a memo the message does not carry");
    if (memo.length < 1 || memo.length > MAX_SETTLEMENT_MEMO_BYTES || memo.some((byte) => byte < 0x20 || byte > 0x7e)) {
      return refuse("Memo must be 1 to 512 bytes of printable ASCII");
    }
    if (createHash("sha256").update(memo).digest("hex") !== constraints.memo_sha256.toLowerCase()) {
      return refuse("Memo bytes do not match the authorized memo digest");
    }
  }
  const priorityFeeLamports = limit === null || price === null
    ? 0n
    : (BigInt(limit) * price + 999_999n) / 1_000_000n;
  return { ok: true, spend: instructions[index]!, priorityFeeLamports };
}

function sameValue(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/**
 * Offline, fail-closed pre-sign verification. This function does no network or
 * ledger I/O and never invokes a signer.
 */
export function verifyDemandDeskAuthorization(
  value: unknown,
  expected: DemandDeskAuthorizationExpectation,
): DemandDeskAuthorizationVerification {
  try {
    const authorization = parseAuthorization(value);
    if (!authorization) return failure("invalid_shape", "Demand Desk authorization shape is invalid");
    if (
      authorization.contract_version !== DEMAND_DESK_AUTHORIZATION_VERSION &&
      authorization.contract_version !== DEMAND_DESK_AUTHORIZATION_VERSION_2_1
    ) {
      return failure("unsupported_version", "Demand Desk authorization version is unsupported");
    }

    const trusted = new Set(expected.trustedDemandDeskPubkeys.filter(isPubkey));
    if (!trusted.has(authorization.demand_desk_pubkey)) {
      return failure("untrusted_desk", "Demand Desk public key is not locally trusted");
    }
    if (!verifyAuthorizationSignature(authorization)) {
      return failure("signature_invalid", "Demand Desk authorization signature is invalid");
    }

    const now = expected.nowMs ?? Date.now();
    const skew = expected.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    const maxTtl = expected.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    if (!isSafeNonnegativeInteger(now) || !isSafeNonnegativeInteger(skew) || !isSafeNonnegativeInteger(maxTtl)) {
      return failure("invalid_shape", "Authorization verification clock configuration is invalid");
    }
    if (authorization.issued_at_ms > now + skew) {
      return failure("not_yet_valid", "Demand Desk authorization was issued in the future");
    }
    if (authorization.expires_at_ms <= now) {
      return failure("expired", "Demand Desk authorization is expired");
    }
    if (
      authorization.expires_at_ms <= authorization.issued_at_ms ||
      authorization.expires_at_ms - authorization.issued_at_ms > maxTtl
    ) {
      return failure("ttl_exceeded", "Demand Desk authorization lifetime exceeds policy");
    }
    if (authorization.evidence_binding.freshness_epoch_sec * 1000 > authorization.issued_at_ms + skew) {
      return failure("invalid_shape", "Evidence freshness timestamp is later than authorization issuance");
    }

    if (authorization.decision.status !== "ALLOW" || authorization.decision.reason_code !== "APPROVED") {
      return failure("decision_refused", `Demand Desk refused: ${authorization.decision.reason_code}`);
    }
    if (!sameValue(authorization.intent, expected.intent)) {
      return failure("intent_mismatch", "Demand Desk authorization does not match the local payment intent");
    }

    const constraints = authorization.settlement_constraints;
    if (
      constraints.vault_address !== expected.settlement.vaultAddress ||
      constraints.vault_program_id !== expected.settlement.vaultProgramId ||
      constraints.policy_pda !== expected.settlement.policyPda
    ) {
      return failure("settlement_mismatch", "Demand Desk authorization does not match local vault constraints");
    }
    let instruction: SolanaInstructionForAuthorization;
    let priorityFeeLamports = 0n;
    if (authorization.contract_version === DEMAND_DESK_AUTHORIZATION_VERSION_2_1) {
      const shape = messageShapeV2_1(expected.instructions, authorization.settlement_constraints);
      if (!shape.ok) return failure("instruction_mismatch", shape.message);
      instruction = shape.spend;
      priorityFeeLamports = shape.priorityFeeLamports;
    } else {
      if (expected.instructions.length !== 1) {
        return failure("instruction_mismatch", "Exactly one immutable-vault instruction is required");
      }
      instruction = expected.instructions[0]!;
    }
    if (instruction.programId !== constraints.vault_program_id) {
      return failure("instruction_mismatch", "Instruction program does not match the authorized vault program");
    }
    const discriminator = createHash("sha256").update("global:spend_with_policy").digest().subarray(0, 8);
    const data = Buffer.from(instruction.data);
    const keys = [constraints.policy_pda, constraints.vault_address,
      authorization.intent.merchant_recipient, authorization.intent.asset_mint,
      authorization.intent.agent_pubkey, authorization.demand_desk_pubkey,
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"];
    if (data.length !== 49 || !data.subarray(0, 8).equals(discriminator) || data[16] !== 0 ||
      data.readBigUInt64LE(8).toString() !== authorization.intent.amount_units ||
      instruction.accounts.length !== 7 || instruction.accounts.some((a, i) =>
        a.pubkey !== keys[i] || a.isSigner !== (i === 4 || i === 5) || a.isWritable !== (i < 3)) ||
      (expected.receiptHashHex !== undefined && data.subarray(17).toString("hex") !== expected.receiptHashHex.toLowerCase())) {
      return failure("instruction_mismatch", "Instruction is not the exact replenishment vault spend");
    }
    const accountKeys = new Set(instruction.accounts.map((account) => account.pubkey));
    for (const required of [
      constraints.vault_address,
      constraints.policy_pda,
      authorization.intent.agent_pubkey,
      authorization.intent.merchant_recipient,
      authorization.intent.asset_mint,
      authorization.demand_desk_pubkey,
    ]) {
      if (!accountKeys.has(required)) {
        return failure("instruction_mismatch", "Immutable-vault instruction is missing an authorized account");
      }
    }
    if (immutableVaultInstructionHash(instruction) !== constraints.instruction_hash.toLowerCase()) {
      return failure("instruction_mismatch", "Immutable-vault instruction hash does not match authorization");
    }
    if (
      !isSafeNonnegativeInteger(expected.networkFeeLamports) ||
      BigInt(expected.networkFeeLamports) + priorityFeeLamports > BigInt(constraints.max_network_fee_lamports)
    ) {
      return failure("fee_exceeded", "Estimated network fee exceeds Demand Desk authorization");
    }

    return { ok: true, authorization };
  } catch {
    return failure("invalid_shape", "Demand Desk authorization or local transaction shape is invalid");
  }
}
