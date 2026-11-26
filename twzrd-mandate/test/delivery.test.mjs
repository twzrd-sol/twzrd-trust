// Binds a paid response to the payment that bought it, and gates release.
// Pure unit tests: no fetch, no keys on disk, no network.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { bindDelivery, release } from "../dist/delivery.js";

const INTENT = {
  method: "POST",
  url: "https://seller.example/v1/chat/completions",
  bodyHash: "ab".repeat(32),
  payTo: "0xB36e83aB5E6128bC0E1b76b3F59Fe2fD443F0788",
  amountAtomic: "1000",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913",
  model: "paid/gpt-oss-120b",
};
const SETTLEMENT = {
  tx: "0x7ef683c901ec066870a51bfe47b17590cd99bbc1ff848e5d20a361491a1c31a4",
  amountAtomic: "1000",
  payee: "0xB36e83aB5E6128bC0E1b76b3F59Fe2fD443F0788",
  asset: "0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913",
  network: "eip155:8453",
};
const BODY = Buffer.from('{"answer":42}');

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB_RAW = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const signBinding = (intentHash, responseHash, key = privateKey) =>
  crypto.sign(null, Buffer.from(`${intentHash}.${responseHash}`, "utf8"), key).toString("hex");

function bound(overrides = {}) {
  return bindDelivery({
    intent: { ...INTENT, ...(overrides.intent ?? {}) },
    settlement: { ...SETTLEMENT, ...(overrides.settlement ?? {}) },
    body: overrides.body ?? BODY,
    sellerSig: overrides.sellerSig === undefined ? null : overrides.sellerSig,
    requireSigned: overrides.requireSigned,
  });
}

test("a matching settlement binds: intent hash is stable, response hash recorded", () => {
  const a = bound();
  const b = bound();
  assert.equal(a.verified, true);
  assert.equal(a.intentHash, b.intentHash);
  assert.equal(a.responseHash, crypto.createHash("sha256").update(BODY).digest("hex"));
  assert.equal(a.settlementRef, SETTLEMENT.tx);
  assert.equal(a.sellerSigned, false);
});

test("a tampered body changes the binding instead of passing silently", () => {
  const tampered = Buffer.concat([BODY, Buffer.from(" ")]);
  const v = bound({ body: tampered });
  assert.equal(v.verified, true);
  assert.notEqual(v.responseHash, bound().responseHash);
});

test("a settlement that names another payee, amount, asset or network is refused", () => {
  for (const [field, value] of [
    ["payee", "0x0000000000000000000000000000000000000001"],
    ["amountAtomic", "1001"],
    ["asset", "0x0000000000000000000000000000000000000001"],
    ["network", "eip155:1"],
  ]) {
    const v = bound({ settlement: { [field]: value } });
    assert.equal(v.verified, false);
    assert.equal(v.code, "settlement_mismatch", field);
  }
  const badTx = bound({ settlement: { tx: "not-a-hash" } });
  assert.equal(badTx.verified, false);
  assert.equal(badTx.code, "settlement_mismatch");
});

test("a seller signature over (intent, response) verifies against the pinned key", () => {
  const unsigned = bound();
  assert.equal(unsigned.verified, true);
  const sig = {
    kid: "seller-ed25519-v1",
    signatureHex: signBinding(unsigned.intentHash, unsigned.responseHash),
    publicKey: PUB_RAW,
  };
  const v = bound({ sellerSig: sig });
  assert.equal(v.verified, true);
  assert.equal(v.sellerSigned, true);
});

test("a signature from another key, or over tampered bytes, is refused", () => {
  const unsigned = bound();
  const other = crypto.generateKeyPairSync("ed25519");
  const otherPub = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const wrongKey = bound({
    sellerSig: {
      kid: "seller-ed25519-v1",
      signatureHex: signBinding(unsigned.intentHash, unsigned.responseHash, other.privateKey),
      publicKey: PUB_RAW,
    },
  });
  assert.equal(wrongKey.verified, false);
  assert.equal(wrongKey.code, "seller_sig_invalid");
  void otherPub;
  const tamperedSig = bound({
    body: Buffer.concat([BODY, Buffer.from(" ")]),
    sellerSig: {
      kid: "seller-ed25519-v1",
      signatureHex: signBinding(unsigned.intentHash, crypto.createHash("sha256").update(BODY).digest("hex")),
      publicKey: PUB_RAW,
    },
  });
  assert.equal(tamperedSig.verified, false);
  assert.equal(tamperedSig.code, "seller_sig_invalid");
});

test("requireSigned refuses an unsigned delivery instead of returning it unsigned", () => {
  const v = bound({ requireSigned: true });
  assert.equal(v.verified, false);
  assert.equal(v.code, "seller_sig_required");
});

test("release passes a verified delivery through and throws on anything else", () => {
  const v = bound();
  assert.equal(v.verified, true);
  assert.equal(release(v), v);
  for (const bad of [bound({ settlement: { payee: "0x0000000000000000000000000000000000000001" } }), null, undefined, {}, { verified: false, code: "x", detail: "y" }]) {
    assert.throws(() => release(bad), /cannot release an unverified delivery/);
  }
});
