/**
 * V6 Receipt Freshness & Leaf Tamper Test Suite.
 *
 * Verifies:
 *   1. Pristine signed V6 receipt verifies correctly (leaf match + valid Ed25519 signature).
 *   2. Mutating any leaf-bound field (domain, agent_id, score, timestamp_unix, payer,
 *      settlement_tx, reputation_score, etc.) invalidates the leaf hash and fails signature check.
 *   3. Demonstrates the freshness boundary: unauthenticated freshness fields
 *      (recheck_after_unix, staleness_days, score_decay_model) must NOT be trusted blindly;
 *      relying party validation must enforce age checks against the signed timestamp_unix.
 *
 * Run: npx tsx test/receipt-freshness-tamper.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { base58 } from "@scure/base";
import { keccak256 } from "js-sha3";

function verifyEd25519Signature(
  leafBytes: Uint8Array,
  signatureB58: string,
  pubkeyB58: string,
): boolean {
  try {
    const pubKeyBytes = base58.decode(pubkeyB58);
    const sigBytes = base58.decode(signatureB58);
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiKey = Buffer.concat([spkiPrefix, Buffer.from(pubKeyBytes)]);
    const key = crypto.createPublicKey({ key: spkiKey, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(leafBytes), key, Buffer.from(sigBytes));
  } catch {
    return false;
  }
}

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function i64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}

function payer32(payer: string): Buffer {
  try {
    const raw = Buffer.from(base58.decode(payer));
    if (raw.length === 32) return raw;
  } catch {}
  return crypto.createHash("sha256").update(payer, "utf8").digest();
}

function anchor32(tx?: string | null): Buffer {
  if (!tx) return Buffer.alloc(32);
  const raw = Buffer.from(tx, "utf8");
  if (raw.length >= 32) return raw.subarray(raw.length - 32);
  return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
}

function encodeReputationBlockV6(pre: Record<string, any>): Buffer {
  const optInt = (v: any, enc: (n: any) => Buffer) =>
    v === null || v === undefined
      ? Buffer.from([0x00])
      : Buffer.concat([Buffer.from([0x01]), enc(v)]);

  const optStr = (v: any) => {
    if (v === null || v === undefined) return Buffer.from([0x00]);
    const raw = Buffer.from(String(v), "utf8");
    return Buffer.concat([Buffer.from([0x01]), u16le(raw.length), raw]);
  };

  return Buffer.concat([
    optInt(pre.reputation_score, i64le),
    optInt(pre.reputation_confidence_bps, u16le),
    optStr(pre.reputation_score_version),
    optInt(pre.reputation_feature_window_start_unix, u64le),
    optStr(pre.reputation_data_quality),
  ]);
}

function computeReceiptLeafV6(pre: Record<string, any>): string {
  const domainStr = String(pre.domain || "");
  const isAttention = domainStr.toUpperCase().includes("ATTENTION");
  const scoreVal = isAttention ? (pre.attention_score ?? 0) : (pre.score ?? 0);
  const txVal = pre.settlement_tx || pre.settlement_anchor || "";
  const agent = Buffer.from(String(pre.agent_id || ""), "utf8");

  const parts = [
    Buffer.from(domainStr, "ascii"),
    u16le(agent.length),
    agent,
    u16le(scoreVal),
    u16le(Number(pre.confidence_bps) || 0),
    u64le(pre.timestamp_unix ?? 0),
    payer32(String(pre.payer || "")),
    anchor32(txVal),
    encodeReputationBlockV6(pre),
  ];

  return "0x" + keccak256(Buffer.concat(parts));
}

// Fixture: Canonical signed V6 sample receipt from intel.twzrd.xyz
const SAMPLE_V6_RECEIPT = {
  version: "v6",
  leaf: "0x696bab7f6778236b86c8a88cd537924813331cceaccc99b0a1a4b2eaca934e30",
  preimage: {
    domain: "TWZRD:AO_REPUTATION_RECEIPT_V6",
    agent_id: "11111111111111111111111111111111",
    score: 72,
    attention_score: null,
    confidence_bps: 8000,
    timestamp_unix: 1748736000,
    payer: "11111111111111111111111111111111",
    settlement_anchor: "63656970742d6e6f2d7265616c2d736574746c656d656e742d74782d30303031",
    version: "v6",
    reputation_score: null,
    reputation_confidence_bps: null,
    reputation_score_version: "intel_renorm_v1_1",
    reputation_feature_window_start_unix: null,
    reputation_data_quality: "example",
    recheck_after_unix: 1748995200,
    staleness_days: 3,
    score_decay_model: "step:<=7d=1.0,<=30d=0.8,<=90d=0.5,>90d=0.25",
    settlement_tx: "EXAMPLE-sample-receipt-no-real-settlement-tx-0001",
  },
  signature:
    "5Qvodd8wALaDhJ9fSYUFaYy4Zs18vEt8rswA8HPKBkK96m52TVTnDC8tWmbwyYzxFVQqU5kegLSJk7a9PkA8uLG2",
  signing_pubkey: "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS",
  key_id: "twzrd-receipt-ed25519-v2",
  signing_alg: "ed25519",
};

async function run() {
  console.log("Running V6 Receipt Freshness & Leaf Tamper Test Suite...");

  // 1. Pristine verification
  const pristineLeaf = computeReceiptLeafV6(SAMPLE_V6_RECEIPT.preimage);
  assert.equal(pristineLeaf, SAMPLE_V6_RECEIPT.leaf, "Pristine leaf hash recomputes exactly");

  const leafBytes = Buffer.from(SAMPLE_V6_RECEIPT.leaf.replace(/^0x/, ""), "hex");
  const pristineSigValid = verifyEd25519Signature(
    leafBytes,
    SAMPLE_V6_RECEIPT.signature,
    SAMPLE_V6_RECEIPT.signing_pubkey,
  );
  assert.equal(pristineSigValid, true, "Pristine Ed25519 signature verifies against published key");

  // 2. Tampering each leaf-bound field MUST invalidate the leaf hash and signature check
  const boundFieldsToMutate: Array<{ field: string; value: any }> = [
    { field: "domain", value: "TWZRD:AO_REPUTATION_RECEIPT_V5" },
    { field: "agent_id", value: "22222222222222222222222222222222" },
    { field: "score", value: 99 },
    { field: "confidence_bps", value: 9999 },
    { field: "timestamp_unix", value: 1750000000 },
    { field: "payer", value: "46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe" },
    { field: "settlement_tx", value: "TAMPERED-TRANSACTION-SIGNATURE" },
    { field: "reputation_score", value: 95 },
    { field: "reputation_score_version", value: "intel_renorm_v2_0" },
    { field: "reputation_data_quality", value: "forged" },
  ];

  for (const { field, value } of boundFieldsToMutate) {
    const tamperedPre = { ...SAMPLE_V6_RECEIPT.preimage, [field]: value };
    const tamperedLeaf = computeReceiptLeafV6(tamperedPre);
    assert.notEqual(
      tamperedLeaf,
      SAMPLE_V6_RECEIPT.leaf,
      `Mutating bound field '${field}' must change leaf hash`,
    );

    const tamperedLeafBytes = Buffer.from(tamperedLeaf.replace(/^0x/, ""), "hex");
    const sigValid = verifyEd25519Signature(
      tamperedLeafBytes,
      SAMPLE_V6_RECEIPT.signature,
      SAMPLE_V6_RECEIPT.signing_pubkey,
    );
    assert.equal(
      sigValid,
      false,
      `Mutating bound field '${field}' must fail Ed25519 signature verification`,
    );
  }

  // 3. Freshness field tamper detection:
  // Freshness metadata (recheck_after_unix, staleness_days, score_decay_model) sits outside the leaf.
  // We verify that relying party age checks MUST use timestamp_unix to detect staleness.
  const currentNowSec = Math.floor(Date.now() / 1000);
  const maxAgePolicySec = 86400 * 7; // 7 days

  const receiptAge = currentNowSec - SAMPLE_V6_RECEIPT.preimage.timestamp_unix;
  const isStaleBySignedTimestamp = receiptAge > maxAgePolicySec;
  assert.equal(
    isStaleBySignedTimestamp,
    true,
    "Signed timestamp_unix correctly identifies receipt as stale under a 7-day policy",
  );

  // Even if an attacker forges recheck_after_unix into the far future:
  const forgedFreshnessPre = {
    ...SAMPLE_V6_RECEIPT.preimage,
    recheck_after_unix: currentNowSec + 86400 * 365, // claim fresh for a year
    staleness_days: 0,
  };

  // The leaf is unaffected because freshness fields are non-leaf advisory fields:
  const forgedLeaf = computeReceiptLeafV6(forgedFreshnessPre);
  assert.equal(forgedLeaf, SAMPLE_V6_RECEIPT.leaf);

  // But the policy-compliant verifier checks signed timestamp_unix and rejects the freshness spoof:
  const verifierEvaluatedAge = currentNowSec - forgedFreshnessPre.timestamp_unix;
  assert.ok(
    verifierEvaluatedAge > maxAgePolicySec,
    "Signed timestamp_unix enforces true age despite spoofed recheck_after_unix",
  );

  console.log("receipt-freshness-tamper.test.ts: ALL PASSED (all tamper cases verified)");
}

run().catch((err) => {
  console.error("receipt-freshness-tamper.test.ts FAILED:", err);
  process.exit(1);
});
