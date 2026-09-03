/*
 * Signed Tree Head (STH) encoding + verification per the TWZRD Receipt
 * Transparency spec. The signature is Ed25519 over a fixed little-endian
 * preimage (same integer conventions as the V6 receipt leaf encoding).
 *
 * Two domains:
 *   V1 — original v0.1 layout, no key_id. Never served by any log (the log had
 *        no genesis before v0.2 landed); kept so anything built against the
 *        merged v0.1 package still verifies.
 *   V2 — current. Binds `key_id` into the preimage so a head names its signer
 *        authentically and stays verifiable across key rotations.
 *
 * A key_id is only meaningful when it is signed over. A V1 envelope carrying a
 * key_id field is therefore rejected rather than verified: the field would be
 * attacker-mutable and would give false assurance about who signed.
 */
import nacl from "tweetnacl";
import {
  PUBKEY_LEN,
  SIGNATURE_LEN,
  b58decode,
  b58encode,
  bytesToHex,
  concatBytes,
  hexToBytes,
  u16le,
  u64le,
} from "./util.js";
import { HASH_LEN } from "./merkle.js";
import {
  MAX_KEY_ID_UTF8,
  isLogKeyDirectory,
  resolveLogKey,
  type LogKeyDirectory,
  type LogKeyMode,
} from "./keydir.js";

export const STH_DOMAIN_V1 = "TWZRD:RECEIPT_LOG_STH_V1";
export const STH_DOMAIN_V2 = "TWZRD:RECEIPT_LOG_STH_V2";
/** @deprecated v0.1 alias. New heads use {@link STH_DOMAIN_V2}. */
export const STH_DOMAIN = STH_DOMAIN_V1;
export const CURRENT_STH_DOMAIN = STH_DOMAIN_V2;
export const KNOWN_STH_DOMAINS = new Set([STH_DOMAIN_V1, STH_DOMAIN_V2]);

export { PUBKEY_LEN, SIGNATURE_LEN };
export const MAX_LOG_ID_UTF8 = 256;

export interface SthFields {
  domain: string;
  log_id: string;
  tree_size: number;
  timestamp_unix: number;
  root: string; // 32-byte hex, 0x-prefix optional
  /** Required for V2 domains, rejected for V1. */
  key_id?: string;
}

export interface SignedTreeHead extends SthFields {
  signature: string; // base58 64-byte Ed25519 signature
  signing_pubkey?: string; // base58 32-byte key (advisory; must match the resolved key)
}

export interface SthVerifyResult {
  valid: boolean;
  errors: string[];
  /** The key the signature was actually checked against. */
  trusted_pubkey: string;
  key_id?: string;
  key_mode?: LogKeyMode;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function lenPrefixed(value: string, max: number, label: string): Uint8Array {
  const raw = utf8(value);
  if (raw.length === 0 || raw.length > max) {
    throw new Error(`${label} must be 1..${max} utf-8 bytes (got ${raw.length})`);
  }
  return concatBytes(u16le(raw.length), raw);
}

/** Deterministic byte preimage the log key signs. Throws on malformed fields. */
export function encodeSthPreimage(sth: SthFields): Uint8Array {
  const domain = String(sth.domain);
  if (!KNOWN_STH_DOMAINS.has(domain)) {
    throw new Error(`unknown STH domain: ${JSON.stringify(domain)}`);
  }
  const isV2 = domain === STH_DOMAIN_V2;
  if (!isV2 && sth.key_id !== undefined && sth.key_id !== null) {
    throw new Error(
      `${STH_DOMAIN_V1} does not bind key_id into the signature; a V1 head carrying key_id ` +
        `would authenticate nothing. Reissue under ${STH_DOMAIN_V2}.`,
    );
  }
  if (isV2 && (sth.key_id === undefined || sth.key_id === null)) {
    throw new Error(`${STH_DOMAIN_V2} requires key_id`);
  }

  const root = hexToBytes(sth.root);
  if (root.length !== HASH_LEN) {
    throw new Error(`root must be ${HASH_LEN} bytes of hex (got ${root.length})`);
  }

  const parts: Uint8Array[] = [
    utf8(domain),
    lenPrefixed(String(sth.log_id), MAX_LOG_ID_UTF8, "log_id"),
  ];
  if (isV2) parts.push(lenPrefixed(String(sth.key_id), MAX_KEY_ID_UTF8, "key_id"));
  parts.push(u64le(sth.tree_size), u64le(sth.timestamp_unix), root);
  return concatBytes(...parts);
}

/**
 * Verify an STH signature.
 *
 * `trusted` is either a single pinned base58 key (v0.1 style) or a pinned key
 * directory. With a directory, the head's `key_id` is resolved to its entry and
 * the head's `timestamp_unix` must fall inside that key's validity window — so a
 * head signed by a since-retired key still verifies, while a retired key cannot
 * be used to backdate or postdate a head into a window it never held.
 */
export function verifySth(
  sth: SignedTreeHead,
  trusted: string | LogKeyDirectory,
): SthVerifyResult {
  const usingDirectory = isLogKeyDirectory(trusted);
  const out: SthVerifyResult = {
    valid: false,
    errors: [],
    trusted_pubkey: usingDirectory ? "" : String(trusted),
  };

  let preimage: Uint8Array;
  try {
    preimage = encodeSthPreimage(sth);
  } catch (e) {
    out.errors.push(`could not encode STH preimage: ${(e as Error).message}`);
    return out;
  }

  let trustedPubkey: string;
  if (usingDirectory) {
    const dir = trusted as LogKeyDirectory;
    if (String(dir.log_id) !== String(sth.log_id)) {
      out.errors.push(
        `head log_id ${JSON.stringify(String(sth.log_id))} != pinned directory log_id ${JSON.stringify(String(dir.log_id))}`,
      );
      return out;
    }
    const keyId = sth.key_id;
    if (typeof keyId !== "string" || keyId.length === 0) {
      out.errors.push(
        "a key directory was pinned but the head carries no key_id — only " +
          `${STH_DOMAIN_V2} heads can be verified against a directory`,
      );
      return out;
    }
    const resolved = resolveLogKey(dir, keyId, Number(sth.timestamp_unix));
    if (!resolved.entry) {
      out.errors.push(...resolved.errors);
      return out;
    }
    out.key_id = resolved.entry.key_id;
    out.key_mode = resolved.entry.mode;
    out.errors.push(...resolved.errors);
    trustedPubkey = resolved.entry.public_key;
    out.trusted_pubkey = trustedPubkey;
  } else {
    trustedPubkey = String(trusted);
    if (typeof sth.key_id === "string") out.key_id = sth.key_id;
  }

  // Advisory field: it must agree with the key we actually trust, never replace it.
  if (sth.signing_pubkey && sth.signing_pubkey !== trustedPubkey) {
    out.errors.push(
      `signing_pubkey ${sth.signing_pubkey} != trusted key ${trustedPubkey}`,
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
  if (!ok) out.errors.push("signature not valid for the trusted key");
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
  return {
    ...fields,
    root: "0x" + bytesToHex(hexToBytes(fields.root)),
    signature: b58encode(sig),
    signing_pubkey: b58encode(secretKey.slice(32)),
  };
}
