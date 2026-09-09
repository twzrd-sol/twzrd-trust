/**
 * twzrd.payment_decision.v1 — the portable public decision receipt.
 *
 * Wallets and gateways already do budgets, approvals, routing and spend
 * limits. What they do not have is a portable record of what the agent SAW
 * (a hash of the exact 402 challenge), what it DECIDED (allow | block | warn |
 * unavailable), WHY (a closed reason-code enum) and an evidence id a third
 * party can verify offline — without TWZRD in the request path.
 *
 * This module is that record plus its verifier. It is deliberately small:
 *
 *   - the challenge binding is the existing resource-bind v1 leaf
 *     (resourceBindLeafHash), so `challenge_hash` equals the bind leaf a
 *     relying party may already hold from the evidence bundle or the on-chain
 *     `rb1:` memo — one binding, not a second one;
 *   - the signature is the existing DecisionSigner (Ed25519 over a
 *     domain-separated canonical JSON preimage, exactly like DecisionToken);
 *   - the reason codes are the codes the existing policy runtime already
 *     emits, plus four codes for the `unavailable` decision.
 *
 * `unavailable` is a first-class decision: the evaluator produced NO verdict
 * (intel unreachable, timeout, unscored network, evaluator error). It is never
 * `block`. What the agent then did under its own fail-open/fail-closed policy
 * is not part of this record.
 *
 * NOT in this record, by construction and enforced by the verifier: any score,
 * any wallet secret, any raw payment authorization / payload, and any full
 * resource URL (the URL is committed to by the hash, never carried).
 *
 * Spec: docs/payment-decision-v1-spec.md. JSON Schema:
 * docs/schemas/twzrd.payment_decision.v1.schema.json.
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
import { scanForSecretValues, type SecretKind } from "./evidence-verify.js";
import { canonicalJson } from "./intent.js";
import { resourceBindLeafHash, type ResourceBindReq } from "./resource-bind.js";
import type { TwzrdApprovalResult } from "./types.js";

export const PAYMENT_DECISION_SCHEMA = "twzrd.payment_decision.v1" as const;
/** Domain prefix of the signed preimage. Distinct from DecisionToken's
 *  `twzrd-decision-v1\n` so a token signature can never be replayed as a record. */
export const PAYMENT_DECISION_DOMAIN = "twzrd.payment_decision.v1\n";
export const PAYMENT_DECISION_SIGNATURE_ALG = "ed25519" as const;
export const PAYMENT_DECISION_VERIFICATION_SCHEMA = "twzrd.payment_decision_verification.v1" as const;

/* ------------------------------------------------------------------ */
/* The frozen shape                                                    */
/* ------------------------------------------------------------------ */

export const PAYMENT_DECISION_DECISIONS = ["allow", "block", "warn", "unavailable"] as const;
export type PaymentDecisionRecordDecision = (typeof PAYMENT_DECISION_DECISIONS)[number];

/**
 * Closed reason-code enum → the decisions each code may accompany.
 *
 * Every code except the four `unavailable` codes is a string the existing
 * policy runtime (policy-runtime.ts evaluateIntent) already emits into
 * DecisionToken.reasonCodes — reused verbatim, including the agent-facing
 * `twzrd_budget_exceeded` alias. Adding a code is a v2.
 */
export const PAYMENT_DECISION_REASON_CODES = {
  ALLOW: ["allow"],

  INTEL_WARN: ["warn"],
  UNKNOWN_UNDER_LIMIT: ["warn"],
  UNKNOWN_ABOVE_LIMIT: ["warn", "block"],

  MANDATE_EXPIRED: ["block"],
  MANDATE_PURPOSE: ["block"],
  MANDATE_RESOURCE_SCOPE: ["block"],
  MANDATE_PAYEE_BLOCKED: ["block"],
  MANDATE_MAX_PER_TX: ["block"],
  MANDATE_MONTHLY_CEILING: ["block"],
  POLICY_BLOCKLIST: ["block"],
  POLICY_NOT_ALLOWLISTED: ["block"],
  POLICY_NETWORK: ["block"],
  POLICY_ASSET: ["block"],
  POLICY_MAX_AMOUNT: ["block"],
  RECURRING_PRICE_INCREASE: ["block"],
  NEW_COUNTERPARTY_CAP: ["block"],
  WASH_FLAGGED: ["block"],
  INTEL_BLOCK: ["block"],
  twzrd_budget_exceeded: ["block"],

  INTEL_UNAVAILABLE: ["unavailable"],
  INTEL_TIMEOUT: ["unavailable"],
  NETWORK_NOT_SCORED: ["unavailable"],
  EVALUATOR_ERROR: ["unavailable"],
} as const satisfies Record<string, readonly PaymentDecisionRecordDecision[]>;

export type PaymentDecisionReasonCode = keyof typeof PAYMENT_DECISION_REASON_CODES;

export type PaymentDecisionMerchant = {
  /** WHATWG origin of the 402 resource: scheme://host[:port]. Never a path or query. */
  origin: string;
  /** The x402 `accepts[].payTo` value as served. */
  pay_to: string;
};

export type PaymentDecisionSignature = {
  alg: typeof PAYMENT_DECISION_SIGNATURE_ALG;
  /** Signer key identifier (DecisionSigner.keyId). Covered by the signature. */
  key_id: string;
  /** base64 Ed25519 signature (64 bytes) over paymentDecisionPreimage(). */
  sig: string;
};

export type PaymentDecisionRecordV1 = {
  schema: typeof PAYMENT_DECISION_SCHEMA;
  /** hex sha256 — resource-bind v1 leaf over the normalized 402 challenge. */
  challenge_hash: string;
  merchant: PaymentDecisionMerchant;
  /** CAIP-2 chain id. */
  network: string;
  /** x402 scheme of the selected requirement, e.g. "exact". */
  scheme: string;
  decision: PaymentDecisionRecordDecision;
  reason_code: PaymentDecisionReasonCode;
  /** Opaque id of the signed evidence behind this record (DecisionToken.decisionId). */
  evidence_id: string;
  /** RFC 3339 UTC ("Z"). */
  expires_at: string;
  signature: PaymentDecisionSignature;
};

export type UnsignedPaymentDecisionRecord = Omit<PaymentDecisionRecordV1, "signature"> & {
  signature: Omit<PaymentDecisionSignature, "sig">;
};

/** Exactly the top-level keys a v1 record may carry. Anything else is rejected. */
export const PAYMENT_DECISION_FIELDS = [
  "schema",
  "challenge_hash",
  "merchant",
  "network",
  "scheme",
  "decision",
  "reason_code",
  "evidence_id",
  "expires_at",
  "signature",
] as const;

const MERCHANT_FIELDS = ["origin", "pay_to"] as const;
const SIGNATURE_FIELDS = ["alg", "key_id", "sig"] as const;

const HEX64_RE = /^[0-9a-f]{64}$/;
/** CAIP-2: namespace ":" reference. */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const SCHEME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Opaque identifiers: no whitespace, no "?", no "/", no base64 padding — a URL
 *  with a query, a bearer token or a signature cannot fit this shape. */
const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** RFC 3339 UTC with an explicit Z, optional sub-second (what toISOString emits). */
const RFC3339_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** 64 bytes of Ed25519 signature in base64 is exactly 88 chars ending "==". */
const ED25519_SIG_B64_RE = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Key names that are forbidden ANYWHERE in a record, reported with a specific
 * code so the rejection explains itself. Every unknown key is rejected anyway;
 * these are the ones the schema exists to keep out.
 */
const FORBIDDEN_KEY_RE =
  /score|secret|private|seed|mnemonic|keypair|password|authorization|payload|x[-_]?payment|bearer|token|url|resource|amount|wallet/i;

/* ------------------------------------------------------------------ */
/* Challenge normalization + merchant projection                        */
/* ------------------------------------------------------------------ */

/**
 * sha256 of the normalized 402 challenge.
 *
 * This IS the resource-bind v1 leaf (resource-bind.ts resourceBindLeafHash):
 *
 *   requirements_hash = sha256(canonicalJson({amount, asset, network, payTo, resource, scheme}))
 *   leaf = { amount_raw, asset, body_hash: "0"*64, network, pay_to,
 *            requirements_hash, resource_url: canonicalResourceUrl(resource), schema_version: 1 }
 *   challenge_hash = sha256("twzrd:x402-resource-binding:v1\n" + canonicalJson(leaf))
 *
 * `network` is hashed as SERVED (the raw 402 string), not CAIP-2 normalized:
 * the hash commits to what the agent saw. The record's `network` field is the
 * CAIP-2 label. Fails closed when the challenge lacks payTo, amount, resource,
 * network or scheme — an under-specified challenge cannot be committed to.
 */
export function challengeHashV1(challenge: ResourceBindReq): string {
  const payTo = challenge.payTo ?? challenge.pay_to;
  const amount = challenge.amount ?? challenge.maxAmountRequired;
  const missing: string[] = [];
  if (!isNonEmpty(payTo)) missing.push("payTo");
  if (!isNonEmpty(amount)) missing.push("amount");
  if (!isNonEmpty(challenge.resource)) missing.push("resource");
  if (!isNonEmpty(challenge.network)) missing.push("network");
  if (!isNonEmpty(challenge.scheme)) missing.push("scheme");
  if (missing.length) {
    throw new Error(`[twzrd] challengeHashV1: 402 challenge is missing ${missing.join(", ")}`);
  }
  return resourceBindLeafHash(challenge);
}

/** origin + payTo. The resource URL itself never leaves this function. */
export function merchantFromChallenge(challenge: ResourceBindReq): PaymentDecisionMerchant {
  const payTo = challenge.payTo ?? challenge.pay_to;
  if (!isNonEmpty(payTo)) throw new Error("[twzrd] merchantFromChallenge: challenge has no payTo");
  if (!isNonEmpty(challenge.resource)) {
    throw new Error("[twzrd] merchantFromChallenge: challenge has no resource URL");
  }
  const url = new URL(challenge.resource);
  if (url.username || url.password) {
    throw new Error("[twzrd] merchantFromChallenge: resource URL carries userinfo");
  }
  if (url.origin === "null") {
    throw new Error("[twzrd] merchantFromChallenge: resource URL has an opaque origin");
  }
  return { origin: url.origin, pay_to: payTo };
}

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/** x402 wire aliases the gate already treats as equivalent (resource-bind.ts networksEquivalent). */
const NETWORK_ALIASES: Record<string, string> = {
  solana: SOLANA_MAINNET_CAIP2,
  "solana-mainnet": SOLANA_MAINNET_CAIP2,
  "solana:mainnet": SOLANA_MAINNET_CAIP2,
  "mainnet-beta": SOLANA_MAINNET_CAIP2,
  "solana-devnet": SOLANA_DEVNET_CAIP2,
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
};

/**
 * CAIP-2 for the record's `network` field. Valid CAIP-2 passes through
 * unchanged; the handful of x402 aliases the gate already recognizes are
 * mapped; anything else throws (the producer must supply CAIP-2 explicitly).
 */
export function toCaip2Network(raw: string): string {
  const s = String(raw ?? "").trim();
  if (CAIP2_RE.test(s)) return s;
  const alias = NETWORK_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  throw new Error(`[twzrd] toCaip2Network: ${JSON.stringify(raw)} is not CAIP-2 and has no known alias`);
}

/* ------------------------------------------------------------------ */
/* What is signed                                                       */
/* ------------------------------------------------------------------ */

/**
 * Domain || canonicalJson(record with signature.sig removed).
 * `signature.alg` and `signature.key_id` ARE covered; only the signature bytes
 * are not. canonicalJson is the frozen PaymentIntent v1 form (intent.ts).
 */
export function paymentDecisionPreimage(
  record: PaymentDecisionRecordV1 | UnsignedPaymentDecisionRecord,
): Buffer {
  const { signature, ...body } = record;
  const covered = { ...body, signature: { alg: signature.alg, key_id: signature.key_id } };
  return Buffer.concat([
    Buffer.from(PAYMENT_DECISION_DOMAIN, "utf8"),
    Buffer.from(canonicalJson(covered), "utf8"),
  ]);
}

/* ------------------------------------------------------------------ */
/* Producer                                                             */
/* ------------------------------------------------------------------ */

export type IssuePaymentDecisionInput = {
  /** The selected x402 `accepts[]` entry (payTo, amount, asset, network, resource, scheme). */
  challenge: ResourceBindReq;
  decision: PaymentDecisionRecordDecision;
  reason_code: PaymentDecisionReasonCode;
  evidence_id: string;
  /** RFC 3339 UTC. Records are short-lived by design, like the token they mirror. */
  expires_at: string;
  /** CAIP-2 override when the challenge's network string has no known alias. */
  network?: string;
};

export class TwzrdPaymentDecisionError extends Error {
  readonly errors: PaymentDecisionVerifyError[];
  constructor(message: string, errors: PaymentDecisionVerifyError[] = []) {
    super(`[twzrd] ${message}`);
    this.name = "TwzrdPaymentDecisionError";
    this.errors = errors;
  }
}

/**
 * Build and sign a record. Fails closed: the unsigned record is run through
 * the same structural + forbidden-content checks the verifier applies, so an
 * issuer cannot mint a record its own verifier would reject (for example a
 * `block` carrying an `unavailable` reason, or a pay_to shaped like a key).
 */
export async function issuePaymentDecisionRecord(
  input: IssuePaymentDecisionInput,
  signer: DecisionSigner,
): Promise<PaymentDecisionRecordV1> {
  const unsigned: UnsignedPaymentDecisionRecord = {
    schema: PAYMENT_DECISION_SCHEMA,
    challenge_hash: challengeHashV1(input.challenge),
    merchant: merchantFromChallenge(input.challenge),
    network: input.network ?? toCaip2Network(String(input.challenge.network)),
    scheme: String(input.challenge.scheme),
    decision: input.decision,
    reason_code: input.reason_code,
    evidence_id: input.evidence_id,
    expires_at: input.expires_at,
    signature: { alg: PAYMENT_DECISION_SIGNATURE_ALG, key_id: signer.keyId },
  };
  const sig = Buffer.from(await signer.sign(paymentDecisionPreimage(unsigned))).toString("base64");
  const record: PaymentDecisionRecordV1 = {
    ...unsigned,
    signature: { ...unsigned.signature, sig },
  };
  const errors = [...validateRecordStructure(record), ...scanForbiddenContent(record)];
  if (errors.length) {
    throw new TwzrdPaymentDecisionError(
      `refusing to issue a record the verifier would reject: ${errors.map((e) => e.code).join(", ")}`,
      errors,
    );
  }
  return record;
}

/**
 * The single reason a record carries, chosen from a DecisionToken's
 * reasonCodes: the FIRST code that is valid for the verdict. A block token may
 * list a warn code first (INTEL_WARN then UNKNOWN_ABOVE_LIMIT), so "first
 * element" is not the rule. Throws when no listed code fits — a token whose
 * reasons contradict its verdict must not be projected.
 */
export function primaryReasonCode(
  decision: PaymentDecisionRecordDecision,
  reasonCodes: readonly string[],
): PaymentDecisionReasonCode {
  for (const code of reasonCodes) {
    if (isReasonCode(code) && allowedDecisions(code).includes(decision)) return code;
  }
  throw new TwzrdPaymentDecisionError(
    `no reason code in [${reasonCodes.join(", ")}] is valid for decision ${JSON.stringify(decision)}`,
  );
}

/**
 * Project an existing signed DecisionToken (allow | warn | block) onto the
 * public record: same decision, its primary reason code, evidence_id =
 * decisionId, expires_at = the token's expiry. The token can never yield
 * `unavailable` — that decision is issued explicitly by the caller that
 * observed the outage.
 */
export async function paymentDecisionRecordFromToken(
  token: PaymentDecision,
  challenge: ResourceBindReq,
  signer: DecisionSigner,
  options: { network?: string } = {},
): Promise<PaymentDecisionRecordV1> {
  if (token.decision !== "allow" && token.decision !== "warn" && token.decision !== "block") {
    throw new TwzrdPaymentDecisionError(
      `DecisionToken verdict ${JSON.stringify(token.decision)} is not allow | warn | block`,
    );
  }
  return issuePaymentDecisionRecord(
    {
      challenge,
      decision: token.decision,
      reason_code: primaryReasonCode(token.decision, token.reasonCodes),
      evidence_id: token.decisionId,
      expires_at: token.expiresAt,
      network: options.network,
    },
    signer,
  );
}

/**
 * Classify a ReadinessCard-path approval (policy.ts twzrdApprovePayment) for
 * the record. This is where `unavailable` is separated from `block`: the gate
 * reports an unreachable preflight as `verdict:"block", reason:"twzrd_fail_closed (…)"`
 * (fail-closed) or `verdict:"warn", reason:"twzrd_fail_open"` (fail-open).
 * Both are the SAME fact for a relying party — no verdict was produced — and
 * the record says so. An unscored network (`verdict:"unknown"`) is likewise
 * unavailable, never block or allow.
 */
export function decisionFromApproval(
  result: Pick<TwzrdApprovalResult, "verdict" | "reason" | "approved"> &
    Partial<Pick<TwzrdApprovalResult, "failOpen" | "washFlagged" | "reputationScored">>,
): { decision: PaymentDecisionRecordDecision; reason_code: PaymentDecisionReasonCode } {
  const reason = String(result.reason ?? "");
  if (result.failOpen === true || /^twzrd_fail_(?:closed|open)\b/.test(reason)) {
    return { decision: "unavailable", reason_code: "INTEL_UNAVAILABLE" };
  }
  // A wash refuse is a real verdict even on an unscored network (Base wash
  // refuses under observe mode), so it is classified before the network check.
  if (!result.approved && (result.washFlagged === true || /twzrd_wash_flagged/.test(reason))) {
    return { decision: "block", reason_code: "WASH_FLAGGED" };
  }
  if (/twzrd_budget_exceeded|POLICY_MAX_AMOUNT|MANDATE_MONTHLY_CEILING|MANDATE_MAX_PER_TX/.test(reason)) {
    return { decision: "block", reason_code: "twzrd_budget_exceeded" };
  }
  if (result.verdict === "unknown" || result.reputationScored === false) {
    return { decision: "unavailable", reason_code: "NETWORK_NOT_SCORED" };
  }
  if (result.verdict === "block" || !result.approved) {
    return { decision: "block", reason_code: "INTEL_BLOCK" };
  }
  if (result.verdict === "warn") return { decision: "warn", reason_code: "INTEL_WARN" };
  return { decision: "allow", reason_code: "ALLOW" };
}

/* ------------------------------------------------------------------ */
/* Verifier                                                             */
/* ------------------------------------------------------------------ */

export type PaymentDecisionVerifyError = {
  code:
    | "not_an_object"
    | "schema_mismatch"
    | "unknown_field"
    | "forbidden_field"
    | "missing_field"
    | "invalid_field"
    | "decision_missing"
    | "decision_invalid"
    | "decision_conflict"
    | "unavailable_as_block"
    | "reason_code_unknown"
    | "forbidden_content"
    | "expired"
    | "missing_verifier_key"
    | "bad_signature"
    | "challenge_unhashable"
    | "challenge_hash_mismatch"
    | "merchant_mismatch"
    | "network_mismatch"
    | "network_unmappable"
    | "scheme_mismatch";
  path: string;
  message: string;
};

export type VerifyPaymentDecisionOptions = {
  /** SPKI PEM of the issuer's decision public key (single-key deployments). */
  publicKeyPem?: string;
  /** key_id → SPKI PEM, for issuers with more than one key. Wins over publicKeyPem. */
  publicKeys?: Record<string, string>;
  /** Clock, Unix ms. Injectable so verification is deterministic in tests. */
  now?: number;
  /**
   * The 402 challenge the relying party holds, if any. When supplied the
   * verifier recomputes challenge_hash and cross-checks merchant, network and
   * scheme against it, so the record is proven to be about THIS offer.
   */
  challenge?: ResourceBindReq;
};

export type PaymentDecisionVerification = {
  schema: typeof PAYMENT_DECISION_VERIFICATION_SCHEMA;
  /** Accept iff every check passed. */
  ok: boolean;
  /** The verified decision — null unless ok. Never read a decision off a rejected record. */
  decision: PaymentDecisionRecordDecision | null;
  reason_code: PaymentDecisionReasonCode | null;
  evidence_id: string | null;
  /** sha256 over key-sorted JSON of the input, so two verifiers name the same bytes. */
  record_digest: string;
  checks: {
    structure: boolean;
    forbidden_content: boolean;
    decision_coherent: boolean;
    not_expired: boolean;
    signature: boolean;
    /** null when no challenge was supplied (unchecked, never "passed"). */
    challenge_bound: boolean | null;
  };
  errors: PaymentDecisionVerifyError[];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isReasonCode = (v: unknown): v is PaymentDecisionReasonCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(PAYMENT_DECISION_REASON_CODES, v);
const allowedDecisions = (code: PaymentDecisionReasonCode): readonly PaymentDecisionRecordDecision[] =>
  PAYMENT_DECISION_REASON_CODES[code];

type E = PaymentDecisionVerifyError;
const err = (code: E["code"], path: string, message: string): E => ({ code, path, message });

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  out: E[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(
      FORBIDDEN_KEY_RE.test(key)
        ? err("forbidden_field", path,
            `${JSON.stringify(key)} is forbidden in ${PAYMENT_DECISION_SCHEMA}: the record carries no ` +
            "score, secret, authorization, payload, amount or URL")
        : err("unknown_field", path, `${JSON.stringify(key)} is not a ${PAYMENT_DECISION_SCHEMA} field`),
    );
  }
  for (const key of allowed) {
    if (!(key in obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(key === "decision"
        ? err("decision_missing", path, "decision is required: allow | block | warn | unavailable")
        : err("missing_field", path, `${path} is required`));
    }
  }
}

/** Structure, enums and decision/reason coherence. No crypto, no clock. */
export function validateRecordStructure(value: unknown): PaymentDecisionVerifyError[] {
  const e: E[] = [];
  if (!isObj(value)) {
    return [err("not_an_object", "(root)", "a payment decision record must be a JSON object")];
  }
  checkKeys(value, PAYMENT_DECISION_FIELDS, "", e);

  if (value.schema !== PAYMENT_DECISION_SCHEMA) {
    e.push(err("schema_mismatch", "schema", `schema must be exactly ${JSON.stringify(PAYMENT_DECISION_SCHEMA)}`));
  }
  if ("challenge_hash" in value && !(typeof value.challenge_hash === "string" && HEX64_RE.test(value.challenge_hash))) {
    e.push(err("invalid_field", "challenge_hash", "challenge_hash must be 64 lowercase hex chars (sha256)"));
  }

  if ("merchant" in value) {
    if (!isObj(value.merchant)) {
      e.push(err("invalid_field", "merchant", "merchant must be an object { origin, pay_to }"));
    } else {
      const m = value.merchant;
      checkKeys(m, MERCHANT_FIELDS, "merchant", e);
      if ("origin" in m && !isBareOrigin(m.origin)) {
        e.push(err("invalid_field", "merchant.origin",
          "merchant.origin must be a bare WHATWG origin (scheme://host[:port]) — no path, query, fragment or userinfo"));
      }
      if ("pay_to" in m && !(typeof m.pay_to === "string" && OPAQUE_ID_RE.test(m.pay_to))) {
        e.push(err("invalid_field", "merchant.pay_to", "merchant.pay_to must be an address-shaped string (1-128 of [A-Za-z0-9._:-])"));
      }
    }
  }

  if ("network" in value && !(typeof value.network === "string" && CAIP2_RE.test(value.network))) {
    e.push(err("invalid_field", "network", "network must be a CAIP-2 chain id (namespace:reference)"));
  }
  if ("scheme" in value && !(typeof value.scheme === "string" && SCHEME_RE.test(value.scheme))) {
    e.push(err("invalid_field", "scheme", "scheme must be a lowercase token, e.g. \"exact\""));
  }

  const decisionOk =
    typeof value.decision === "string" &&
    (PAYMENT_DECISION_DECISIONS as readonly string[]).includes(value.decision);
  if ("decision" in value && !decisionOk) {
    e.push(err("decision_invalid", "decision",
      `decision must be exactly one of ${PAYMENT_DECISION_DECISIONS.join(" | ")} (got ${JSON.stringify(value.decision)})`));
  }
  const reasonOk = isReasonCode(value.reason_code);
  if ("reason_code" in value && !reasonOk) {
    e.push(err("reason_code_unknown", "reason_code",
      `reason_code must be one of the frozen v1 codes (got ${JSON.stringify(value.reason_code)})`));
  }
  if (decisionOk && reasonOk) {
    const decision = value.decision as PaymentDecisionRecordDecision;
    const code = value.reason_code as PaymentDecisionReasonCode;
    const allowed = allowedDecisions(code);
    if (!allowed.includes(decision)) {
      e.push(decision === "block" && allowed.includes("unavailable")
        ? err("unavailable_as_block", "decision",
            `reason_code ${code} means the evaluator produced no verdict; that is decision "unavailable", never "block"`)
        : err("decision_conflict", "decision",
            `reason_code ${code} may only accompany ${allowed.join(" | ")}, record claims ${JSON.stringify(decision)}`));
    }
  }

  if ("evidence_id" in value && !(typeof value.evidence_id === "string" && OPAQUE_ID_RE.test(value.evidence_id))) {
    e.push(err("invalid_field", "evidence_id", "evidence_id must be an opaque id (1-128 of [A-Za-z0-9._:-])"));
  }
  if ("expires_at" in value) {
    const t = value.expires_at;
    if (!(typeof t === "string" && RFC3339_Z_RE.test(t) && Number.isFinite(Date.parse(t)))) {
      e.push(err("invalid_field", "expires_at", "expires_at must be RFC 3339 UTC with a Z suffix"));
    }
  }

  if ("signature" in value) {
    if (!isObj(value.signature)) {
      e.push(err("invalid_field", "signature", "signature must be an object { alg, key_id, sig }"));
    } else {
      const s = value.signature;
      checkKeys(s, SIGNATURE_FIELDS, "signature", e);
      if ("alg" in s && s.alg !== PAYMENT_DECISION_SIGNATURE_ALG) {
        e.push(err("invalid_field", "signature.alg", `signature.alg must be ${JSON.stringify(PAYMENT_DECISION_SIGNATURE_ALG)}`));
      }
      if ("key_id" in s && !(typeof s.key_id === "string" && KEY_ID_RE.test(s.key_id))) {
        e.push(err("invalid_field", "signature.key_id", "signature.key_id must be 1-64 of [A-Za-z0-9._:-]"));
      }
      if ("sig" in s && !(typeof s.sig === "string" && ED25519_SIG_B64_RE.test(s.sig))) {
        e.push(err("invalid_field", "signature.sig", "signature.sig must be a 64-byte Ed25519 signature in base64 (88 chars)"));
      }
    }
  }
  return e;
}

function isBareOrigin(v: unknown): boolean {
  if (typeof v !== "string" || !v) return false;
  try {
    const u = new URL(v);
    return u.origin !== "null" && u.origin === v && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** (path, kind) pairs where a secret-SHAPED value is the public artifact itself. */
const CONTENT_WAIVERS: ReadonlyArray<{ path: string; kinds: readonly SecretKind[] }> = [
  { path: "challenge_hash", kinds: ["long_hex"] },
  { path: "merchant.pay_to", kinds: ["base58_pubkey", "evm_address"] },
  // CAIP-2 Solana references are the genesis hash in base58 — a chain id, not an account.
  { path: "network", kinds: ["base58_pubkey"] },
  { path: "evidence_id", kinds: ["long_hex"] },
  { path: "signature.key_id", kinds: ["base58_pubkey", "evm_address", "long_hex"] },
  { path: "signature.sig", kinds: ["base58_secret_key", "base58_pubkey", "long_hex"] },
];

function walkStrings(node: unknown, path: string, emit: (path: string, text: string) => void): void {
  if (typeof node === "string") return emit(path || "(root)", node);
  if (Array.isArray(node)) return node.forEach((c, i) => walkStrings(c, `${path}[${i}]`, emit));
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) walkStrings(v, path ? `${path}.${k}` : k, emit);
}

/**
 * Value scan. Reuses the evidence-verify secret rules (PEM, JWT, bearer,
 * env assignment, home path, base58 key material, long hex, EVM address) with
 * this record's own closed waiver list, and adds two rules specific to what
 * this record must never carry:
 *   - any URL other than merchant.origin (a full resource URL, with or
 *     without a query, is committed to by challenge_hash, never carried);
 *   - any base64-encoded JSON (`eyJ…`) — an X-PAYMENT header / PaymentPayload
 *     is a raw authorization, never evidence.
 */
export function scanForbiddenContent(value: unknown): PaymentDecisionVerifyError[] {
  const e: E[] = [];
  for (const f of scanForSecretValues(value)) {
    const waiver = CONTENT_WAIVERS.find((w) => w.path === f.path);
    if (waiver && waiver.kinds.includes(f.kind)) continue;
    // Bundle-level waivers do not apply here; this record has its own closed list.
    e.push(err("forbidden_content", f.path, `${f.kind} at ${f.path}: ${f.preview}`));
  }
  walkStrings(value, "", (path, text) => {
    if (path !== "merchant.origin" && /[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      e.push(err("forbidden_content", path, "URLs are forbidden outside merchant.origin (the resource URL is committed to by challenge_hash)"));
    }
    if (path !== "signature.sig" && /^eyJ/.test(text)) {
      e.push(err("forbidden_content", path, "base64-encoded JSON looks like a raw payment authorization / payload"));
    }
  });
  return e;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/**
 * Accept or reject a record, offline. Every check runs and every failure is
 * reported; `ok` is true only when all of them pass AND a verifier key was
 * supplied. A record with a valid signature but a `block` that is really an
 * `unavailable` is rejected — coherence is not optional.
 */
export function verifyPaymentDecisionRecord(
  value: unknown,
  options: VerifyPaymentDecisionOptions = {},
): PaymentDecisionVerification {
  const now = options.now ?? Date.now();
  const structural = validateRecordStructure(value);
  const forbidden = isObj(value) ? scanForbiddenContent(value) : [];
  const errors: E[] = [...structural, ...forbidden];
  const coherenceCodes = new Set<E["code"]>([
    "decision_missing", "decision_invalid", "decision_conflict", "unavailable_as_block", "reason_code_unknown",
  ]);
  const shapeErrors = structural.filter((x) => !coherenceCodes.has(x.code));
  const coherenceErrors = structural.filter((x) => coherenceCodes.has(x.code));

  const rec = isObj(value) ? value : {};

  let notExpired = false;
  if (typeof rec.expires_at === "string" && RFC3339_Z_RE.test(rec.expires_at)) {
    const exp = Date.parse(rec.expires_at);
    // NaN compares false, so an unparseable expiry fails closed here too.
    notExpired = now < exp;
    if (!notExpired) errors.push(err("expired", "expires_at", `record expired at ${rec.expires_at}`));
  }

  let signatureOk = false;
  const sigBlock = isObj(rec.signature) ? rec.signature : null;
  const keyId = sigBlock && typeof sigBlock.key_id === "string" ? sigBlock.key_id : undefined;
  const pem = (keyId !== undefined ? options.publicKeys?.[keyId] : undefined) ?? options.publicKeyPem;
  if (!pem) {
    errors.push(err("missing_verifier_key", "signature",
      "no verifier key supplied: pass publicKeyPem or publicKeys[key_id]; a record cannot be accepted unverified"));
  } else if (shapeErrors.length === 0 && sigBlock && typeof sigBlock.sig === "string") {
    // Shape is sound, so a preimage exists. The signature is checked even when
    // the decision is incoherent: a relying party must see that a validly
    // signed lie is still a lie (signature: true, ok: false).
    try {
      signatureOk = edVerify(
        null,
        paymentDecisionPreimage(value as PaymentDecisionRecordV1),
        createPublicKey(pem),
        Buffer.from(sigBlock.sig, "base64"),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      errors.push(err("bad_signature", "signature.sig", "Ed25519 signature does not verify over the record preimage"));
    }
  }

  let challengeBound: boolean | null = null;
  if (options.challenge) {
    challengeBound = true;
    const fail = (x: E) => { challengeBound = false; errors.push(x); };
    try {
      const recomputed = challengeHashV1(options.challenge);
      if (recomputed !== rec.challenge_hash) {
        fail(err("challenge_hash_mismatch", "challenge_hash",
          `record commits to a different 402 challenge (recomputed ${recomputed.slice(0, 16)}…)`));
      }
      const merchant = merchantFromChallenge(options.challenge);
      const m = isObj(rec.merchant) ? rec.merchant : {};
      if (m.origin !== merchant.origin || m.pay_to !== merchant.pay_to) {
        fail(err("merchant_mismatch", "merchant", "merchant.origin / merchant.pay_to do not match the supplied challenge"));
      }
      if (rec.scheme !== String(options.challenge.scheme)) {
        fail(err("scheme_mismatch", "scheme", "scheme does not match the supplied challenge"));
      }
      try {
        if (toCaip2Network(String(options.challenge.network)) !== rec.network) {
          fail(err("network_mismatch", "network", "network does not match the supplied challenge (CAIP-2)"));
        }
      } catch {
        fail(err("network_unmappable", "network",
          "the supplied challenge's network is not CAIP-2 and has no known alias; the record's network cannot be checked"));
      }
    } catch (ex) {
      fail(err("challenge_unhashable", "challenge_hash",
        `supplied challenge cannot be normalized: ${ex instanceof Error ? ex.message : String(ex)}`));
    }
  }

  const ok = errors.length === 0;
  return {
    schema: PAYMENT_DECISION_VERIFICATION_SCHEMA,
    ok,
    decision: ok ? (rec.decision as PaymentDecisionRecordDecision) : null,
    reason_code: ok ? (rec.reason_code as PaymentDecisionReasonCode) : null,
    evidence_id: ok ? (rec.evidence_id as string) : null,
    record_digest: createHash("sha256").update(stableStringify(value)).digest("hex"),
    checks: {
      structure: shapeErrors.length === 0,
      forbidden_content: forbidden.length === 0,
      decision_coherent: coherenceErrors.length === 0,
      not_expired: notExpired,
      signature: signatureOk,
      challenge_bound: challengeBound,
    },
    errors,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                   */
/* ------------------------------------------------------------------ */

export function formatPaymentDecisionVerification(r: PaymentDecisionVerification): string {
  const L: string[] = [];
  L.push(`twzrd payment decision — ${r.ok ? "ACCEPT" : "REJECT"}`);
  L.push(`record sha256: ${r.record_digest}`);
  if (r.ok) {
    L.push(`decision: ${r.decision}  reason_code: ${r.reason_code}  evidence_id: ${r.evidence_id}`);
  }
  L.push("");
  const mark = (b: boolean | null) => (b === null ? "[skip]" : b ? "[ok]  " : "[FAIL]");
  L.push(`${mark(r.checks.structure)} structure`);
  L.push(`${mark(r.checks.forbidden_content)} forbidden-content (no score / secret / raw auth / URL)`);
  L.push(`${mark(r.checks.decision_coherent)} decision ∈ {allow, block, warn, unavailable} and coherent with reason_code`);
  L.push(`${mark(r.checks.not_expired)} not expired`);
  L.push(`${mark(r.checks.signature)} Ed25519 signature`);
  L.push(`${mark(r.checks.challenge_bound)} bound to supplied 402 challenge${r.checks.challenge_bound === null ? " (none supplied)" : ""}`);
  for (const e of r.errors) L.push(`  [ERROR] ${e.code} @ ${e.path}: ${e.message}`);
  return L.join("\n");
}

const USAGE =
  "usage: twzrd-payment-decision --verify <record.json> --pubkey <spki.pem> [--challenge <accepts-entry.json>] [--json]\n";

/**
 * `twzrd-payment-decision --verify <record.json> --pubkey <spki.pem> [--challenge <402.json>] [--json]`
 * Offline and deterministic. Exit 0 = accept, 1 = reject, 2 = usage / unreadable input.
 */
export async function mainVerify(argv: string[]): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flagsWithValue = new Set(["--pubkey", "--challenge"]);
  const file = argv.find((a, i) => !a.startsWith("--") && !flagsWithValue.has(argv[i - 1] ?? ""));
  const pubkeyPath = opt("--pubkey");
  if (!file || !pubkeyPath) {
    process.stderr.write(USAGE);
    return 2;
  }
  const read = (p: string, what: string): string | undefined => {
    try {
      return readFileSync(p, "utf8");
    } catch (ex) {
      process.stderr.write(`cannot read ${what} ${p}: ${ex instanceof Error ? ex.message : String(ex)}\n`);
      return undefined;
    }
  };
  const raw = read(file, "record");
  const pem = read(pubkeyPath, "public key");
  if (raw === undefined || pem === undefined) return 2;
  let parsed: unknown;
  let challenge: ResourceBindReq | undefined;
  try {
    parsed = JSON.parse(raw);
    const challengePath = opt("--challenge");
    if (challengePath) {
      const c = read(challengePath, "challenge");
      if (c === undefined) return 2;
      challenge = JSON.parse(c) as ResourceBindReq;
    }
  } catch (ex) {
    process.stderr.write(`invalid JSON: ${ex instanceof Error ? ex.message : String(ex)}\n`);
    return 2;
  }
  const report = verifyPaymentDecisionRecord(parsed, { publicKeyPem: pem, challenge });
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatPaymentDecisionVerification(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

const isCli =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /payment-decision\.(js|ts)$/.test(process.argv[1]);
if (isCli) {
  mainVerify(process.argv.slice(2).filter((a) => a !== "--verify")).then(
    (code) => process.exit(code),
    (ex) => { console.error(ex); process.exit(1); },
  );
}
