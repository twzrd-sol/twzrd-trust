/**
 * Decision Outcome Attestation V1 — client-side builder (refuse side).
 *
 * Byte-exact TypeScript port of the agent-intel leaf discipline
 * (packages/twzrd-agent-intel/docs/DECISION_OUTCOME_ATTESTATION_V1_SPEC.md):
 * keccak256 over a domain-separated, length-prefixed, little-endian preimage.
 * Parity is locked by golden vectors generated from the Python implementation
 * (test/fixtures/decision-outcome-vectors.json) — if the two ever disagree,
 * the vectors fail, not production.
 *
 * WHY THIS LIVES IN THE GATE: `blocked_never_signed` is a claim only the
 * REFUSING side can make first-hand — the gate that held the intent and never
 * invoked the signer. TWZRD's server cannot honestly sign it (it never saw
 * the refuse). So the operator's own DecisionSigner signs the leaf, and
 * relying parties verify against the operator's PUBLISHED decision key
 * (Python: verify_decision_outcome_attestation(..., expected_pubkey=...)).
 * This turns an AutoGate refuse from a JSON transcript into portable signed
 * evidence — the scrub-clean Path B refuse artifact shape.
 *
 * Optional peer: js-sha3 (same keccak dependency as the published
 * twzrd-receipt-verifier). Absent -> clear install error, never a wrong hash.
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { createRequire } from "node:module";

import type { DecisionSigner, PaymentDecision } from "./decision-token.js";

const require = createRequire(import.meta.url);

export const DECISION_OUTCOME_V1_DOMAIN = "TWZRD:AO_DECISION_OUTCOME_V1";

export type OutcomeVerdict = "allow" | "warn" | "block";
export type OutcomeKind = "settled" | "blocked_never_signed" | "expired_unused";

/** Wire codes are frozen; adding a verdict/outcome requires a V2 domain. */
const VERDICT_CODES: Record<OutcomeVerdict, number> = { allow: 1, warn: 2, block: 3 };
const OUTCOME_CODES: Record<OutcomeKind, number> = {
  settled: 1,
  blocked_never_signed: 2,
  expired_unused: 3,
};

export const MAX_DECISION_ID_UTF8 = 128;
export const MAX_COUNTERPARTY_UTF8 = 256;

export type DecisionOutcomeFields = {
  decisionId: string;
  counterparty: string;
  verdict: OutcomeVerdict;
  outcome: OutcomeKind;
  timestampUnix: number;
  /** Gate intentHash — accepts "tiv1:", "0x", or bare 64-hex forms. */
  intentHash?: string | null;
  payer?: string | null;
  settlementTx?: string | null;
  preflightId?: number | null;
};

export type DecisionOutcomeAttestation = {
  leaf: string;
  preimage: {
    domain: string;
    decision_id: string;
    counterparty: string;
    verdict: OutcomeVerdict;
    outcome: OutcomeKind;
    timestamp_unix: number;
    intent_hash: string | null;
    payer: string | null;
    settlement_tx: string | null;
    settlement_anchor: string | null;
    preflight_id: number | null;
  };
  /** base58 Ed25519 signature over the raw 32 leaf bytes (Python-verifier wire form). */
  signature: string | null;
  /** base58 32-byte Ed25519 public key of the OPERATOR's decision signer. */
  signing_pubkey: string | null;
  key_id: string | null;
  signing_alg: string | null;
  signed: boolean;
};

/* ------------------------------------------------------------------ */
/* Lazy optional deps (mirror the gate's optional-peer discipline)     */
/* ------------------------------------------------------------------ */

function keccak256(data: Buffer): Buffer {
  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("js-sha3");
  } catch {
    throw new Error(
      "[twzrd] outcome attestations need js-sha3 (keccak256 — same dep as " +
        "twzrd-receipt-verifier). Install it with: npm i js-sha3",
    );
  }
  return Buffer.from(mod.keccak256.arrayBuffer(data));
}

function base58(): { encode(b: Uint8Array): string; decode(s: string): Uint8Array } {
  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@scure/base");
  } catch {
    throw new Error(
      "[twzrd] outcome attestations need @scure/base (base58). Install it with: npm i @scure/base",
    );
  }
  return mod.base58;
}

/* ------------------------------------------------------------------ */
/* Byte-exact encoding (parity: twzrd_agent_intel/decision_attestation) */
/* ------------------------------------------------------------------ */

function boundedUtf8(value: string, maxBytes: number, field: string): Buffer {
  const raw = Buffer.from(value ?? "", "utf8");
  if (raw.length === 0) throw new Error(`[twzrd] ${field} must be non-empty`);
  if (raw.length > maxBytes) {
    throw new Error(`[twzrd] ${field} exceeds ${maxBytes} utf-8 bytes (got ${raw.length})`);
  }
  const len = Buffer.alloc(2);
  len.writeUInt16LE(raw.length);
  return Buffer.concat([len, raw]);
}

function intentHash32(intentHash: string | null | undefined): Buffer | null {
  if (intentHash === null || intentHash === undefined) return null;
  let s = intentHash.trim().toLowerCase();
  for (const prefix of ["tiv1:", "0x"]) {
    if (s.startsWith(prefix)) s = s.slice(prefix.length);
  }
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new Error("[twzrd] intent_hash must be 64 hex chars (tiv1:/0x prefix accepted)");
  }
  return Buffer.from(s, "hex");
}

/** Parity with Python _pubkey32: base58 32-byte pubkey, else sha256(utf8). */
function pubkey32(payer: string): Buffer {
  try {
    const raw = base58().decode(payer);
    if (raw.length === 32) return Buffer.from(raw);
  } catch {
    /* fall through to synthetic-marker hash */
  }
  return createHash("sha256").update(Buffer.from(payer, "utf8")).digest();
}

/** Parity with Python _anchor32: last-32 ASCII of the tx sig, else left-zero-pad. */
function anchor32(settlementTx: string | null | undefined): Buffer | null {
  if (!settlementTx) return null;
  const raw = Buffer.from(settlementTx, "utf8");
  if (raw.length >= 32) return raw.subarray(raw.length - 32);
  return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
}

/** 1-byte presence flag ++ fixed 32 bytes only when present (V6 discipline). */
function opt32(value: Buffer | null): Buffer {
  if (value === null) return Buffer.from([0]);
  if (value.length !== 32) {
    throw new Error(`[twzrd] optional 32-byte field got ${value.length} bytes`);
  }
  return Buffer.concat([Buffer.from([1]), value]);
}

function checkContract(
  verdict: OutcomeVerdict,
  outcome: OutcomeKind,
  hasAnchor: boolean,
  hasPayer: boolean,
): void {
  if (!(verdict in VERDICT_CODES)) throw new Error(`[twzrd] unknown verdict ${verdict}`);
  if (!(outcome in OUTCOME_CODES)) throw new Error(`[twzrd] unknown outcome ${outcome}`);
  if (outcome === "settled") {
    if (!hasAnchor) throw new Error("[twzrd] outcome=settled requires a settlement anchor");
    if (!hasPayer) throw new Error("[twzrd] outcome=settled requires a payer");
    if (verdict === "block") {
      throw new Error("[twzrd] outcome=settled contradicts verdict=block (gate breach shape)");
    }
  } else {
    if (hasAnchor) {
      throw new Error(`[twzrd] outcome=${outcome} must NOT carry a settlement anchor`);
    }
    if (outcome === "blocked_never_signed" && verdict !== "block") {
      throw new Error("[twzrd] outcome=blocked_never_signed requires verdict=block");
    }
    if (outcome === "expired_unused" && verdict === "block") {
      throw new Error("[twzrd] outcome=expired_unused requires verdict in {allow, warn}");
    }
  }
}

export function computeDecisionOutcomeLeafV1(fields: DecisionOutcomeFields): Buffer {
  const { decisionId, counterparty, verdict, outcome, timestampUnix } = fields;
  checkContract(
    verdict,
    outcome,
    Boolean(fields.settlementTx),
    fields.payer !== null && fields.payer !== undefined,
  );
  if (!Number.isInteger(timestampUnix) || timestampUnix < 0) {
    throw new Error("[twzrd] timestamp_unix must be a non-negative integer");
  }
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestampUnix));
  let preflight: Buffer;
  if (fields.preflightId === null || fields.preflightId === undefined) {
    preflight = Buffer.from([0]);
  } else {
    if (!Number.isInteger(fields.preflightId) || fields.preflightId < 0) {
      throw new Error("[twzrd] preflight_id must be a non-negative integer");
    }
    const v = Buffer.alloc(8);
    v.writeBigUInt64LE(BigInt(fields.preflightId));
    preflight = Buffer.concat([Buffer.from([1]), v]);
  }
  const preimage = Buffer.concat([
    Buffer.from(DECISION_OUTCOME_V1_DOMAIN, "utf8"),
    boundedUtf8(decisionId, MAX_DECISION_ID_UTF8, "decision_id"),
    boundedUtf8(counterparty, MAX_COUNTERPARTY_UTF8, "counterparty"),
    Buffer.from([VERDICT_CODES[verdict]]),
    Buffer.from([OUTCOME_CODES[outcome]]),
    ts,
    opt32(intentHash32(fields.intentHash)),
    opt32(fields.payer !== null && fields.payer !== undefined ? pubkey32(fields.payer) : null),
    opt32(anchor32(fields.settlementTx)),
    preflight,
  ]);
  return keccak256(preimage);
}

/** SPKI DER prefix for a raw Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawPubkeyFromPem(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

/**
 * Sign a complete attestation over the given fields with the OPERATOR's own
 * signer (leaf recomputed here, so the preimage and leaf can never drift).
 * Prefer the intent-specific wrappers; this is the shared primitive.
 */
export async function buildOutcomeAttestation(
  fields: DecisionOutcomeFields,
  signer: DecisionSigner & { publicKeyPem?: string },
): Promise<DecisionOutcomeAttestation> {
  const leaf = computeDecisionOutcomeLeafV1(fields);
  const b58 = base58();
  const signature = Buffer.from(await signer.sign(leaf));
  if (signature.length !== 64) {
    throw new Error(
      `[twzrd] decision signer produced a ${signature.length}-byte signature (expected 64)`,
    );
  }
  const signingPubkey = signer.publicKeyPem
    ? b58.encode(rawPubkeyFromPem(signer.publicKeyPem))
    : null;
  const anchor = anchor32(fields.settlementTx);
  return {
    leaf: "0x" + leaf.toString("hex"),
    preimage: {
      domain: DECISION_OUTCOME_V1_DOMAIN,
      decision_id: fields.decisionId,
      counterparty: fields.counterparty,
      verdict: fields.verdict,
      outcome: fields.outcome,
      timestamp_unix: fields.timestampUnix,
      intent_hash: fields.intentHash ?? null,
      payer: fields.payer ?? null,
      settlement_tx: fields.settlementTx ?? null,
      settlement_anchor: anchor ? anchor.toString("hex") : null,
      preflight_id: fields.preflightId ?? null,
    },
    signature: b58.encode(signature),
    signing_pubkey: signingPubkey,
    key_id: signer.keyId,
    signing_alg: "ed25519",
    signed: true,
  };
}

/**
 * Build the operator-signed `blocked_never_signed` attestation from a BLOCK
 * DecisionToken — the moment the gate refused and the signer was never
 * invoked. The attestation reuses the token's decisionId and intentHash, so
 * the refuse evidence is bound to the EXACT intent that was refused.
 *
 * The signer is the operator's own DecisionSigner (same key that signed the
 * token). Relying parties verify against that operator's published key —
 * `signing_pubkey` here is convenience, never the trust anchor.
 */
export async function buildBlockedNeverSignedAttestation(
  token: PaymentDecision,
  options: {
    /** The refused counterparty (payTo wallet / agent id). */
    counterparty: string;
    signer: DecisionSigner & { publicKeyPem?: string };
    timestampUnix?: number;
    payer?: string | null;
    preflightId?: number | null;
  },
): Promise<DecisionOutcomeAttestation> {
  if (token.decision !== "block") {
    throw new Error(
      `[twzrd] blocked_never_signed attestation requires a BLOCK token (got ${token.decision})`,
    );
  }
  return buildOutcomeAttestation(
    {
      decisionId: token.decisionId,
      counterparty: options.counterparty,
      verdict: "block",
      outcome: "blocked_never_signed",
      timestampUnix: options.timestampUnix ?? Math.floor(Date.now() / 1000),
      intentHash: token.intentHash,
      payer: options.payer ?? null,
      settlementTx: null,
      preflightId: options.preflightId ?? null,
    },
    options.signer,
  );
}

/**
 * Offline check of an attestation's Ed25519 signature against a base58
 * 32-byte public key — the TS twin of the Python verifier's authenticity
 * step. Anchor trust on the key YOU expect (the operator's published key),
 * never on the attestation's own signing_pubkey.
 */
export function verifyOutcomeAttestationSignature(
  attestation: Pick<DecisionOutcomeAttestation, "leaf" | "signature">,
  expectedPubkeyB58: string,
): boolean {
  const leafHex = (attestation.leaf || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(leafHex) || !attestation.signature) return false;
  try {
    const b58 = base58();
    const pubRaw = Buffer.from(b58.decode(expectedPubkeyB58));
    if (pubRaw.length !== 32) return false;
    const sig = Buffer.from(b58.decode(attestation.signature));
    if (sig.length !== 64) return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, pubRaw]);
    return edVerify(
      null,
      Buffer.from(leafHex, "hex"),
      createPublicKey({ key: spki, format: "der", type: "spki" }),
      sig,
    );
  } catch {
    return false;
  }
}
