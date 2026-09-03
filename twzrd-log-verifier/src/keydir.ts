/*
 * Log signing-key directory — which `key_id` was allowed to sign heads, and when.
 *
 * A transparency log outlives its keys. The 2026-09-02 receipt rotation
 * (twzrd-receipt-ed25519-v1 -> v2) is the concrete case: if verifiers pin only
 * the *current* key, every head signed before a rotation stops verifying and
 * becomes indistinguishable from a forgery — which would destroy the audit
 * trail exactly when someone needs to audit it.
 *
 * So heads carry a `key_id` bound into the signed preimage, and relying parties
 * pin this directory (not a single key). Retiring a key is not retroactive
 * repudiation: a `verify-only` key still validates the heads it signed while it
 * was active.
 *
 * Rotation is NOT an escape hatch from an equivocation proof — see
 * equivocation.ts. Two contradictory heads convict the log whether or not the
 * same key signed both.
 */
import { b58decode, PUBKEY_LEN } from "./util.js";

export const KEY_MODE_SIGN = "sign";
export const KEY_MODE_VERIFY_ONLY = "verify-only";
export type LogKeyMode = typeof KEY_MODE_SIGN | typeof KEY_MODE_VERIFY_ONLY;

export const MAX_KEY_ID_UTF8 = 256;

export interface LogKeyEntry {
  /** Stable identifier, e.g. "twzrd-log-ed25519-v1". Bound into the STH preimage. */
  key_id: string;
  /** base58 Ed25519 public key. */
  public_key: string;
  /** "sign" = may sign new heads; "verify-only" = retired, must never sign again. */
  mode: LogKeyMode;
  /** Inclusive start of the key's signing window (unix seconds). */
  not_before_unix: number;
  /** Exclusive end of the window; null/absent = open-ended (the current signer). */
  not_after_unix?: number | null;
}

export interface LogKeyDirectory {
  version: number;
  log_id: string;
  keys: LogKeyEntry[];
}

export interface KeyResolution {
  entry?: LogKeyEntry;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural + invariant validation. Returns every problem found, not just the first. */
export function validateLogKeyDirectory(dir: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(dir)) return ["key directory must be an object"];
  if (typeof dir.log_id !== "string" || dir.log_id.length === 0) {
    errors.push("key directory log_id must be a non-empty string");
  }
  if (!Array.isArray(dir.keys) || dir.keys.length === 0) {
    return [...errors, "key directory must contain a non-empty keys array"];
  }

  const seen = new Set<string>();
  const signingWindows: Array<{ key_id: string; from: number; to: number }> = [];

  for (const [i, raw] of (dir.keys as unknown[]).entries()) {
    const at = `keys[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const keyId = raw.key_id;
    if (typeof keyId !== "string" || keyId.length === 0) {
      errors.push(`${at}.key_id must be a non-empty string`);
    } else if (new TextEncoder().encode(keyId).length > MAX_KEY_ID_UTF8) {
      errors.push(`${at}.key_id exceeds MAX_KEY_ID_UTF8=${MAX_KEY_ID_UTF8}`);
    } else if (seen.has(keyId)) {
      errors.push(`duplicate key_id ${JSON.stringify(keyId)} — key_id must be unique`);
    } else {
      seen.add(keyId);
    }

    if (typeof raw.public_key !== "string") {
      errors.push(`${at}.public_key must be a base58 string`);
    } else {
      try {
        if (b58decode(raw.public_key).length !== PUBKEY_LEN) {
          errors.push(`${at}.public_key must decode to ${PUBKEY_LEN} bytes`);
        }
      } catch {
        errors.push(`${at}.public_key is not valid base58`);
      }
    }

    if (raw.mode !== KEY_MODE_SIGN && raw.mode !== KEY_MODE_VERIFY_ONLY) {
      errors.push(`${at}.mode must be "${KEY_MODE_SIGN}" or "${KEY_MODE_VERIFY_ONLY}"`);
    }

    const from = raw.not_before_unix;
    const to = raw.not_after_unix;
    if (typeof from !== "number" || !Number.isFinite(from) || from < 0) {
      errors.push(`${at}.not_before_unix must be a non-negative number`);
    }
    if (to !== undefined && to !== null) {
      if (typeof to !== "number" || !Number.isFinite(to) || to < 0) {
        errors.push(`${at}.not_after_unix must be a non-negative number or null`);
      } else if (typeof from === "number" && to <= from) {
        errors.push(`${at}.not_after_unix must be greater than not_before_unix`);
      }
    }
    if (typeof keyId === "string" && typeof from === "number") {
      signingWindows.push({
        key_id: keyId,
        from,
        to: typeof to === "number" ? to : Number.POSITIVE_INFINITY,
      });
    }
  }

  // At most one key may currently sign. More than one open-ended signer means
  // two keys can author heads for the same period, destroying attribution.
  const signers = (dir.keys as LogKeyEntry[]).filter(
    (k) => isPlainObject(k) && k.mode === KEY_MODE_SIGN,
  );
  if (signers.length > 1) {
    errors.push(
      `at most one key may have mode "${KEY_MODE_SIGN}" (got ${signers.length}: ${signers
        .map((k) => k.key_id)
        .join(", ")})`,
    );
  }

  // Signing windows must not overlap, for the same reason.
  const sorted = [...signingWindows].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from < sorted[i - 1].to) {
      errors.push(
        `overlapping validity windows: ${JSON.stringify(sorted[i - 1].key_id)} and ${JSON.stringify(sorted[i].key_id)} — a head in the overlap would have two valid signers`,
      );
    }
  }

  return errors;
}

/** True when `timestampUnix` falls in [not_before_unix, not_after_unix). */
export function keyCoversTimestamp(entry: LogKeyEntry, timestampUnix: number): boolean {
  if (!Number.isFinite(timestampUnix)) return false;
  if (timestampUnix < entry.not_before_unix) return false;
  if (entry.not_after_unix === null || entry.not_after_unix === undefined) return true;
  return timestampUnix < entry.not_after_unix;
}

/**
 * Resolve a `key_id` to its directory entry and check the head's claimed
 * signing time against that key's window.
 *
 * Note the window bounds the *claimed* `timestamp_unix`, which the log asserts
 * about itself. For a trustworthy clock, pair this with a Solana anchor — the
 * on-chain block time is the only timestamp the log cannot choose.
 */
export function resolveLogKey(
  dir: LogKeyDirectory,
  keyId: string,
  timestampUnix?: number,
): KeyResolution {
  const errors: string[] = [];
  const entry = dir.keys.find((k) => k.key_id === keyId);
  if (!entry) {
    return {
      errors: [
        `key_id ${JSON.stringify(keyId)} is not in the pinned key directory (known: ${dir.keys
          .map((k) => k.key_id)
          .join(", ") || "none"})`,
      ],
    };
  }
  if (timestampUnix !== undefined && !keyCoversTimestamp(entry, timestampUnix)) {
    errors.push(
      `head timestamp_unix ${timestampUnix} is outside the validity window of ${JSON.stringify(keyId)} [${entry.not_before_unix}, ${entry.not_after_unix ?? "open"})`,
    );
  }
  return { entry, errors };
}

/** The key currently permitted to sign new heads, if any. */
export function currentSigningKey(dir: LogKeyDirectory): LogKeyEntry | undefined {
  return dir.keys.find((k) => k.mode === KEY_MODE_SIGN);
}

export function isLogKeyDirectory(v: unknown): v is LogKeyDirectory {
  return isPlainObject(v) && Array.isArray((v as Record<string, unknown>).keys);
}
