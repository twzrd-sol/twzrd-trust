export declare const REPUTATION_V5_DOMAIN = "TWZRD:AO_REPUTATION_RECEIPT_V5";
export declare const ATTENTION_V5_DOMAIN = "TWZRD:AO_ATTENTION_RECEIPT_V5";
export declare const REPUTATION_V6_DOMAIN = "TWZRD:AO_REPUTATION_RECEIPT_V6";
export declare const ATTENTION_V6_DOMAIN = "TWZRD:AO_ATTENTION_RECEIPT_V6";
export declare const REPUTATION_V7_DOMAIN = "TWZRD:AO_REPUTATION_RECEIPT_V7";
export declare const CURRENT_RECEIPT_PUBKEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS";
export declare const CURRENT_RECEIPT_KEY_ID = "twzrd-receipt-ed25519-v2";
export type ReceiptVersion = 'v7' | 'v6' | 'v5' | 'unknown';
/** V7 binds freshness. V6 freshness is advisory only. V5 also leaves provenance unsigned. */
export type FreshnessStatus = 'signed' | 'derived_from_timestamp' | 'unauthenticated';
export type TwzrdReceiptLike = {
    version?: string;
    kind?: string;
    leaf?: string;
    preimage?: Record<string, unknown>;
    signature?: string;
    signing_pubkey?: string;
    key_id?: string;
    signing_alg?: string;
    [k: string]: unknown;
};
export type VerifyReceiptResult = {
    valid: boolean;
    leafValid: boolean;
    signatureValid: boolean;
    trustedPubkey: string;
    errors: string[];
    receiptVersion: ReceiptVersion;
    freshness: FreshnessStatus;
    freshnessUnauthenticated: boolean;
    unauthenticatedFields: string[];
    recomputedLeaf?: string;
    boundFreshnessCard?: string;
    verifiedBy: 'twzrd-receipt-verifier';
};
export declare function classifyReceipt(receipt: TwzrdReceiptLike | null | undefined): ReceiptVersion;
/**
 * Surface policy for a classified version. Not a verify result — V7 here means
 * "this domain *would* bind freshness if the verifier returns valid".
 */
export declare function freshnessStatusFor(version: ReceiptVersion): FreshnessStatus;
/**
 * Agent-facing freshness after offline verify. `signed` only when the verifier
 * authenticated a V7 leaf (`valid` and `freshness_unauthenticated === false`).
 * Missing `freshness_unauthenticated` is treated as unauthenticated (fail closed).
 */
export declare function freshnessFromVerify(result: {
    valid: boolean;
    freshnessUnauthenticated: boolean;
    receiptVersion: ReceiptVersion;
}): FreshnessStatus;
/** Classify from domain and report that version's surface policy. Not a verify. */
export declare function describeReceiptSurface(receipt: TwzrdReceiptLike | null | undefined): {
    version: ReceiptVersion;
    freshness: FreshnessStatus;
    label: string;
    detail: string;
};
export type VerifyReceiptOptions = {
    trustedPubkey?: string;
    maxAgeSeconds?: number;
};
/**
 * Offline-verify a V5, V6, or V7 receipt with twzrd-receipt-verifier.
 * Defaults to the current v2 issuer key. Does not use the SDK V5/V6 path.
 */
export declare function verifyReceipt(receipt: TwzrdReceiptLike, opts?: VerifyReceiptOptions): VerifyReceiptResult;
export declare function formatVerifyResult(result: VerifyReceiptResult): string;
