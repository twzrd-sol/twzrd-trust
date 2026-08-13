/*
 * RFC 6962 / RFC 9162 Merkle tree over Keccak-256, per the TWZRD Receipt
 * Transparency spec (docs/transparency-log.md):
 *
 *   MTH({})        = keccak256("")
 *   LeafHash(e)    = keccak256(0x00 || e)     e = 32-byte receipt leaf
 *   NodeHash(l, r) = keccak256(0x01 || l || r)
 *
 * Verification (verifyInclusion / verifyConsistency) is the part relying
 * parties need; generation (merkleRoot / inclusionProof / consistencyProof)
 * is included so proofs are reproducible from an entry list and so tests can
 * exercise verification against an independent construction.
 */
import sha3 from "js-sha3";
import { concatBytes } from "./util.js";

const { keccak256 } = sha3;

export const MAX_PROOF_DEPTH = 32; // matches twzrd-receipt-verifier MAX_PROOF_DEPTH
export const HASH_LEN = 32;
// keccak256("") — refuse to run on a broken hash backend.
export const KECCAK_EMPTY =
  "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

function keccak(data: Uint8Array): Uint8Array {
  return new Uint8Array(keccak256.arrayBuffer(data));
}

export function assertHashBackend(): void {
  if (keccak256("") !== KECCAK_EMPTY) {
    throw new Error("FATAL: keccak256 backend self-test failed");
  }
}

export function emptyRoot(): Uint8Array {
  return keccak(new Uint8Array(0));
}

export function leafHash(entry: Uint8Array): Uint8Array {
  return keccak(concatBytes(LEAF_PREFIX, entry));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== HASH_LEN || right.length !== HASH_LEN) {
    throw new Error("nodeHash inputs must be 32 bytes");
  }
  return keccak(concatBytes(NODE_PREFIX, left, right));
}

/** Largest power of two strictly less than n (n >= 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Merkle tree hash of entries[start:end) per RFC 6962 §2.1. */
function mth(entries: Uint8Array[], start: number, end: number): Uint8Array {
  const n = end - start;
  if (n === 0) return emptyRoot();
  if (n === 1) return leafHash(entries[start]);
  const k = splitPoint(n);
  return nodeHash(mth(entries, start, start + k), mth(entries, start + k, end));
}

export function merkleRoot(entries: Uint8Array[]): Uint8Array {
  return mth(entries, 0, entries.length);
}

/** Inclusion audit path for entries[index] per RFC 6962 §2.1.1 (PATH). */
export function inclusionProof(entries: Uint8Array[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new Error(`leaf index ${index} out of range for tree of ${entries.length}`);
  }
  const path = (start: number, end: number, m: number): Uint8Array[] => {
    const n = end - start;
    if (n === 1) return [];
    const k = splitPoint(n);
    if (m < k) {
      return [...path(start, start + k, m), mth(entries, start + k, end)];
    }
    return [...path(start + k, end, m - k), mth(entries, start, start + k)];
  };
  return path(0, entries.length, index);
}

/** Consistency proof from tree size m to entries.length per RFC 6962 §2.1.2 (PROOF). */
export function consistencyProof(entries: Uint8Array[], oldSize: number): Uint8Array[] {
  const n = entries.length;
  if (!Number.isInteger(oldSize) || oldSize < 0 || oldSize > n) {
    throw new Error(`old size ${oldSize} out of range for tree of ${n}`);
  }
  if (oldSize === 0 || oldSize === n) return [];
  const subproof = (m: number, start: number, end: number, complete: boolean): Uint8Array[] => {
    const size = end - start;
    if (m === size) {
      return complete ? [] : [mth(entries, start, end)];
    }
    const k = splitPoint(size);
    if (m <= k) {
      return [...subproof(m, start, start + k, complete), mth(entries, start + k, end)];
    }
    return [...subproof(m - k, start + k, end, false), mth(entries, start, start + k)];
  };
  return subproof(oldSize, 0, n, true);
}

/**
 * Verify an inclusion proof per RFC 9162 §2.1.3.2.
 *
 * @param entry    the 32-byte log entry (the receipt's keccak leaf bytes)
 * @param index    0-based leaf index claimed by the log
 * @param treeSize tree size the proof targets
 * @param path     audit path, leaf-adjacent first
 * @param root     expected Merkle root (32 bytes)
 */
export function verifyInclusion(
  entry: Uint8Array,
  index: number,
  treeSize: number,
  path: Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || treeSize < 1 || index >= treeSize) return false;
  if (path.length > MAX_PROOF_DEPTH) return false;
  if (root.length !== HASH_LEN) return false;

  let fn = index;
  let sn = treeSize - 1;
  let r = leafHash(entry);
  for (const p of path) {
    if (p.length !== HASH_LEN) return false;
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && bytesEq(r, root);
}

/**
 * Verify a consistency proof per RFC 9162 §2.1.4.2.
 *
 * Proves the tree with `secondRoot` at `secondSize` is an append-only
 * extension of the tree with `firstRoot` at `firstSize`.
 */
export function verifyConsistency(
  firstSize: number,
  firstRoot: Uint8Array,
  secondSize: number,
  secondRoot: Uint8Array,
  path: Uint8Array[],
): boolean {
  if (!Number.isInteger(firstSize) || !Number.isInteger(secondSize)) return false;
  if (firstSize < 0 || secondSize < firstSize) return false;
  if (firstRoot.length !== HASH_LEN || secondRoot.length !== HASH_LEN) return false;
  if (path.length > MAX_PROOF_DEPTH) return false;
  for (const p of path) if (p.length !== HASH_LEN) return false;

  // Trivial cases (RFC 9162 permits empty proofs only here).
  if (firstSize === secondSize) return path.length === 0 && bytesEq(firstRoot, secondRoot);
  if (firstSize === 0) return path.length === 0;
  if (path.length === 0) return false;

  const nodes = [...path];
  // If firstSize is an exact power of two, the first root is itself a node of
  // the second tree; prepend it.
  if ((firstSize & (firstSize - 1)) === 0) nodes.unshift(firstRoot);

  let fn = firstSize - 1;
  let sn = secondSize - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  let fr = nodes[0];
  let sr = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    const c = nodes[i];
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && bytesEq(fr, firstRoot) && bytesEq(sr, secondRoot);
}
