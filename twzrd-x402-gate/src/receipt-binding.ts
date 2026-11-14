/**
 * Receipt binding: does this receipt say what its issuer signed?
 *
 * A transparency-log proof says a 32-byte leaf is in the log. It says nothing
 * about the fields printed beside that leaf. This check ties the two together
 * before `requireLogInclusion` asks the log anything:
 *
 *   1. recompute the canonical leaf from `receipt.preimage`;
 *   2. require `receipt.leaf` to equal it;
 *   3. require `receipt.signature` to be an Ed25519 signature over those 32
 *      bytes under a key the caller pinned (default: the receipt issuer key,
 *      key_id `twzrd-receipt-ed25519-v2`).
 *
 * The key is never read from the receipt: `signing_pubkey` and `key_id` are
 * whatever the sender wrote.
 *
 * Accepted leaf formats are the two the paid trust endpoint has issued with the
 * reputation fields inside the leaf: `TWZRD:AO_REPUTATION_RECEIPT_V7` (current)
 * and `TWZRD:AO_REPUTATION_RECEIPT_V6`. V5 leaves `reputation_*` unsigned and
 * the attention domains are a different product; both are refused, as is any
 * other domain. The byte layout mirrors `twzrd-receipt-verifier`. Field types
 * and ranges are checked for both formats before any hashing, so a value that
 * only encodes to the signed bytes (score 65608 for 72, "72" for 72, a number
 * where a string belongs) is refused instead of normalized.
 *
 * What the leaf does not carry, and so this check cannot bind:
 *   - `settlement_tx` beyond its last 32 UTF-8 bytes (the signed anchor);
 *   - on V6, `recheck_after_unix`, `staleness_days`, `score_decay_model`;
 *   - `attention_score` on a reputation receipt, and any field the layout
 *     below does not name.
 * It also does not decide whether the receipt is about the seller being paid
 * or how old it is: those are the caller's policy.
 *
 * Needs `js-sha3` (keccak256), an optional peer. Without it the check fails
 * closed with an install hint.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Receipt issuer key, pinned. Receipts are signed with this key (`twzrd-receipt-ed25519-v2`). */
export const RECEIPT_ISSUER_PUBKEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS";
export const RECEIPT_ISSUER_KEY_ID = "twzrd-receipt-ed25519-v2";

const REPUTATION_V6_DOMAIN = "TWZRD:AO_REPUTATION_RECEIPT_V6";
const REPUTATION_V7_DOMAIN = "TWZRD:AO_REPUTATION_RECEIPT_V7";
const V7_KIND = "twzrd_reputation_receipt_v7";
const MAX_STR_UTF8 = 256;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type ReceiptBinding =
  | {
      ok: true;
      /** The recomputed leaf, 64 lowercase hex chars, no 0x. Equal to `receipt.leaf`. */
      leaf: string;
      version: "v6" | "v7";
      /** The pinned key the signature verified under. */
      pubkey: string;
    }
  | { ok: false; error: string };

type Pre = Record<string, unknown>;

class Refused extends Error {}

function refuse(message: string): never {
  throw new Refused(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Base58 to bytes; null for an empty string or a character outside the alphabet. */
function base58Decode(text: string): Buffer | null {
  if (text.length === 0) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    let carry = B58.indexOf(text[i]!);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

function keccak256(data: Buffer): Buffer {
  let mod: { keccak256: { arrayBuffer(d: Uint8Array): ArrayBuffer } };
  try {
    mod = require("js-sha3");
  } catch {
    throw new Refused(
      "receipt binding needs js-sha3 (keccak256) to recompute the leaf. Install it with: npm i js-sha3",
    );
  }
  return Buffer.from(mod.keccak256.arrayBuffer(data));
}

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

/** A safe integer in [lo, hi]. Absent (null or undefined) is allowed only when not required. */
function int(pre: Pre, name: string, lo: number, hi: number, required: boolean): number | null {
  const v = pre[name];
  if (v === null || v === undefined) {
    if (required) refuse(`preimage.${name} is required`);
    return null;
  }
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) {
    refuse(`preimage.${name} must be an integer in ${lo}..${hi}`);
  }
  return v;
}

/** A well-formed string of at most 256 UTF-8 bytes. Absent is allowed only when not required. */
function str(pre: Pre, name: string, required: boolean): Buffer | null {
  const v = pre[name];
  if (v === null || v === undefined) {
    if (required) refuse(`preimage.${name} is required`);
    return null;
  }
  if (typeof v !== "string") refuse(`preimage.${name} must be a string`);
  const raw = Buffer.from(v, "utf8");
  if (raw.length > MAX_STR_UTF8 || raw.toString("utf8") !== v) {
    refuse(`preimage.${name} must be well-formed UTF-8 of at most ${MAX_STR_UTF8} bytes`);
  }
  return raw;
}

const optInt = (v: number | null, enc: (n: number) => Buffer) =>
  v === null ? Buffer.from([0x00]) : Buffer.concat([Buffer.from([0x01]), enc(v)]);
const optStr = (raw: Buffer | null) =>
  raw === null ? Buffer.from([0x00]) : Buffer.concat([Buffer.from([0x01]), u16le(raw.length), raw]);

/** 32-byte payer: the base58-decoded key when it is one, else sha256 of the text. */
function payer32(payer: string): Buffer {
  const raw = base58Decode(payer);
  if (raw && raw.length === 32) return raw;
  return createHash("sha256").update(payer, "utf8").digest();
}

/** Last 32 UTF-8 bytes of the text, left-padded with zeros when shorter. */
function anchor32(text: string): Buffer {
  const raw = Buffer.from(text, "utf8");
  if (raw.length >= 32) return raw.subarray(raw.length - 32);
  return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
}

/**
 * The 32-byte settlement anchor. `settlement_tx` decides it when present; a
 * `settlement_anchor` beside it has to be those same bytes in lowercase hex,
 * so the two fields cannot disagree.
 */
function settlementAnchor(pre: Pre, v7: boolean): Buffer {
  const tx = pre.settlement_tx;
  const anchor = pre.settlement_anchor;
  if (tx !== null && tx !== undefined && typeof tx !== "string") {
    refuse("preimage.settlement_tx must be a string");
  }
  if (anchor !== null && anchor !== undefined
    && (typeof anchor !== "string" || !/^[0-9a-f]{64}$/.test(anchor))) {
    refuse("preimage.settlement_anchor must be 64 lowercase hex chars");
  }
  if (typeof tx === "string" && tx !== "") {
    if (Buffer.from(tx, "utf8").toString("utf8") !== tx) refuse("preimage.settlement_tx must be well-formed UTF-8");
    const fromTx = anchor32(tx);
    if (typeof anchor === "string" && anchor !== fromTx.toString("hex")) {
      refuse("preimage.settlement_anchor does not match preimage.settlement_tx");
    }
    return fromTx;
  }
  if (typeof anchor === "string") return v7 ? Buffer.from(anchor, "hex") : anchor32(anchor);
  if (v7) refuse("preimage names no settlement_tx and no settlement_anchor");
  return Buffer.alloc(32);
}

/** The V6 leaf: every field of the V6 layout, under the V6 domain. */
function leafV6(pre: Pre, anchor: Buffer): Buffer {
  const agent = str(pre, "agent_id", true)!;
  const score = int(pre, "score", 0, 65535, true)!;
  const confidence = int(pre, "confidence_bps", 0, 10000, true)!;
  const timestamp = int(pre, "timestamp_unix", 0, Number.MAX_SAFE_INTEGER, true)!;
  const payer = pre.payer;
  if (typeof payer !== "string" || payer === "") refuse("preimage.payer must be a non-empty string");
  str(pre, "payer", true);
  return keccak256(Buffer.concat([
    Buffer.from(REPUTATION_V6_DOMAIN, "ascii"),
    u16le(agent.length), agent,
    u16le(score),
    u16le(confidence),
    u64le(timestamp),
    payer32(payer),
    anchor,
    optInt(int(pre, "reputation_score", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false), i64le),
    optInt(int(pre, "reputation_confidence_bps", 0, 65535, false), u16le),
    optStr(str(pre, "reputation_score_version", false)),
    optInt(int(pre, "reputation_feature_window_start_unix", 0, Number.MAX_SAFE_INTEGER, false), u64le),
    optStr(str(pre, "reputation_data_quality", false)),
  ]));
}

/** The V7 freshness block, as the canonical JSON the issuer signs. */
function freshnessV7(pre: Pre): Buffer {
  const timestamp = int(pre, "timestamp_unix", 0, Number.MAX_SAFE_INTEGER, true)!;
  const staleness = int(pre, "staleness_days", 0, 65535, true)!;
  const recheck = int(pre, "recheck_after_unix", 0, Number.MAX_SAFE_INTEGER, true)!;
  if (recheck !== timestamp + staleness * 86400) {
    refuse("preimage.recheck_after_unix must equal timestamp_unix + staleness_days * 86400");
  }
  const model = pre.score_decay_model;
  if (typeof model !== "string" || !/^[\x20-\x7e]{1,256}$/.test(model)) {
    refuse("preimage.score_decay_model must be 1..256 printable ASCII characters");
  }
  return Buffer.from(
    JSON.stringify({ recheck_after_unix: recheck, score_decay_model: model, staleness_days: staleness }),
    "utf8",
  );
}

function versionIs(value: unknown, want: string, required: boolean): boolean {
  if (value === undefined || value === null) return !required;
  return value === want;
}

function recompute(receipt: Record<string, unknown>, pre: Pre): { leaf: Buffer; version: "v6" | "v7" } {
  const domain = pre.domain;
  if (domain === REPUTATION_V7_DOMAIN) {
    if (receipt.kind !== V7_KIND || !versionIs(receipt.version, "v7", true) || !versionIs(pre.version, "v7", true)) {
      refuse("a V7 leaf needs kind twzrd_reputation_receipt_v7 and version v7 on the receipt and its preimage");
    }
    const fresh = freshnessV7(pre);
    const base = leafV6(pre, settlementAnchor(pre, true));
    return {
      leaf: keccak256(Buffer.concat([
        Buffer.from(REPUTATION_V7_DOMAIN, "ascii"), base, u32le(fresh.length), fresh,
      ])),
      version: "v7",
    };
  }
  if (domain === REPUTATION_V6_DOMAIN) {
    if (!versionIs(receipt.version, "v6", false) || !versionIs(pre.version, "v6", false)) {
      refuse("a V6 leaf cannot carry another version label");
    }
    return { leaf: leafV6(pre, settlementAnchor(pre, false)), version: "v6" };
  }
  return refuse(
    `preimage.domain ${typeof domain === "string" ? JSON.stringify(domain.slice(0, 80)) : `(${typeof domain})`} is not a signed reputation receipt this check accepts (V7, V6)`,
  );
}

function ed25519Verifies(leaf: Buffer, signature: Buffer, pubkey: Buffer): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubkey]), format: "der", type: "spki",
    });
    return edVerify(null, leaf, key, signature);
  } catch {
    return false;
  }
}

/**
 * Verify that `receipt` is exactly what one of `pubkeys` signed. Never throws;
 * every failure is `{ ok: false, error }`.
 */
export function verifyReceiptBinding(
  receipt: unknown,
  pubkeys: readonly string[] = [RECEIPT_ISSUER_PUBKEY],
): ReceiptBinding {
  try {
    if (!isRecord(receipt)) refuse("receipt is not an object");
    const pre = receipt.preimage;
    if (!isRecord(pre)) refuse("receipt has no preimage object");
    const named = receipt.leaf;
    if (typeof named !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(named)) {
      refuse("receipt.leaf must be a string of 64 hex chars");
    }
    const sigText = receipt.signature;
    const signature = typeof sigText === "string" ? base58Decode(sigText) : null;
    if (!signature || signature.length !== 64) refuse("receipt.signature must be a base58 64-byte Ed25519 signature");
    if (pubkeys.length === 0) refuse("no receipt issuer key is pinned");
    const keys = pubkeys.map((k) => {
      const raw = typeof k === "string" ? base58Decode(k) : null;
      if (!raw || raw.length !== 32) refuse("a pinned receipt issuer key is not a base58 32-byte Ed25519 key");
      return { text: k, raw };
    });

    const { leaf, version } = recompute(receipt, pre);
    const hex = leaf.toString("hex");
    if (named.replace(/^0x/, "").toLowerCase() !== hex) {
      refuse("receipt.leaf does not match the leaf recomputed from the receipt's fields");
    }
    const signer = keys.find((k) => ed25519Verifies(leaf, signature, k.raw));
    if (!signer) refuse("receipt signature does not verify under the pinned receipt issuer key");
    return { ok: true, leaf: hex, version, pubkey: signer.text };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    return { ok: false, error: `receipt binding failed: ${(e as Error)?.message ?? String(e)}` };
  }
}
