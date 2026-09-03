import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { checkEquivocation } from "../src/equivocation.js";
import { STH_DOMAIN_V2, signSth, type SignedTreeHead } from "../src/sth.js";
import { KEY_MODE_SIGN, KEY_MODE_VERIFY_ONLY, type LogKeyDirectory } from "../src/keydir.js";
import { merkleRoot, consistencyProof } from "../src/merkle.js";
import { b58encode, bytesToHex } from "../src/util.js";

const kpOld = nacl.sign.keyPair();
const kpNew = nacl.sign.keyPair();
const LOG_ID = "intel.twzrd.xyz/v6";
const ROTATION = 5000;

const dir: LogKeyDirectory = {
  version: 1,
  log_id: LOG_ID,
  keys: [
    {
      key_id: "twzrd-log-ed25519-v1",
      public_key: b58encode(kpOld.publicKey),
      mode: KEY_MODE_VERIFY_ONLY,
      not_before_unix: 0,
      not_after_unix: ROTATION,
    },
    {
      key_id: "twzrd-log-ed25519-v2",
      public_key: b58encode(kpNew.publicKey),
      mode: KEY_MODE_SIGN,
      not_before_unix: ROTATION,
      not_after_unix: null,
    },
  ],
};

const entries = Array.from({ length: 100 }, (_, i) => {
  const e = new Uint8Array(32);
  for (let j = 0; j < 32; j++) e[j] = (i * 37 + j * 11 + 3) & 0xff;
  return e;
});
const forked = entries.map((e) => e.slice());
forked[9][0] ^= 0x01;

function head(size: number, ts: number, list = entries): SignedTreeHead {
  const retired = ts < ROTATION;
  return signSth(
    {
      domain: STH_DOMAIN_V2,
      log_id: LOG_ID,
      key_id: retired ? "twzrd-log-ed25519-v1" : "twzrd-log-ed25519-v2",
      tree_size: size,
      timestamp_unix: ts,
      root: bytesToHex(merkleRoot(list.slice(0, size))),
    },
    retired ? kpOld.secretKey : kpNew.secretKey,
  );
}

const proofFor = (oldSize: number, newSize: number, list = entries) =>
  consistencyProof(list.slice(0, newSize), oldSize).map(bytesToHex);

test("consistency_verified is a value, not a message to grep", () => {
  const verified = checkEquivocation(head(40, 6000), head(90, 7000), dir, proofFor(40, 90));
  assert.equal(verified.consistency_verified, true);
  assert.equal(verified.equivocation, false);

  const disproven = checkEquivocation(head(40, 6000, forked), head(90, 7000), dir, proofFor(40, 90));
  assert.equal(disproven.consistency_verified, false, "a failed proof is disproven, not unknown");
  assert.equal(disproven.equivocation, true);

  const notSupplied = checkEquivocation(head(40, 6000), head(90, 7000), dir);
  assert.equal(notSupplied.consistency_verified, undefined, "no proof supplied is not a verdict");
  assert.equal(notSupplied.equivocation, false);

  const malformed = checkEquivocation(head(40, 6000), head(90, 7000), dir, ["zz"]);
  assert.equal(malformed.consistency_verified, undefined, "undecodable is not a verdict");
  assert.equal(malformed.equivocation, false);
  assert.ok(malformed.errors.length > 0);
});

test("cross_key is reported for heads spanning a rotation", () => {
  const preRotation = head(50, 1000);
  const postRotation = head(50, 9000);
  assert.equal(preRotation.key_id, "twzrd-log-ed25519-v1");
  assert.equal(postRotation.key_id, "twzrd-log-ed25519-v2");

  // Same size, same root, different keys: honest re-signing, not equivocation.
  const same = checkEquivocation(preRotation, postRotation, dir);
  assert.equal(same.cross_key, true);
  assert.equal(same.equivocation, false);

  // Same size, different roots, different keys: still convicts.
  const forkedPost = head(50, 9000, forked);
  const conflict = checkEquivocation(preRotation, forkedPost, dir);
  assert.equal(conflict.cross_key, true);
  assert.equal(conflict.equivocation, true);
  assert.equal(conflict.proof?.key_id_a, "twzrd-log-ed25519-v1");
  assert.equal(conflict.proof?.key_id_b, "twzrd-log-ed25519-v2");
  assert.match(conflict.reason, /rotation does not excuse it/);
});

test("an invalid signature is never reported as equivocation", () => {
  const good = head(50, 6000);
  const tampered = { ...head(50, 6000, forked), signature: good.signature };
  const res = checkEquivocation(good, tampered, dir);
  assert.equal(res.equivocation, false, "unattributable heads convict nobody");
  assert.ok(res.errors.length > 0);
  assert.match(res.reason, /not attributable/);
});
