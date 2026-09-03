import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { STH_DOMAIN, encodeSthPreimage, signSth, verifySth } from "../src/sth.js";
import { b58encode, bytesToHex } from "../src/util.js";
import { merkleRoot } from "../src/merkle.js";

const kp = nacl.sign.keyPair();
const pub = b58encode(kp.publicKey);

function sampleFields(overrides: Partial<Parameters<typeof signSth>[0]> = {}) {
  return {
    domain: STH_DOMAIN,
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 48213,
    timestamp_unix: 1755072000,
    root: bytesToHex(merkleRoot([new Uint8Array(32)])),
    ...overrides,
  };
}

test("sign/verify round trip", () => {
  const sth = signSth(sampleFields(), kp.secretKey);
  const res = verifySth(sth, pub);
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
});

test("each tampered field invalidates the signature", () => {
  const sth = signSth(sampleFields(), kp.secretKey);
  const tampers: Array<Partial<typeof sth>> = [
    { log_id: "intel.twzrd.xyz/v7" },
    { tree_size: sth.tree_size + 1 },
    { timestamp_unix: sth.timestamp_unix + 1 },
    { root: "0x" + "ab".repeat(32) },
  ];
  for (const t of tampers) {
    const res = verifySth({ ...sth, ...t }, pub);
    assert.ok(!res.valid, `tamper accepted: ${JSON.stringify(t)}`);
  }
});

test("wrong pinned key and mismatched embedded key are rejected", () => {
  const sth = signSth(sampleFields(), kp.secretKey);
  const other = b58encode(nacl.sign.keyPair().publicKey);
  assert.ok(!verifySth(sth, other).valid);
  // embedded signing_pubkey must equal the pinned key exactly
  const res = verifySth({ ...sth, signing_pubkey: other }, pub);
  assert.ok(!res.valid);
  assert.match(res.errors[0], /!= trusted key/);
});

test("malformed fields error instead of verifying", () => {
  const sth = signSth(sampleFields(), kp.secretKey);
  assert.ok(!verifySth({ ...sth, domain: "TWZRD:SOMETHING_ELSE" }, pub).valid);
  assert.ok(!verifySth({ ...sth, root: "zz" }, pub).valid);
  assert.ok(!verifySth({ ...sth, root: "abcd" }, pub).valid); // wrong length
  assert.ok(!verifySth({ ...sth, signature: "not-base58-!!!" }, pub).valid);
  assert.ok(!verifySth({ ...sth, tree_size: -1 }, pub).valid);
  assert.throws(() => encodeSthPreimage(sampleFields({ log_id: "" })));
});

test("preimage is little-endian and domain-prefixed", () => {
  const pre = encodeSthPreimage(sampleFields({ tree_size: 1, timestamp_unix: 0 }));
  const domainBytes = new TextEncoder().encode(STH_DOMAIN);
  assert.deepEqual(pre.slice(0, domainBytes.length), domainBytes);
  // u16le log_id length follows the domain
  const logIdLen = new TextEncoder().encode("intel.twzrd.xyz/v6").length;
  assert.equal(pre[domainBytes.length], logIdLen & 0xff);
  assert.equal(pre[domainBytes.length + 1], 0);
  // tree_size=1 little-endian: first byte 1, rest 0
  const sizeOff = domainBytes.length + 2 + logIdLen;
  assert.equal(pre[sizeOff], 1);
  for (let i = 1; i < 8; i++) assert.equal(pre[sizeOff + i], 0);
});
