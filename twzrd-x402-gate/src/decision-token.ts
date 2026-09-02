/**
 * TWZRD Payment Control — signed, expiring DecisionTokens + intent binding.
 *
 * A DecisionToken is not "we checked this merchant earlier". It is:
 * "at this timestamp, policy version X approved this EXACT transaction".
 * The wallet (or payment client) must verify, before signing:
 *
 *   hash(intent being signed) === token.intentHash
 *
 * plus expiry, decision === allow, signature, and consume-once. Any mismatch
 * means refuse — the signer is never invoked.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

import { canonicalJson, intentHash, type PaymentIntent } from "./intent.js";

const DECISION_DOMAIN = "twzrd-decision-v1\n";

export type PaymentDecisionVerdict = "allow" | "warn" | "block";

export type DecisionConstraints = {
  maxAmount?: string;
  allowedAssets?: string[];
  requireHumanApproval?: boolean;
};

export type PaymentDecision = {
  decision: PaymentDecisionVerdict;
  reasonCodes: string[];

  intentHash: string;
  policyVersion: string;
  decisionId: string;
  /** ISO-8601. Tokens are short-lived by design. */
  expiresAt: string;

  /**
   * Prior Decision Outcome Attestation V1 leaves this decision cites as
   * evidence ("0x" + 64 hex, domain TWZRD:AO_DECISION_OUTCOME_V1 — see
   * agent-intel DECISION_OUTCOME_ATTESTATION_V1_SPEC.md). Covered by the
   * token signature via canonicalJson, so decision N+1 verifiably commits
   * to the closed outcome of loop N. Absent on legacy tokens (canonicalJson
   * drops undefined fields — existing signatures are unaffected).
   */
  citedOutcomes?: string[];

  constraints?: DecisionConstraints;

  /**
   * Decimal USDC still available under the budget that blocked this intent
   * (POLICY_MAX_AMOUNT / MANDATE_MONTHLY_CEILING → reason `twzrd_budget_exceeded`).
   * Absent when the block was not budget-related. Signed with the token.
   */
  budgetRemainingUsdc?: string;

  /** Signer key identifier (for rotation / audit). */
  keyId: string;
  /** base64 Ed25519 signature over the domain-separated canonical payload. */
  signature: string;
};

export type DecisionSigner = {
  keyId: string;
  sign(preimage: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** PEM (SPKI) for local verification; remote signers publish theirs. */
  publicKeyPem?: string;
};

/** Outcome-attestation leaves are keccak256 digests: "0x" + 64 lowercase hex. */
const CITED_OUTCOME_LEAF_RE = /^0x[0-9a-f]{64}$/;

/** Bound on cited leaves per token (keeps tokens small; cite the latest, not history). */
export const MAX_CITED_OUTCOMES = 16;

/**
 * Validate + normalize cited outcome leaves at ISSUANCE time (fail closed:
 * a malformed citation is a caller bug, not a policy outcome). Lowercases,
 * requires the 0x prefix form, preserves order, rejects duplicates — the
 * cited set must be exact because the signature commits to it byte-for-byte.
 */
export function normalizeCitedOutcomes(leaves: string[]): string[] {
  if (leaves.length > MAX_CITED_OUTCOMES) {
    throw new Error(
      `[twzrd] citedOutcomes exceeds MAX_CITED_OUTCOMES=${MAX_CITED_OUTCOMES} (got ${leaves.length})`,
    );
  }
  const seen = new Set<string>();
  return leaves.map((leaf) => {
    const norm = leaf.trim().toLowerCase();
    if (!CITED_OUTCOME_LEAF_RE.test(norm)) {
      throw new Error(
        `[twzrd] cited outcome leaf must be "0x" + 64 hex chars (got ${JSON.stringify(leaf)})`,
      );
    }
    if (seen.has(norm)) {
      throw new Error(`[twzrd] duplicate cited outcome leaf: ${norm}`);
    }
    seen.add(norm);
    return norm;
  });
}

/** Everything signed — the token minus the signature itself. */
export function decisionPreimage(token: Omit<PaymentDecision, "signature">): Buffer {
  return Buffer.concat([
    Buffer.from(DECISION_DOMAIN, "utf8"),
    Buffer.from(canonicalJson(token), "utf8"),
  ]);
}

/**
 * Local Ed25519 decision signer. Pass a PKCS#8 PEM to pin a key; otherwise an
 * ephemeral keypair is generated (fine for tests and per-process runtimes).
 */
export function createLocalDecisionSigner(options?: {
  privateKeyPem?: string;
  keyId?: string;
}): DecisionSigner & { publicKeyPem: string } {
  let privateKey: KeyObject;
  if (options?.privateKeyPem) {
    privateKey = createPrivateKey(options.privateKeyPem);
  } else {
    ({ privateKey } = generateKeyPairSync("ed25519"));
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    keyId: options?.keyId ?? "local-ed25519",
    publicKeyPem,
    sign: (preimage) => edSign(null, Buffer.from(preimage), privateKey),
  };
}

/** HKDF domain separation for the seeded signer (never reuse this IKM elsewhere). */
const SEED_SALT = "twzrd-payment-control/decision-signer";
const SEED_INFO = "ed25519-seed/v1";

/** Ed25519 seeds are 32 bytes; we demand at least that much real key material. */
const MIN_SECRET_BYTES = 32;

/**
 * Decode supplied key material. We accept ONLY encoded random bytes (hex or
 * base64/base64url) — never an arbitrary passphrase.
 *
 * The decision public key is published to verifiers, so a passphrase-derived
 * key is guessable offline: an attacker enumerates candidate passphrases,
 * derives each candidate's public key, and compares. Whoever wins that race
 * can forge ALLOW decisions. Requiring 32 bytes of real entropy makes the
 * search space infeasible rather than merely inconvenient.
 */
function decodeKeyMaterial(secret: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    return Buffer.from(secret, "hex");
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(secret)) {
    const buf = Buffer.from(secret, "base64");
    if (buf.length < MIN_SECRET_BYTES) return Buffer.alloc(0);
    // Round-trip guard: a genuine base64 encoding re-encodes to itself, but a
    // memorable passphrase that merely happens to use the base64 alphabet
    // (e.g. "MySuperSecretSigningKey2026Production") does NOT — it round-trips
    // to different bytes. Without this check the length + byte-entropy floors
    // both pass for such a passphrase (ASCII text looks high-entropy per byte),
    // and a guessable secret is exactly the offline-forgery target we reject.
    const normalize = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (buf.toString("base64").replace(/=+$/, "") !== normalize(secret)) {
      return Buffer.alloc(0);
    }
    return buf;
  }
  return Buffer.alloc(0);
}

/** Shannon entropy per byte. Real random material sits near 8; "aaaa…" sits at 0. */
function entropyBitsPerByte(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const b of buf) counts.set(b, (counts.get(b) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Deterministic Ed25519 signer derived from high-entropy key material
 * (issuer==verifier semantics with real signatures). The same secret always
 * yields the same keypair, so an issuer can re-derive its signer across
 * restarts without a keystore.
 *
 * The secret MUST be 32+ bytes of random material, hex or base64 encoded:
 *
 *     openssl rand -hex 32
 *
 * Verifiers receive `publicKeyPem` — never the secret. Anyone holding the
 * secret can mint ALLOW decisions, so it is signing key material, not a
 * shared password. Prefer createLocalDecisionSigner with a managed key for
 * anything beyond single-operator deployments.
 */
export function createSeededDecisionSigner(
  secret: string,
  keyId?: string,
): DecisionSigner & { publicKeyPem: string } {
  if (!secret) throw new Error("[twzrd] decision secret must be non-empty");

  const ikm = decodeKeyMaterial(secret);
  if (ikm.length < MIN_SECRET_BYTES) {
    throw new Error(
      `[twzrd] decision secret must carry >=${MIN_SECRET_BYTES} bytes of high-entropy key material, ` +
        "hex or base64 encoded (generate with: openssl rand -hex 32). " +
        "Passphrases are rejected: the decision public key is published, so a guessable " +
        "secret lets an attacker brute-force the signing key offline and forge ALLOW decisions.",
    );
  }
  if (entropyBitsPerByte(ikm) < 3) {
    throw new Error(
      "[twzrd] decision secret decodes to low-entropy material (repeated/patterned bytes). " +
        "Generate real key material: openssl rand -hex 32",
    );
  }

  // Domain-separated derivation: this IKM cannot collide with any other TWZRD
  // key derived from the same secret.
  const seed = Buffer.from(
    hkdfSync("sha256", ikm, Buffer.from(SEED_SALT), Buffer.from(SEED_INFO), 32),
  );

  // PKCS#8 DER envelope for a raw Ed25519 seed (RFC 8410).
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    keyId: keyId ?? "seeded-ed25519",
    publicKeyPem,
    sign: (preimage) => edSign(null, Buffer.from(preimage), privateKey),
  };
}

export async function signDecision(
  unsigned: Omit<PaymentDecision, "signature" | "keyId">,
  signer: DecisionSigner,
): Promise<PaymentDecision> {
  const payload = { ...unsigned, keyId: signer.keyId };
  const signature = Buffer.from(await signer.sign(decisionPreimage(payload))).toString(
    "base64",
  );
  return { ...payload, signature };
}

export function verifyDecisionSignature(
  token: PaymentDecision,
  publicKeyPem: string,
): boolean {
  const { signature, ...payload } = token;
  try {
    return edVerify(
      null,
      decisionPreimage(payload),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Consume-once registry + the binding assertion                       */
/* ------------------------------------------------------------------ */

export type BindingErrorCode =
  | "INTENT_HASH_MISMATCH"
  | "DECISION_EXPIRED"
  | "DECISION_NOT_ALLOW"
  | "DECISION_REPLAYED"
  | "MISSING_VERIFIER_KEY"
  | "BAD_SIGNATURE";

/** Canonical code thrown when `assertIntentApproved` has no pinned key. */
export const MISSING_VERIFIER_KEY = "MISSING_VERIFIER_KEY";

/**
 * @deprecated Use {@link MISSING_VERIFIER_KEY}. Kept so 0.9.x consumers that
 * matched the pre-rename code keep compiling and matching — same thrown value.
 */
export const MISSING_VERIFICATION_KEY = MISSING_VERIFIER_KEY;

export class TwzrdIntentBindingError extends Error {
  readonly code: BindingErrorCode;
  readonly decisionId: string;
  constructor(code: BindingErrorCode, decisionId: string, detail: string) {
    super(`[twzrd] ${code}: ${detail} (decisionId=${decisionId})`);
    this.name = "TwzrdIntentBindingError";
    this.code = code;
    this.decisionId = decisionId;
  }
}

export type DecisionRegistry = {
  /** True exactly once per decisionId; false on every replay. */
  consume(decisionId: string): boolean;
};

/** In-process consume-once ledger. Entries expire with the tokens. */
export function createDecisionRegistry(): DecisionRegistry {
  const consumed = new Set<string>();
  return {
    consume(decisionId: string): boolean {
      if (consumed.has(decisionId)) return false;
      consumed.add(decisionId);
      return true;
    },
  };
}

export type AssertIntentApprovedOptions = {
  now?: number;
  /** Enforce consume-once semantics (recommended for anything non-idempotent). */
  registry?: DecisionRegistry;
  /** Required trust anchor: verify the token signature against this key. */
  publicKeyPem: string;
};

export type UnsafeAssertIntentApprovedOptions = {
  now?: number;
  registry?: DecisionRegistry;
};

function assertIntentConstraints(
  intent: PaymentIntent,
  token: PaymentDecision,
  options: UnsafeAssertIntentApprovedOptions | undefined,
  // Namespaces registry consumption so an unverified (unsafe) call can never
  // consume — or collide with — the consume-once slot a signature-verified
  // call relies on, even if the same DecisionRegistry instance is shared.
  registryKeyPrefix: string,
): void {
  const now = options?.now ?? Date.now();

  if (token.decision !== "allow" && token.decision !== "warn") {
    throw new TwzrdIntentBindingError(
      "DECISION_NOT_ALLOW",
      token.decisionId,
      `decision is ${token.decision}`,
    );
  }

  const expiresAtMs = Date.parse(token.expiresAt);
  // An unparseable expiresAt must fail closed (Date.parse -> NaN, and every
  // comparison against NaN is false) rather than silently never expiring.
  if (!(now < expiresAtMs)) {
    throw new TwzrdIntentBindingError(
      "DECISION_EXPIRED",
      token.decisionId,
      `expired at ${token.expiresAt}`,
    );
  }

  const actual = intentHash(intent);
  if (actual !== token.intentHash) {
    throw new TwzrdIntentBindingError(
      "INTENT_HASH_MISMATCH",
      token.decisionId,
      `approved ${token.intentHash} but signing ${actual}`,
    );
  }

  if (options?.registry && !options.registry.consume(registryKeyPrefix + token.decisionId)) {
    throw new TwzrdIntentBindingError(
      "DECISION_REPLAYED",
      token.decisionId,
      "decision token already consumed",
    );
  }
}

/**
 * The wallet-side check. Call with the EXACT intent about to be signed.
 * Throws TwzrdIntentBindingError on any violation; returns void when the
 * signature may proceed. A caught error means: do not invoke the signer.
 * `publicKeyPem` is required — forged tokens must not be accepted.
 */
export function assertIntentApproved(
  intent: PaymentIntent,
  token: PaymentDecision,
  options?: AssertIntentApprovedOptions,
): void {
  if (!options?.publicKeyPem) {
    throw new TwzrdIntentBindingError(
      MISSING_VERIFIER_KEY,
      token.decisionId,
      "a pinned decision verification key is required before signing",
    );
  }

  if (!verifyDecisionSignature(token, options.publicKeyPem)) {
    throw new TwzrdIntentBindingError(
      "BAD_SIGNATURE",
      token.decisionId,
      "decision token signature did not verify",
    );
  }

  assertIntentConstraints(intent, token, options, "");
}

/**
 * In-process intent matching without signature verification. Forged tokens
 * pass if the remaining fields match. Prefer `assertIntentApproved`.
 *
 * UNSAFE: never share a `registry` instance between this and
 * `assertIntentApproved` expecting them to interact — consumption here is
 * namespaced separately so an unverified call can neither consume nor be
 * blocked by the signed path's consume-once state.
 */
export function unsafeAssertIntentApprovedWithoutSignature(
  intent: PaymentIntent,
  token: PaymentDecision,
  options?: UnsafeAssertIntentApprovedOptions,
): void {
  assertIntentConstraints(intent, token, options, "unsafe:");
}

export function newDecisionId(): string {
  return randomUUID();
}
