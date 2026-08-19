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
import type { DecisionSigner, PaymentDecision } from "./decision-token.js";
export declare const DECISION_OUTCOME_V1_DOMAIN = "TWZRD:AO_DECISION_OUTCOME_V1";
export type OutcomeVerdict = "allow" | "warn" | "block";
export type OutcomeKind = "settled" | "blocked_never_signed" | "expired_unused";
export declare const MAX_DECISION_ID_UTF8 = 128;
export declare const MAX_COUNTERPARTY_UTF8 = 256;
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
export declare function computeDecisionOutcomeLeafV1(fields: DecisionOutcomeFields): Buffer;
/**
 * Sign a complete attestation over the given fields with the OPERATOR's own
 * signer (leaf recomputed here, so the preimage and leaf can never drift).
 * Prefer the intent-specific wrappers; this is the shared primitive.
 */
export declare function buildOutcomeAttestation(fields: DecisionOutcomeFields, signer: DecisionSigner & {
    publicKeyPem?: string;
}): Promise<DecisionOutcomeAttestation>;
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
export declare function buildBlockedNeverSignedAttestation(token: PaymentDecision, options: {
    /** The refused counterparty (payTo wallet / agent id). */
    counterparty: string;
    signer: DecisionSigner & {
        publicKeyPem?: string;
    };
    timestampUnix?: number;
    payer?: string | null;
    preflightId?: number | null;
}): Promise<DecisionOutcomeAttestation>;
/**
 * Offline check of an attestation's Ed25519 signature against a base58
 * 32-byte public key — the TS twin of the Python verifier's authenticity
 * step. Anchor trust on the key YOU expect (the operator's published key),
 * never on the attestation's own signing_pubkey.
 */
export declare function verifyOutcomeAttestationSignature(attestation: Pick<DecisionOutcomeAttestation, "leaf" | "signature">, expectedPubkeyB58: string): boolean;
//# sourceMappingURL=outcome-attestation.d.ts.map