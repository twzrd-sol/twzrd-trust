/*
 * Signed Tree Head (STH) encoding + verification per the TWZRD Receipt
 * Transparency spec. The signature is Ed25519 over a fixed little-endian
 * preimage (same integer conventions as the V6 receipt leaf encoding).
 */
import nacl from "tweetnacl";
import {
  b58decode,
  b58encode,
  bytesToHex,
  concatBytes,
  hexToBytes,
  u16le,
  u64le,
} from "./util.js";
import { HASH_LEN } from "./merkle.js";

export const STH_DOMAIN = "TWZRD:RECEIPT_LOG_STH_V1";
export const PUBKEY_LEN = 32;
export const SIGNATURE_LEN = 64;
export const MAX_LOG_ID_UTF8 = 256;

export interface SthFields {
  domain: string;
  log_id: string;
  tree_size: number;
  timestamp_unix: number;
  root: string; // 32-byte hex, 0x-prefix optional
}

export interface SignedTreeHead extends SthFields {
  signature: string; // base58 64-byte Ed25519 signature
  signing_pubkey?: string; // base58 32-byte Ed25519 key (optional, must match pinned key)
}

export interface SthVerifyResult {
  valid: boolean;
  errors: string[];
  trusted_pubkey: string;
}

/** Deterministic byte preimage the log key signs. Throws on malformed fields. */
export function encodeSthPreimage(sth: SthFields): Uint8Array {
  if (String(sth.domain) !== STH_DOMAIN) {
    throw new Error(`unknown STH domain: ${JSON.stringify(String(sth.domain))}`);
  }
  const logId = new TextEncoder().encode(String(sth.log_id));
  if (logId.length === 0 || logId.length > MAX_LOG_ID_UTF8) {
    throw new Error(`log_id must be 1..${MAX_LOG_ID_UTF8} utf-8 bytes (got ${logId.length})`);
  }
  const root = hexToBytes(sth.root);
  if (root.length !== HASH_LEN) {
    throw new Error(`root must be ${HASH_LEN} bytes of hex (got ${root.length})`);
  }
  return concatBytes(
    new TextEncoder().encode(STH_DOMAIN),
    u16le(logId.length),
    logId,
    u64le(sth.tree_size),
    u64le(sth.timestamp_unix),
    root,
  );
}

/**
 * Verify an STH signature against a pinned log key. Mirrors the
 * twzrd-receipt-verifier convention: if the envelope embeds a
 * `signing_pubkey`, it must equal the pinned key exactly.
 */
export function verifySth(sth: SignedTreeHead, trustedPubkey: string): SthVerifyResult {
  const out: SthVerifyResult = { valid: false, errors: [], trusted_pubkey: trustedPubkey };

  let preimage: Uint8Array;
  try {
    preimage = encodeSthPreimage(sth);
  } catch (e) {
    out.errors.push(`could not encode STH preimage: ${(e as Error).message}`);
    return out;
  }

  if (sth.signing_pubkey && sth.signing_pubkey !== trustedPubkey) {
    out.errors.push(
      `signing_pubkey ${sth.signing_pubkey} != trusted pinned key ${trustedPubkey}`,
    );
    return out;
  }

  let pkRaw: Uint8Array;
  let sigRaw: Uint8Array;
  try {
    pkRaw = b58decode(trustedPubkey);
    sigRaw = b58decode(String(sth.signature || ""));
  } catch (e) {
    out.errors.push(`malformed signature or pubkey encoding: ${(e as Error).message}`);
    return out;
  }
  if (pkRaw.length !== PUBKEY_LEN) {
    out.errors.push(`malformed trusted pubkey length: ${pkRaw.length} (expected ${PUBKEY_LEN})`);
    return out;
  }
  if (sigRaw.length !== SIGNATURE_LEN) {
    out.errors.push(`malformed signature length: ${sigRaw.length} (expected ${SIGNATURE_LEN})`);
    return out;
  }

  let ok = false;
  try {
    ok = nacl.sign.detached.verify(preimage, sigRaw, pkRaw);
  } catch (e) {
    out.errors.push(`signature check error: ${(e as Error).message}`);
    return out;
  }
  if (!ok) out.errors.push("signature not valid for the trusted pinned key");
  out.valid = ok && out.errors.length === 0;
  return out;
}

/**
 * Sign an STH with an Ed25519 secret key (64-byte tweetnacl format).
 * Used by the log operator, the self-test, and the test suite — never
 * required by relying parties.
 */
export function signSth(fields: SthFields, secretKey: Uint8Array): SignedTreeHead {
  const preimage = encodeSthPreimage(fields);
  const sig = nacl.sign.detached(preimage, secretKey);
  const pub = secretKey.slice(32);
  return {
    ...fields,
    root: "0x" + bytesToHex(hexToBytes(fields.root)),
    signature: b58encode(sig),
    signing_pubkey: b58encode(pub),
  };
}
