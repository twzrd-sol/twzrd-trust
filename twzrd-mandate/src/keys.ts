/**
 * Ed25519 keys for mandates and heartbeats.
 *
 * Key files are Solana CLI keypair files: a JSON array of 64 numbers (the
 * 32-byte seed followed by the 32-byte public key). A 32-number array (the
 * seed alone) is read too. Public keys are written in base58, as a Solana
 * address is.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { b58decode, b58encode } from "twzrd-log-verifier";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface MandateKey {
  /** base58 public key. */
  readonly publicKey: string;
  sign(message: Uint8Array): Buffer;
}

function privateKeyFromSeed(seed: Uint8Array): crypto.KeyObject {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicKey(key: crypto.KeyObject): Buffer {
  const spki = crypto.createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/** A signing key from a 32-byte seed. */
export function keyFromSeed(seed: Uint8Array): MandateKey {
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = b58encode(rawPublicKey(privateKey));
  return Object.freeze({
    publicKey,
    sign: (message: Uint8Array) => crypto.sign(null, Buffer.from(message), privateKey),
  });
}

/** Decode a base58 Ed25519 public key; null unless it is exactly 32 bytes. */
export function decodePublicKey(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  let bytes: Uint8Array;
  try {
    bytes = b58decode(value);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  // One spelling per key: a value that does not re-encode to itself is refused.
  if (b58encode(bytes) !== value) return null;
  return Buffer.from(bytes);
}

/** Verify an Ed25519 signature under a base58 public key. Never throws. */
export function verifySignature(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  const raw = decodePublicKey(publicKey);
  if (!raw || signature.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Read a Solana-format keypair file. Throws with a message that names the file, never its content. */
export function loadKeyFile(filePath: string): MandateKey {
  const where = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(where, "utf8"));
  } catch {
    throw new Error(`key file ${where} is not readable JSON`);
  }
  if (!Array.isArray(parsed) || (parsed.length !== 64 && parsed.length !== 32)) {
    throw new Error(`key file ${where} must be a JSON array of 64 (or 32) byte values`);
  }
  for (const n of parsed) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`key file ${where} holds a value that is not a byte`);
    }
  }
  const bytes = Uint8Array.from(parsed as number[]);
  const key = keyFromSeed(bytes.subarray(0, 32));
  if (bytes.length === 64) {
    const stated = b58encode(bytes.subarray(32));
    if (stated !== key.publicKey) {
      throw new Error(`key file ${where}: the public half does not belong to the secret half`);
    }
  }
  return key;
}

/**
 * Create a new keypair file (mode 0600). Refuses to overwrite: a key that
 * signed a mandate in force must not be replaced by accident.
 */
export function generateKeyFile(filePath: string): MandateKey {
  const where = path.resolve(filePath);
  const seed = crypto.randomBytes(32);
  const key = keyFromSeed(seed);
  const raw = decodePublicKey(key.publicKey);
  if (!raw) throw new Error("generated key did not encode");
  fs.mkdirSync(path.dirname(where), { recursive: true });
  const body = JSON.stringify([...seed, ...raw]);
  // "wx": fail if the file exists.
  fs.writeFileSync(where, body, { mode: 0o600, flag: "wx" });
  return key;
}

/** Load the key file, creating it first when it does not exist. */
export function loadOrCreateKeyFile(filePath: string): { key: MandateKey; created: boolean } {
  if (fs.existsSync(filePath)) return { key: loadKeyFile(filePath), created: false };
  return { key: generateKeyFile(filePath), created: true };
}
