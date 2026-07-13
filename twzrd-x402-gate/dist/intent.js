/**
 * TWZRD Payment Control — PaymentIntent v1 (FROZEN).
 *
 * The canonical, protocol-neutral description of one autonomous payment,
 * evaluated exactly once at the last deterministic checkpoint before signing.
 *
 * Defining invariant (honest scope): a signer path that calls
 * assertIntentApproved will not sign an intent that differs from what TWZRD
 * evaluated. TWZRD does not own third-party wallets - the binding holds
 * exactly where the check runs before the signer. Everything that
 * identifies the transaction — payee, resource, amount, asset, network,
 * facilitator, method, mandate, recurrence context — is bound into ONE
 * canonical intent hash. `hash(intent being signed) === decision.intentHash`
 * or the wallet refuses.
 *
 * v1 is frozen: field additions require a new hash prefix (tiv2:), never a
 * silent change to canonicalization.
 */
import { createHash } from "node:crypto";
export const INTENT_HASH_PREFIX = "tiv1:";
const INTENT_DOMAIN = "twzrd-intent-v1\n";
/**
 * Canonical JSON (frozen with v1):
 * - object keys sorted lexicographically (code-unit order)
 * - `undefined` and `null` members omitted
 * - arrays keep order; `undefined`/`null` elements are rejected
 * - numbers must be finite (money fields are strings by type)
 * - no insignificant whitespace
 */
export function canonicalJson(value) {
    if (value === null || value === undefined) {
        throw new Error("[twzrd] canonicalJson: top-level null/undefined");
    }
    return serialize(value);
}
function serialize(value) {
    if (value === null || value === undefined) {
        throw new Error("[twzrd] canonicalJson: null/undefined array element");
    }
    const t = typeof value;
    if (t === "string" || t === "boolean")
        return JSON.stringify(value);
    if (t === "number") {
        if (!Number.isFinite(value)) {
            throw new Error("[twzrd] canonicalJson: non-finite number");
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(serialize).join(",")}]`;
    }
    if (t === "object") {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined && v !== null)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
        return `{${entries.join(",")}}`;
    }
    throw new Error(`[twzrd] canonicalJson: unsupported type ${t}`);
}
/** sha256 over the domain-separated canonical form, `tiv1:`-prefixed hex. */
export function intentHash(intent) {
    const canonical = canonicalJson(intent);
    const digest = createHash("sha256")
        .update(INTENT_DOMAIN)
        .update(canonical)
        .digest("hex");
    return `${INTENT_HASH_PREFIX}${digest}`;
}
/**
 * Parse a decimal money string into micro-units (6dp) as bigint.
 * Rejects floats-by-stealth: only `[digits].[<=6 digits]` accepted.
 */
export function toMicroUsd(amount) {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
    if (!m)
        throw new Error(`[twzrd] bad decimal amount: ${JSON.stringify(amount)}`);
    const whole = BigInt(m[1]);
    const frac = BigInt((m[2] ?? "").padEnd(6, "0") || "0");
    return whole * 1000000n + frac;
}
//# sourceMappingURL=intent.js.map