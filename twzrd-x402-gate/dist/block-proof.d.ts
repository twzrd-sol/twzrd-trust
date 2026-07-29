/**
 * AutoGate block-proof transcript schema + builder.
 * Used by examples/autogate-block-proof.ts and unit tests.
 */
export declare const AUTOGATE_BLOCK_PROOF_SCHEMA = "twzrd.autogate_block_proof.v1";
export type AutogateBlockProof = {
    schema_version: typeof AUTOGATE_BLOCK_PROOF_SCHEMA;
    run_id: string;
    timestamp: string;
    package_version: string;
    target_seller: string;
    preflight_result: {
        decision: string | null;
        wash_flagged: boolean | null;
        trust_score: number | null;
        internal_reason: string | null;
    };
    interception: {
        hook: "onBeforePaymentCreation";
        aborted: boolean;
        reason: string;
        internal_reason: string | null;
    };
    invariants: {
        signer_invocations: number;
        actual_spend_usdc: number;
        onchain_settlements: number;
    };
    verified: boolean;
};
export type BuildAutogateBlockProofInput = {
    run_id: string;
    target_seller: string;
    aborted: boolean;
    /** Internal policy reason (e.g. twzrd_wash_flagged) or full hook abort string */
    internal_reason: string | null;
    decision?: string | null;
    wash_flagged?: boolean | null;
    trust_score?: number | null;
    signer_invocations: number;
    actual_spend_usdc?: number;
    onchain_settlements?: number;
    package_version?: string;
    now?: () => Date;
};
export declare function buildAutogateBlockProof(input: BuildAutogateBlockProofInput): AutogateBlockProof;
//# sourceMappingURL=block-proof.d.ts.map