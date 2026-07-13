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
import { type PaymentIntent } from "./intent.js";
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
    constraints?: DecisionConstraints;
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
/** Everything signed — the token minus the signature itself. */
export declare function decisionPreimage(token: Omit<PaymentDecision, "signature">): Buffer;
/**
 * Local Ed25519 decision signer. Pass a PKCS#8 PEM to pin a key; otherwise an
 * ephemeral keypair is generated (fine for tests and per-process runtimes).
 */
export declare function createLocalDecisionSigner(options?: {
    privateKeyPem?: string;
    keyId?: string;
}): DecisionSigner & {
    publicKeyPem: string;
};
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
export declare function createSeededDecisionSigner(secret: string, keyId?: string): DecisionSigner & {
    publicKeyPem: string;
};
export declare function signDecision(unsigned: Omit<PaymentDecision, "signature" | "keyId">, signer: DecisionSigner): Promise<PaymentDecision>;
export declare function verifyDecisionSignature(token: PaymentDecision, publicKeyPem: string): boolean;
export type BindingErrorCode = "INTENT_HASH_MISMATCH" | "DECISION_EXPIRED" | "DECISION_NOT_ALLOW" | "DECISION_REPLAYED" | "BAD_SIGNATURE";
export declare class TwzrdIntentBindingError extends Error {
    readonly code: BindingErrorCode;
    readonly decisionId: string;
    constructor(code: BindingErrorCode, decisionId: string, detail: string);
}
export type DecisionRegistry = {
    /** True exactly once per decisionId; false on every replay. */
    consume(decisionId: string): boolean;
};
/** In-process consume-once ledger. Entries expire with the tokens. */
export declare function createDecisionRegistry(): DecisionRegistry;
export type AssertIntentApprovedOptions = {
    now?: number;
    /** Enforce consume-once semantics (recommended for anything non-idempotent). */
    registry?: DecisionRegistry;
    /** Verify the token signature against this key before trusting it. */
    publicKeyPem?: string;
};
/**
 * The wallet-side check. Call with the EXACT intent about to be signed.
 * Throws TwzrdIntentBindingError on any violation; returns void when the
 * signature may proceed. A caught error means: do not invoke the signer.
 */
export declare function assertIntentApproved(intent: PaymentIntent, token: PaymentDecision, options?: AssertIntentApprovedOptions): void;
export declare function newDecisionId(): string;
//# sourceMappingURL=decision-token.d.ts.map