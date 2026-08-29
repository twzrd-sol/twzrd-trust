export declare const DECISION_LEDGER_SCHEMA_VERSION = 1;
export type DecisionLedgerRow = {
    schema_version: typeof DECISION_LEDGER_SCHEMA_VERSION;
    decision_id: string;
    at_unix_ms: number;
    outcome: "allow" | "warn" | "block" | "error";
    reason_codes: string[];
    policy_version: string;
    input: {
        pay_to?: string;
        resource?: string;
        network?: string;
        amount_micro?: string;
    };
    signer_invocations: number;
    latency_ms?: number;
    error?: {
        code: string;
        message?: string;
    };
    settlement?: {
        status: "pending" | "settled" | "failed";
        tx?: string;
    };
};
export type RecordDecisionInput = Omit<DecisionLedgerRow, "schema_version" | "decision_id" | "at_unix_ms"> & {
    decision_id?: string;
    at_unix_ms?: number;
};
export declare function createFileDecisionLedger(filePath: string): {
    record(input: RecordDecisionInput): DecisionLedgerRow;
};
//# sourceMappingURL=decision-ledger-file.d.ts.map