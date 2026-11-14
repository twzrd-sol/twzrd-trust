/**
 * Signed receipts for tests.
 *
 * REAL_RECEIPT and REAL_LOG_INCLUSION are a receipt the paid trust endpoint
 * issued and the inclusion proof the log served for it (leaf index 19 of 20,
 * three audit-path entries, head signed by the pinned log key). They are
 * copies of docs/proofs/intel-receipt/{receipt,log-inclusion}.json, kept here
 * so this package's tests read nothing outside it but the sibling verifier.
 * The receipt is signed by the receipt issuer key, so it binds under the
 * default pin.
 *
 * signTestReceipt() makes a receipt with any fields, signed by a test key
 * (TEST_RECEIPT_PUBKEY). Its leaf builder is written here from the published
 * layout, apart from the one in src/receipt-binding.ts, so the two can
 * disagree.
 *
 * testLogProofFor(leaf) makes a `log_inclusion` block that verifies for any
 * leaf under a test log key (TEST_LOG_PUBKEY): a twelve-leaf tree with the
 * leaf at index 5, built and signed with the sibling verifier's own functions.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { base58 } from "@scure/base";
import { keccak256 } from "js-sha3";

import { inclusionProof, merkleRoot } from "../../../twzrd-log-verifier/src/merkle.js";
import { signSth, STH_DOMAIN_V2 } from "../../../twzrd-log-verifier/src/sth.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

export type Receipt = Record<string, unknown> & { leaf: string; preimage: Record<string, unknown> };

export const REAL_RECEIPT = fixture("intel-receipt-v7.json") as Receipt;
export const REAL_LOG_INCLUSION = fixture("intel-receipt-v7-log-inclusion.json") as Record<string, unknown> & {
  sth: Record<string, unknown>;
};
/** REAL_RECEIPT's leaf, 64 lowercase hex chars. */
export const REAL_LEAF = REAL_RECEIPT.leaf.replace(/^0x/, "");

/** A deep copy of the real receipt with some preimage fields replaced. */
export function realReceiptWith(preimage: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Receipt {
  const copy = structuredClone(REAL_RECEIPT);
  return { ...copy, ...top, preimage: { ...copy.preimage, ...preimage } } as Receipt;
}

// A fixed test key: the seed is a hash of a label, not a secret.
const SEED = createHash("sha256").update("twzrd-x402-gate test receipt issuer").digest();
const PRIVATE = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]), format: "der", type: "pkcs8",
});
export const TEST_RECEIPT_PUBKEY = base58.encode(
  createPublicKey(PRIVATE).export({ format: "der", type: "spki" }).subarray(-32),
);

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const k256 = (b: Buffer) => Buffer.from(keccak256.arrayBuffer(b));
const last32 = (text: string) => {
  const raw = Buffer.from(text, "utf8");
  return raw.length >= 32 ? raw.subarray(raw.length - 32) : Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
};

function v6Leaf(pre: Record<string, any>, anchor: Buffer): Buffer {
  const agent = Buffer.from(pre.agent_id, "utf8");
  let payer: Buffer;
  try {
    payer = Buffer.from(base58.decode(pre.payer));
    if (payer.length !== 32) throw new Error("not a key");
  } catch {
    payer = createHash("sha256").update(pre.payer, "utf8").digest();
  }
  const maybe = (v: unknown, enc: (x: any) => Buffer) =>
    v === null || v === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), enc(v)]);
  const text = (v: string) => { const raw = Buffer.from(v, "utf8"); return Buffer.concat([u16(raw.length), raw]); };
  return k256(Buffer.concat([
    Buffer.from("TWZRD:AO_REPUTATION_RECEIPT_V6", "ascii"),
    u16(agent.length), agent, u16(pre.score), u16(pre.confidence_bps), u64(pre.timestamp_unix), payer, anchor,
    maybe(pre.reputation_score, i64), maybe(pre.reputation_confidence_bps, u16),
    maybe(pre.reputation_score_version, text), maybe(pre.reputation_feature_window_start_unix, u64),
    maybe(pre.reputation_data_quality, text),
  ]));
}

/** The canonical leaf of a preimage whose domain is the V7 or the V6 reputation domain. */
export function testLeaf(pre: Record<string, any>): Buffer {
  const anchor = last32(pre.settlement_tx);
  if (pre.domain === "TWZRD:AO_REPUTATION_RECEIPT_V6") return v6Leaf(pre, anchor);
  const fresh = Buffer.from(JSON.stringify({
    recheck_after_unix: pre.recheck_after_unix, score_decay_model: pre.score_decay_model,
    staleness_days: pre.staleness_days,
  }), "utf8");
  return k256(Buffer.concat([
    Buffer.from("TWZRD:AO_REPUTATION_RECEIPT_V7", "ascii"), v6Leaf(pre, anchor), u32(fresh.length), fresh,
  ]));
}

const SETTLEMENT_TX = "4yRo7sVZPnWdDqfCUGw5ZLVY8sQq2uTt7m2bJx9pA1cKQ3hXnE6rF8vTgYb5uJm2LwPz9aDkS4eRt7yU1iO3pQx";

/**
 * A V7 (default) or V6 receipt signed by the test key. `preimage` replaces
 * fields before the leaf is computed and signed, so the result is genuine for
 * whatever it says.
 */
export function signTestReceipt(preimage: Record<string, unknown> = {}, version: "v7" | "v6" = "v7"): Receipt {
  const timestamp_unix = 1790000000;
  const pre: Record<string, any> = {
    domain: version === "v7" ? "TWZRD:AO_REPUTATION_RECEIPT_V7" : "TWZRD:AO_REPUTATION_RECEIPT_V6",
    agent_id: "SeLLeRWa11et1111111111111111111111111111111",
    score: 72,
    attention_score: null,
    confidence_bps: 8000,
    timestamp_unix,
    payer: "Cswv9ZWHwzv3rypAeW99HBqksKJMmbZdV4FxFYRwymAQ",
    settlement_anchor: last32(SETTLEMENT_TX).toString("hex"),
    version,
    reputation_score: 640,
    reputation_confidence_bps: 7000,
    reputation_score_version: "intel_renorm_v1_1",
    reputation_feature_window_start_unix: 1780000000,
    reputation_data_quality: "x402_solana_merchant_agg",
    recheck_after_unix: timestamp_unix + 3 * 86400,
    staleness_days: 3,
    score_decay_model: "step:<=7d=1.0,<=30d=0.8,<=90d=0.5,>90d=0.25",
    settlement_tx: SETTLEMENT_TX,
    ...preimage,
  };
  if (!("settlement_anchor" in preimage)) pre.settlement_anchor = last32(pre.settlement_tx).toString("hex");
  const leaf = testLeaf(pre);
  return {
    version,
    ...(version === "v7" ? { kind: "twzrd_reputation_receipt_v7" } : {}),
    leaf: `0x${leaf.toString("hex")}`,
    preimage: pre,
    signature: base58.encode(sign(null, leaf, PRIVATE)),
    signing_pubkey: TEST_RECEIPT_PUBKEY,
    key_id: "test-receipt-key",
    signing_alg: "ed25519",
  };
}

// A test log key, made the same way as the test receipt key, from another label.
const LOG_SEED = createHash("sha256").update("twzrd-x402-gate test receipt log").digest();
const LOG_PUBLIC = createPublicKey(createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), LOG_SEED]), format: "der", type: "pkcs8",
})).export({ format: "der", type: "spki" }).subarray(-32);
export const TEST_LOG_PUBKEY = base58.encode(LOG_PUBLIC);

/** A `log_inclusion` block that verifies under TEST_LOG_PUBKEY for `leaf`: index 5 of 12. */
export function testLogProofFor(leaf: string): Record<string, unknown> & { sth: Record<string, unknown> } {
  const mine = Buffer.from(leaf.replace(/^0x/, ""), "hex");
  const entries: Uint8Array[] = Array.from({ length: 12 }, (_, i) =>
    i === 5 ? mine : createHash("sha256").update(`another receipt's leaf ${i}`).digest());
  const sth = signSth(
    {
      domain: STH_DOMAIN_V2, log_id: "test.log/v1", key_id: "test-log-key", tree_size: 12,
      timestamp_unix: 1790000000, root: Buffer.from(merkleRoot(entries)).toString("hex"),
    },
    // tweetnacl's secret key layout: the seed, then the public key.
    Buffer.concat([LOG_SEED, LOG_PUBLIC]),
  );
  return {
    log_id: "test.log/v1",
    leaf: `0x${mine.toString("hex")}`,
    leaf_index: 5,
    tree_size: 12,
    audit_path: inclusionProof(entries, 5).map((h) => `0x${Buffer.from(h).toString("hex")}`),
    sth: sth as unknown as Record<string, unknown>,
  };
}
