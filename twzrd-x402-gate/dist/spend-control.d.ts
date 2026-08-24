import { type SpendLedger } from "./policy-runtime.js";
export type SpendControlOptions = {
    maxSpend?: string;
    allowNetworks?: string[];
    requireOfferBinding?: boolean;
    fetch?: typeof fetch;
    pay?: (args: {
        url: string;
        paymentRequired: unknown;
        selected: Record<string, unknown>;
    }) => Promise<{
        transactionBase64?: string;
        response?: Response;
    }>;
    preflight?: (payTo: string, priceUsdc: number) => Promise<{
        decision?: string;
    }>;
    ledger?: SpendLedger;
    /** Path for #2183 file ledger when `ledger` is omitted. */
    ledgerFile?: string;
    agentId?: string;
    mandateId?: string;
};
export type SpendControlResult = {
    verdict: "allow" | "warn" | "block";
    reason?: string;
    response?: Response;
    receipt?: {
        strength: string;
        leaf_hash: string | null;
        fact_type: "resource_bound";
    };
    signerInvocations: number;
};
export declare function spendControlSafeFetch(url: string, opts?: SpendControlOptions): Promise<SpendControlResult>;
export declare const twzrd: {
    safeFetch: typeof spendControlSafeFetch;
};
//# sourceMappingURL=spend-control.d.ts.map