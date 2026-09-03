import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  STH_DOMAIN_V1,
  STH_DOMAIN_V2,
  encodeSthPreimage,
  signSth,
  verifySth,
  type SignedTreeHead,
} from "../src/sth.js";
import { KEY_MODE_SIGN, KEY_MODE_VERIFY_ONLY, type LogKeyDirectory } from "../src/keydir.js";
import { b58encode, bytesToHex } from "../src/util.js";
import { merkleRoot } from "../src/merkle.js";

const kpOld = nacl.sign.keyPair();
const kpNew = nacl.sign.keyPair();
const LOG_ID = "intel.twzrd.xyz/v6";
const ROTATION = 2000;

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

const root = bytesToHex(merkleRoot([new Uint8Array(32), new Uint8Array(32).fill(9)]));

function headV2(keyId: string, ts: number, secret: Uint8Array, size = 2): SignedTreeHead {
  return signSth(
    { domain: STH_DOMAIN_V2, log_id: LOG_ID, key_id: keyId, tree_size: size, timestamp_unix: ts, root },
    secret,
  );
}

test("current head verifies against the directory", () => {
  const res = verifySth(headV2("twzrd-log-ed25519-v2", 5000, kpNew.secretKey), dir);
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.equal(res.key_id, "twzrd-log-ed25519-v2");
  assert.equal(res.key_mode, KEY_MODE_SIGN);
  assert.equal(res.trusted_pubkey, b58encode(kpNew.publicKey));
});

test("retiring a key is not retroactive repudiation", () => {
  // A head signed before the rotation must keep verifying forever — that is the
  // whole point of a log that outlives its keys.
  const res = verifySth(headV2("twzrd-log-ed25519-v1", 1000, kpOld.secretKey), dir);
  assert.ok(res.valid);
  assert.equal(res.key_mode, KEY_MODE_VERIFY_ONLY);
});

test("a retired key cannot sign outside its window", () => {
  const res = verifySth(headV2("twzrd-log-ed25519-v1", 9000, kpOld.secretKey), dir);
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /outside the validity window/);
});

test("a head cannot be backdated into a window its key never held", () => {
  const res = verifySth(headV2("twzrd-log-ed25519-v2", 500, kpNew.secretKey), dir);
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /outside the validity window/);
});

test("key_id is bound into the signature and cannot be relabelled", () => {
  const head = headV2("twzrd-log-ed25519-v2", 5000, kpNew.secretKey);
  const relabelled = { ...head, key_id: "twzrd-log-ed25519-v1" };
  assert.ok(!verifySth(relabelled, dir).valid, "relabelled key_id must not verify");
  // ...and the preimage genuinely differs, not just the resolved key.
  assert.notDeepEqual(
    encodeSthPreimage(head),
    encodeSthPreimage({ ...head, key_id: "twzrd-log-ed25519-v1" }),
  );
});

test("unknown key_id is rejected with the known ids listed", () => {
  const res = verifySth(headV2("twzrd-log-ed25519-v9", 5000, kpNew.secretKey), dir);
  assert.ok(!res.valid);
  assert.match(res.errors[0], /not in the pinned key directory/);
});

test("a directory for a different log rejects the head", () => {
  const res = verifySth(headV2("twzrd-log-ed25519-v2", 5000, kpNew.secretKey), {
    ...dir,
    log_id: "someone.else/v1",
  });
  assert.ok(!res.valid);
  assert.match(res.errors[0], /!= pinned directory log_id/);
});

test("V2 requires key_id; V1 refuses to carry an unsigned one", () => {
  assert.throws(
    () =>
      encodeSthPreimage({
        domain: STH_DOMAIN_V2,
        log_id: LOG_ID,
        tree_size: 2,
        timestamp_unix: 5000,
        root,
      }),
    /requires key_id/,
  );
  assert.throws(
    () =>
      encodeSthPreimage({
        domain: STH_DOMAIN_V1,
        log_id: LOG_ID,
        key_id: "twzrd-log-ed25519-v1",
        tree_size: 2,
        timestamp_unix: 5000,
        root,
      }),
    /does not bind key_id/,
  );
});

test("a V1 head cannot be verified against a directory", () => {
  const v1Head = signSth(
    { domain: STH_DOMAIN_V1, log_id: LOG_ID, tree_size: 2, timestamp_unix: 1000, root },
    kpOld.secretKey,
  );
  const res = verifySth(v1Head, dir);
  assert.ok(!res.valid);
  assert.match(res.errors[0], /carries no key_id/);
  // ...but still verifies against a bare pinned key, so v0.1 users are not broken.
  assert.ok(verifySth(v1Head, b58encode(kpOld.publicKey)).valid);
});

test("V2 heads also verify against a single pinned key (no directory)", () => {
  const head = headV2("twzrd-log-ed25519-v2", 5000, kpNew.secretKey);
  const res = verifySth(head, b58encode(kpNew.publicKey));
  assert.ok(res.valid);
  assert.equal(res.key_id, "twzrd-log-ed25519-v2");
});
