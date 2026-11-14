#!/usr/bin/env node
/**
 * Check a TWZRD receipt's Ed25519 signature with Node's standard library only.
 *
 * No TWZRD code, no npm install, no network. It checks one thing: that
 * `receipt.signature` is a valid Ed25519 signature, by the key YOU pass, over
 * the 32 raw bytes of `receipt.leaf`. It does not recompute the leaf from the
 * preimage, so it cannot tell whether a field was edited: that needs the leaf
 * layout and Keccak-256, which many Node releases do not ship.
 * `twzrd-receipt-verifier` does both. See docs/verify-intel-receipt.md.
 *
 * Usage:
 *   node docs/proofs/examples/verify-receipt-signature.mjs <receipt.json> <base58 public key>
 *
 * The key comes from your own pin, never from the receipt: a forged receipt
 * names its forger's key in `signing_pubkey`.
 *
 * Exit code: 0 valid, 1 invalid, 2 usage or malformed input.
 */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text) {
  let n = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(ch)}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const leadingZeros = text.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(leadingZeros), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
}

function fail(message) {
  console.error(`verify-receipt-signature: ${message}`);
  process.exit(2);
}

const [file, pinnedKey] = process.argv.slice(2);
if (!file || !pinnedKey) fail("usage: verify-receipt-signature.mjs <receipt.json> <base58 public key>");

let receipt, publicKey, leaf, signature;
try {
  receipt = JSON.parse(readFileSync(file, "utf8"));
  publicKey = base58Decode(pinnedKey);
  leaf = Buffer.from(String(receipt.leaf ?? "").replace(/^0x/, ""), "hex");
  signature = base58Decode(String(receipt.signature ?? ""));
} catch (e) {
  fail(e.message);
}
if (publicKey.length !== 32) fail(`public key must decode to 32 bytes, got ${publicKey.length}`);
if (leaf.length !== 32) fail(`receipt.leaf must be 32 bytes of hex, got ${leaf.length}`);
if (signature.length !== 64) fail(`receipt.signature must decode to 64 bytes, got ${signature.length}`);

// RFC 8410 SubjectPublicKeyInfo header for Ed25519, followed by the 32 raw key bytes.
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
const key = createPublicKey({ key: spki, format: "der", type: "spki" });
const ok = verify(null, leaf, key, signature);

console.log(`pinned key : ${pinnedKey}`);
console.log(`leaf       : 0x${leaf.toString("hex")}`);
console.log(`signature  : ${ok ? "VALID" : "INVALID"} (Ed25519 over the 32 leaf bytes)`);
process.exit(ok ? 0 : 1);
