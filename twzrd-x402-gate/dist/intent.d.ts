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
export type PaymentProtocol = "x402" | "ap2" | "ucp" | "mpp" | "direct";
export type PaymentIntent = {
    protocol: PaymentProtocol;
    /** CAIP-2 where applicable (e.g. "solana:5eykt4...", "eip155:8453"). */
    network: string;
    /** Asset identifier (mint / contract / ISO code for fiat-denominated mandates). */
    asset: string;
    /** Decimal string. Money is NEVER a float. */
    amount: string;
    /** Receiving counterparty (wallet, contract, merchant account). */
    payTo: string;
    resource?: {
        url?: string;
        method?: string;
        operation?: string;
        /** Hash of the exact request body when the resource is request-bound. */
        requestHash?: string;
    };
    facilitator?: string;
    agent?: {
        id?: string;
        organization?: string;
        mandateId?: string;
    };
    context?: {
        purpose?: string;
        recurring?: boolean;
        /** Prior charge for this recurring counterparty, decimal string. */
        priorSpend?: string;
        /** ISO-8601 expiry of the intent itself. */
        expiresAt?: string;
    };
};
export declare const INTENT_HASH_PREFIX = "tiv1:";
/**
 * Canonical JSON (frozen with v1):
 * - object keys sorted lexicographically (code-unit order)
 * - `undefined` and `null` members omitted
 * - arrays keep order; `undefined`/`null` elements are rejected
 * - numbers must be finite (money fields are strings by type)
 * - no insignificant whitespace
 */
export declare function canonicalJson(value: unknown): string;
/** sha256 over the domain-separated canonical form, `tiv1:`-prefixed hex. */
export declare function intentHash(intent: PaymentIntent): string;
/**
 * Parse a decimal money string into micro-units (6dp) as bigint.
 * Rejects floats-by-stealth: only `[digits].[<=6 digits]` accepted.
 */
export declare function toMicroUsd(amount: string): bigint;
//# sourceMappingURL=intent.d.ts.map