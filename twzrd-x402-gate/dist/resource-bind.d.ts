export declare const RESOURCE_BIND_DOMAIN = "twzrd:x402-resource-binding:v1";
export declare const RESOURCE_BIND_EXTRA_KEY = "twzrd_resource_bind";
export declare const RESOURCE_BIND_MEMO_PREFIX = "rb1:";
/** Memo program CU ≈ 1320 + 358*bytes. 48 B ≈ 18.5k < ExactSvm 20k budget. */
export declare const RESOURCE_BIND_MEMO_MAX = 48;
export declare const ZERO_BODY_HASH: string;
/** v1 402 JSON body keyed by request URL and accepts[].resource. Header is CAIP. */
export declare const rawInvoiceByResource: Map<string, unknown>;
export declare function rememberRawInvoice(body: unknown, requestUrl?: string): void;
export declare function wrapFetchRememberInvoice(inner: typeof fetch): typeof fetch;
export type BindStrength = "hard" | "soft" | "refuse";
export type ResourceBindReq = {
    payTo?: string;
    pay_to?: string;
    network?: string;
    amount?: string;
    maxAmountRequired?: string;
    asset?: string;
    resource?: string;
    scheme?: string;
    extra?: Record<string, unknown>;
};
export type ResourceBindDecision = {
    strength: BindStrength;
    evidence_level: "tx_included" | "client_stamped" | "unbound";
    fact_type: "resource_bound";
    leaf_hash: string | null;
    extra_stamped: boolean;
    reason: string;
};
export declare function canonicalResourceUrl(url: string): string;
/** Match only. Hash still uses the raw 402 string. */
export declare function networksEquivalent(a?: string, b?: string): boolean;
/** Raw accepts[] entry matching selected (payTo/amount/asset, tolerant network). */
export declare function rawReqFromPaymentRequired(paymentRequired: unknown, selected: ResourceBindReq): ResourceBindReq | null;
export declare function resourceBindLeafHash(req: ResourceBindReq): string;
export declare function resourceBindMemo(leaf_hash: string): string;
export declare function memoContainsResourceBind(memo: string, leaf_hash: string): boolean;
export declare function stampResourceBind(req: ResourceBindReq, paymentRequired?: unknown): ResourceBindDecision;
export declare function evaluateResourceBind(obs: {
    leaf_hash: string;
    tx_contains_hash?: boolean;
    body_hash?: string;
    extra_stamped?: boolean;
    /** UTF-8 payload of the settled tx Memo IX. Not extra.memo. */
    tx_memo?: string;
}): ResourceBindDecision;
//# sourceMappingURL=resource-bind.d.ts.map