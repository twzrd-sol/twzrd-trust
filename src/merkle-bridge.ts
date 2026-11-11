/*
 * TWZRD — lines-to-leaves Merkle bridge.
 *
 * Deterministic transformation from a local, hash-chain-verified
 * SHA-256 JSONL spend ledger (agent-killswitch `verifyLedgerFile`) to the
 * RFC 6962 (SHA-256 lineage) / RFC 9162 (transparency-log) Keccak-256 tree
 * used by the TWZRD evidence ledger (programs/evidence-ledger on mainnet).
 *
 * This module performs NO I/O beyond hashing, generates NO keys, sends NO
 * transactions and anchors NOTHING. It computes the leaves and the root a
 * later, explicitly authorized step would anchor.
 *
 * Entry-byte rule (normative):
 *   entry_bytes = the exact bytes of the ledger line as written to the
 *   file, excluding a single trailing line terminator (LF, or CRLF).
 *   Everything else — leading/trailing spaces, key order, unicode — is
 *   part of the entry and changes its leaf hash.
 *
 * Hashing (normative):
 *   LeafHash(e) = keccak256(0x00 || e)
 *   NodeHash(l, r) = keccak256(0x01 || l || r)   l, r are 32 bytes
 *   MTH({})     = keccak256("")                 (empty-tree sentinel)
 *   MTH split:  k = largest power of two STRICTLY below n (RFC 6962 §2.1)
 *
 * STH domain: TWZRD:RECEIPT_LOG_STH_V1 is the domain-separation string for
 * the SIGNED TREE HEAD preimage (an Ed25519 precompile instruction
 * immediately preceding anchor_head). It is exported here so callers cannot
 * accidentally sign or hash under the wrong domain; the bridge itself does
 * not construct, sign or broadcast an STH.
 */
import sha3 from "js-sha3";

const { keccak256 } = sha3 as { keccak256: { arrayBuffer: (data: Uint8Array) => ArrayBuffer; (data: string): string } };

export const STH_DOMAIN = "TWZRD:RECEIPT_LOG_STH_V1" as const;
export const LEAF_PREFIX = new Uint8Array([0x00]);
export const NODE_PREFIX = new Uint8Array([0x01]);
export const HASH_LEN = 32;
/** keccak256("") — backend self-test value. */
export const KECCAK_EMPTY =
  "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

function keccak(data: Uint8Array): Uint8Array {
  return new Uint8Array(keccak256.arrayBuffer(data));
}

/** Refuse to run on a broken hash backend. */
export function assertHashBackend(): void {
  if (keccak256("") !== KECCAK_EMPTY) {
    throw new Error("FATAL: keccak256 backend self-test failed");
  }
}

export type ChainReportLike = { ok?: unknown } | null | undefined;

/**
 * Fail closed unless the ledger chain report from agent-killswitch's
 * `verifyLedgerFile` says nothing is broken. The bridge refuses to leaf-hash
 * an unverified ledger: a ledger whose chain is broken, torn or forked must
 * be repaired (or a new log_id chosen) before notarization.
 */
export function assertChainIntact(report: ChainReportLike): asserts report is ChainReportLike & { ok: true } {
  if (!report || typeof report !== "object" || (report as { ok?: unknown }).ok !== true) {
    throw new Error(
      "refusing to build Merkle leaves: ledger chain report is not intact " +
        "(run verifyLedgerFile and require its report.ok === true)",
    );
  }
}

/** entry_bytes = the line's exact bytes minus one trailing LF or CRLF. */
export function lineToEntryBytes(line: string | Buffer | Uint8Array): Uint8Array {
  const bytes =
    typeof line === "string" ? new TextEncoder().encode(line) :
    line instanceof Uint8Array ? line : new Uint8Array(line);
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  }
  return bytes.slice(0, end);
}

export function leafHash(entry: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + entry.length);
  out.set(LEAF_PREFIX, 0);
  out.set(entry, 1);
  return keccak(out);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== HASH_LEN || right.length !== HASH_LEN) {
    throw new Error("nodeHash inputs must be 32 bytes");
  }
  const out = new Uint8Array(1 + 2 * HASH_LEN);
  out.set(NODE_PREFIX, 0);
  out.set(left, 1);
  out.set(right, 1 + HASH_LEN);
  return keccak(out);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Largest power of two strictly less than n (n >= 2). RFC 6962 §2.1. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH over entries[start:end) per RFC 6962 §2.1 (0-indexed, exclusive end). */
function mth(entries: Uint8Array[], start: number, end: number): Uint8Array {
  const n = end - start;
  if (n === 0) return keccak(new Uint8Array(0));
  if (n === 1) return leafHash(entries[start]);
  const k = splitPoint(n);
  return nodeHash(mth(entries, start, start + k), mth(entries, start + k, end));
}

export interface BridgeResult {
  /** Number of leaves. */
  treeSize: number;
  /** keccak256("") when treeSize === 0. */
  root: Uint8Array;
  rootHex: string;
  /** Leaf hashes, hex, in ledger order. leaves[i] commits to lines[i]. */
  leaves: string[];
  /** The only domain tag this bridge exports; used by the (separate) STH step. */
  sthDomain: typeof STH_DOMAIN;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Leaf-hash every validated line and compute the RFC 6962 root.
 *
 * Determinism: identical lines 1..N in the same order always produce an
 * identical root, across runs and machines, with no randomness, timestamps
 * or environment reads. Any change to a line's bytes, order, or the
 * line-ending convention produces a different root.
 */
export function bridgeSpendLedger(
  lines: ReadonlyArray<string | Buffer | Uint8Array>,
  chainReport: ChainReportLike,
): BridgeResult {
  assertHashBackend();
  assertChainIntact(chainReport);
  const entries = lines.map(lineToEntryBytes);
  const leaves = entries.map(leafHash);
  const root = mth(entries, 0, entries.length);
  return {
    treeSize: entries.length,
    root,
    rootHex: hex(root),
    leaves: leaves.map(hex),
    sthDomain: STH_DOMAIN,
  };
}

export { concat };
