import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { checkEquivocation } from "../src/equivocation.js";
import { STH_DOMAIN, signSth } from "../src/sth.js";
import { b58encode, bytesToHex } from "../src/util.js";
import { merkleRoot, consistencyProof } from "../src/merkle.js";

const kp = nacl.sign.keyPair();
const pub = b58encode(kp.publicKey);

function makeEntries(n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const e = new Uint8Array(32);
    for (let j = 0; j < 32; j++) e[j] = (i * 53 + j * 3 + 1) & 0xff;
    out.push(e);
  }
  return out;
}

const entries = makeEntries(80);
const head = (size: number, ts: number, entriesOverride?: Uint8Array[]) =>
  signSth(
    {
      domain: STH_DOMAIN,
      log_id: "intel.twzrd.xyz/v6",
      tree_size: size,
      timestamp_unix: ts,
      root: bytesToHex(merkleRoot((entriesOverride ?? entries).slice(0, size))),
    },
    kp.secretKey,
  );

test("same size, different roots = proven equivocation with proof bundle", () => {
  const forked = entries.map((e) => e.slice());
  forked[3][0] ^= 0x01;
  const res = checkEquivocation(head(50, 100), head(50, 101, forked), pub);
  assert.ok(res.equivocation);
  assert.ok(res.proof);
  assert.equal(res.errors.length, 0);
});

test("same size, same root = consistent", () => {
  const res = checkEquivocation(head(50, 100), head(50, 200), pub);
  assert.ok(!res.equivocation);
});

test("different sizes with a valid consistency proof = consistent", () => {
  const path = consistencyProof(entries, 50).map((b) => bytesToHex(b));
  const res = checkEquivocation(head(80, 300), head(50, 100), pub, path);
  assert.ok(!res.equivocation);
  assert.match(res.reason, /verifies/);
});

test("different sizes with a failing consistency proof = proven equivocation", () => {
  const forked = entries.map((e) => e.slice());
  forked[3][0] ^= 0x01;
  const forkedOld = head(50, 100, forked);
  const path = consistencyProof(entries, 50).map((b) => bytesToHex(b));
  const res = checkEquivocation(forkedOld, head(80, 300), pub, path);
  assert.ok(res.equivocation);
  assert.match(res.reason, /FAILS/);
});

test("different sizes without a proof = unproven, with guidance", () => {
  const res = checkEquivocation(head(50, 100), head(80, 300), pub);
  assert.ok(!res.equivocation);
  assert.match(res.reason, /consistency/);
});

test("invalid signatures are never attributed as equivocation", () => {
  const a = head(50, 100);
  const res = checkEquivocation({ ...a, tree_size: 51 }, head(50, 100), pub);
  assert.ok(!res.equivocation);
  assert.ok(res.errors.length > 0);
});

test("different log_ids are not equivocation", () => {
  const other = signSth(
    {
      domain: STH_DOMAIN,
      log_id: "other.log/v1",
      tree_size: 50,
      timestamp_unix: 100,
      root: bytesToHex(merkleRoot(entries.slice(0, 49))),
    },
    kp.secretKey,
  );
  const res = checkEquivocation(head(50, 100), other, pub);
  assert.ok(!res.equivocation);
  assert.match(res.reason, /different log_id/);
});
