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
import { createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomUUID, sign as edSign, verify as edVerify, } from "node:crypto";
import { canonicalJson, intentHash } from "./intent.js";
const DECISION_DOMAIN = "twzrd-decision-v1\n";
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
export function normalizeCitedOutcomes(leaves) {
    if (leaves.length > MAX_CITED_OUTCOMES) {
        throw new Error(`[twzrd] citedOutcomes exceeds MAX_CITED_OUTCOMES=${MAX_CITED_OUTCOMES} (got ${leaves.length})`);
    }
    const seen = new Set();
    return leaves.map((leaf) => {
        const norm = leaf.trim().toLowerCase();
        if (!CITED_OUTCOME_LEAF_RE.test(norm)) {
            throw new Error(`[twzrd] cited outcome leaf must be "0x" + 64 hex chars (got ${JSON.stringify(leaf)})`);
        }
        if (seen.has(norm)) {
            throw new Error(`[twzrd] duplicate cited outcome leaf: ${norm}`);
        }
        seen.add(norm);
        return norm;
    });
}
/** Everything signed — the token minus the signature itself. */
export function decisionPreimage(token) {
    return Buffer.concat([
        Buffer.from(DECISION_DOMAIN, "utf8"),
        Buffer.from(canonicalJson(token), "utf8"),
    ]);
}
/**
 * Local Ed25519 decision signer. Pass a PKCS#8 PEM to pin a key; otherwise an
 * ephemeral keypair is generated (fine for tests and per-process runtimes).
 */
export function createLocalDecisionSigner(options) {
    let privateKey;
    if (options?.privateKeyPem) {
        privateKey = createPrivateKey(options.privateKeyPem);
    }
    else {
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
function decodeKeyMaterial(secret) {
    if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
        return Buffer.from(secret, "hex");
    }
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(secret)) {
        const buf = Buffer.from(secret, "base64");
        if (buf.length < MIN_SECRET_BYTES)
            return Buffer.alloc(0);
        // Round-trip guard: a genuine base64 encoding re-encodes to itself, but a
        // memorable passphrase that merely happens to use the base64 alphabet
        // (e.g. "MySuperSecretSigningKey2026Production") does NOT — it round-trips
        // to different bytes. Without this check the length + byte-entropy floors
        // both pass for such a passphrase (ASCII text looks high-entropy per byte),
        // and a guessable secret is exactly the offline-forgery target we reject.
        const normalize = (s) => s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
        if (buf.toString("base64").replace(/=+$/, "") !== normalize(secret)) {
            return Buffer.alloc(0);
        }
        return buf;
    }
    return Buffer.alloc(0);
}
/** Shannon entropy per byte. Real random material sits near 8; "aaaa…" sits at 0. */
function entropyBitsPerByte(buf) {
    if (buf.length === 0)
        return 0;
    const counts = new Map();
    for (const b of buf)
        counts.set(b, (counts.get(b) ?? 0) + 1);
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
export function createSeededDecisionSigner(secret, keyId) {
    if (!secret)
        throw new Error("[twzrd] decision secret must be non-empty");
    const ikm = decodeKeyMaterial(secret);
    if (ikm.length < MIN_SECRET_BYTES) {
        throw new Error(`[twzrd] decision secret must carry >=${MIN_SECRET_BYTES} bytes of high-entropy key material, ` +
            "hex or base64 encoded (generate with: openssl rand -hex 32). " +
            "Passphrases are rejected: the decision public key is published, so a guessable " +
            "secret lets an attacker brute-force the signing key offline and forge ALLOW decisions.");
    }
    if (entropyBitsPerByte(ikm) < 3) {
        throw new Error("[twzrd] decision secret decodes to low-entropy material (repeated/patterned bytes). " +
            "Generate real key material: openssl rand -hex 32");
    }
    // Domain-separated derivation: this IKM cannot collide with any other TWZRD
    // key derived from the same secret.
    const seed = Buffer.from(hkdfSync("sha256", ikm, Buffer.from(SEED_SALT), Buffer.from(SEED_INFO), 32));
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
export async function signDecision(unsigned, signer) {
    const payload = { ...unsigned, keyId: signer.keyId };
    const signature = Buffer.from(await signer.sign(decisionPreimage(payload))).toString("base64");
    return { ...payload, signature };
}
export function verifyDecisionSignature(token, publicKeyPem) {
    const { signature, ...payload } = token;
    try {
        return edVerify(null, decisionPreimage(payload), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
    }
    catch {
        return false;
    }
}
export class TwzrdIntentBindingError extends Error {
    code;
    decisionId;
    constructor(code, decisionId, detail) {
        super(`[twzrd] ${code}: ${detail} (decisionId=${decisionId})`);
        this.name = "TwzrdIntentBindingError";
        this.code = code;
        this.decisionId = decisionId;
    }
}
/** In-process consume-once ledger. Entries expire with the tokens. */
export function createDecisionRegistry() {
    const consumed = new Set();
    return {
        consume(decisionId) {
            if (consumed.has(decisionId))
                return false;
            consumed.add(decisionId);
            return true;
        },
    };
}
/**
 * The wallet-side check. Call with the EXACT intent about to be signed.
 * Throws TwzrdIntentBindingError on any violation; returns void when the
 * signature may proceed. A caught error means: do not invoke the signer.
 */
export function assertIntentApproved(intent, token, options) {
    const now = options?.now ?? Date.now();
    if (options?.publicKeyPem && !verifyDecisionSignature(token, options.publicKeyPem)) {
        throw new TwzrdIntentBindingError("BAD_SIGNATURE", token.decisionId, "decision token signature did not verify");
    }
    if (token.decision !== "allow" && token.decision !== "warn") {
        throw new TwzrdIntentBindingError("DECISION_NOT_ALLOW", token.decisionId, `decision is ${token.decision}`);
    }
    if (now >= Date.parse(token.expiresAt)) {
        throw new TwzrdIntentBindingError("DECISION_EXPIRED", token.decisionId, `expired at ${token.expiresAt}`);
    }
    const actual = intentHash(intent);
    if (actual !== token.intentHash) {
        throw new TwzrdIntentBindingError("INTENT_HASH_MISMATCH", token.decisionId, `approved ${token.intentHash} but signing ${actual}`);
    }
    if (options?.registry && !options.registry.consume(token.decisionId)) {
        throw new TwzrdIntentBindingError("DECISION_REPLAYED", token.decisionId, "decision token already consumed");
    }
}
export function newDecisionId() {
    return randomUUID();
}
//# sourceMappingURL=decision-token.js.map