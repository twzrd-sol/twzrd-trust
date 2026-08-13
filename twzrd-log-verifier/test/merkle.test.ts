import { test } from "node:test";
import assert from "node:assert/strict";
import sha3 from "js-sha3";
import {
  KECCAK_EMPTY,
  emptyRoot,
  leafHash,
  nodeHash,
  merkleRoot,
  inclusionProof,
  consistencyProof,
  verifyInclusion,
  verifyConsistency,
} from "../src/merkle.js";
import { bytesToHex } from "../src/util.js";

const { keccak256 } = sha3;

function makeEntries(n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const e = new Uint8Array(32);
    for (let j = 0; j < 32; j++) e[j] = (i * 131 + j * 17 + 7) & 0xff;
    out.push(e);
  }
  return out;
}

test("keccak backend matches the pinned empty-string digest", () => {
  assert.equal(keccak256(""), KECCAK_EMPTY);
  assert.equal(bytesToHex(emptyRoot()), KECCAK_EMPTY);
});

test("single-leaf tree root is the leaf hash", () => {
  const [e] = makeEntries(1);
  assert.deepEqual(merkleRoot([e]), leafHash(e));
});

test("two-leaf tree root is NodeHash(LeafHash(a), LeafHash(b))", () => {
  const [a, b] = makeEntries(2);
  assert.deepEqual(merkleRoot([a, b]), nodeHash(leafHash(a), leafHash(b)));
});

test("inclusion proofs verify for every leaf, sizes 1..130", () => {
  for (let n = 1; n <= 130; n++) {
    const entries = makeEntries(n);
    const root = merkleRoot(entries);
    for (let i = 0; i < n; i++) {
      const proof = inclusionProof(entries, i);
      assert.ok(
        verifyInclusion(entries[i], i, n, proof, root),
        `inclusion failed at n=${n} i=${i}`,
      );
    }
  }
});

test("inclusion rejects wrong index, wrong size, tampered leaf, wrong root", () => {
  const n = 100;
  const entries = makeEntries(n);
  const root = merkleRoot(entries);
  const proof = inclusionProof(entries, 37);

  assert.ok(!verifyInclusion(entries[37], 38, n, proof, root), "wrong index accepted");
  // (tree_size, root) travel as a bound pair inside one signed STH; a proof for
  // the current head must not verify against an older head's pair.
  assert.ok(
    !verifyInclusion(entries[37], 37, n - 1, proof, merkleRoot(entries.slice(0, n - 1))),
    "older head accepted",
  );
  assert.ok(!verifyInclusion(entries[37], 37, n, proof, merkleRoot(entries.slice(0, 99))), "wrong root accepted");

  const tampered = entries[37].slice();
  tampered[31] ^= 0x01;
  assert.ok(!verifyInclusion(tampered, 37, n, proof, root), "tampered leaf accepted");

  const truncated = proof.slice(0, proof.length - 1);
  assert.ok(!verifyInclusion(entries[37], 37, n, truncated, root), "truncated path accepted");
});

test("inclusion rejects out-of-range indexes and oversized paths", () => {
  const entries = makeEntries(4);
  const root = merkleRoot(entries);
  const proof = inclusionProof(entries, 0);
  assert.ok(!verifyInclusion(entries[0], -1, 4, proof, root));
  assert.ok(!verifyInclusion(entries[0], 4, 4, proof, root));
  const tooDeep = Array.from({ length: 33 }, () => new Uint8Array(32));
  assert.ok(!verifyInclusion(entries[0], 0, 4, tooDeep, root));
});

test("consistency proofs verify for all 0 <= m <= n <= 66", () => {
  const max = 66;
  const entries = makeEntries(max);
  for (let n = 1; n <= max; n++) {
    const newRoot = merkleRoot(entries.slice(0, n));
    for (let m = 0; m <= n; m++) {
      const proof = consistencyProof(entries.slice(0, n), m);
      const oldRoot = merkleRoot(entries.slice(0, m));
      assert.ok(
        verifyConsistency(m, oldRoot, n, newRoot, proof),
        `consistency failed at m=${m} n=${n}`,
      );
    }
  }
});

test("consistency rejects rewritten history", () => {
  const entries = makeEntries(90);
  const newRoot = merkleRoot(entries);
  const proof = consistencyProof(entries, 50);

  const forged = entries.slice(0, 50).map((e) => e.slice());
  forged[10][0] ^= 0x01;
  const forgedOldRoot = merkleRoot(forged);
  assert.ok(!verifyConsistency(50, forgedOldRoot, 90, newRoot, proof), "forged old root accepted");

  assert.ok(!verifyConsistency(49, merkleRoot(entries.slice(0, 49)), 90, newRoot, proof), "wrong old size accepted");
});

test("consistency trivial cases", () => {
  const entries = makeEntries(8);
  const root = merkleRoot(entries);
  // same size, same root, empty proof: valid
  assert.ok(verifyConsistency(8, root, 8, root, []));
  // same size, different root: invalid even with empty proof
  assert.ok(!verifyConsistency(8, merkleRoot(entries.slice(0, 7)), 8, root, []));
  // from empty tree: always consistent with empty proof
  assert.ok(verifyConsistency(0, merkleRoot([]), 8, root, []));
  // growth with an empty proof: invalid
  assert.ok(!verifyConsistency(4, merkleRoot(entries.slice(0, 4)), 8, root, []));
  // second smaller than first: invalid
  assert.ok(!verifyConsistency(8, root, 4, merkleRoot(entries.slice(0, 4)), []));
});
