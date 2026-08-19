/**
 * AutoGate block-proof transcript schema + builder.
 * Used by examples/autogate-block-proof.ts and unit tests.
 */
/**
 * v1 = original block transcript (hook + invariants only).
 * v1.1 = adds execution_mode + resolved peer versions so stock-seat proofs
 * cannot be confused with harness fallback (S1 closure 2026-08-03).
 * v1.2 = adds the operator-signed Decision Outcome Attestation V1
 * (blocked_never_signed) so the refuse is portable signed evidence, not
 * only a JSON transcript. Attached via attachBlockOutcomeAttestation.
 */
export declare const AUTOGATE_BLOCK_PROOF_SCHEMA = "twzrd.autogate_block_proof.v1";
export declare const AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1 = "twzrd.autogate_block_proof.v1.1";
export declare const AUTOGATE_BLOCK_PROOF_SCHEMA_V1_2 = "twzrd.autogate_block_proof.v1.2";
/** How the refuse was exercised — never omit on new S1 artifacts. */
export type ExecutionMode = "x402-solana@2.1.0" | "harness" | "onBeforePaymentCreation";
export type AutogateBlockProof = {
    schema_version: typeof AUTOGATE_BLOCK_PROOF_SCHEMA | typeof AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1 | typeof AUTOGATE_BLOCK_PROOF_SCHEMA_V1_2;
    run_id: string;
    timestamp: string;
    /** twzrd-x402-gate package version */
    package_version: string;
    target_seller: string;
    /**
     * v1.1+: which client path executed. Absent on legacy v1 artifacts — treat
     * missing as "ambiguous (may be harness)".
     */
    execution_mode?: ExecutionMode;
    /**
     * v1.1+: resolved from disk (node_modules/.../package.json), not require()
     * of package.json export (x402-solana blocks that export → "unknown").
     */
    x402_solana_version?: string | null;
    /** v1.1+: true when X402_SOLANA_PROOF=require forced stock path */
    stock_seat_required?: boolean;
    preflight_result: {
        decision: string | null;
        wash_flagged: boolean | null;
        trust_score: number | null;
        internal_reason: string | null;
    };
    interception: {
        /**
         * Seat that aborted:
         * - onBeforePaymentCreation — @x402/core client registrar
         * - beforePayment — PayAI x402-solana createX402Client config seat (2.1.0+)
         */
        hook: "onBeforePaymentCreation" | "beforePayment";
        aborted: boolean;
        reason: string;
        internal_reason: string | null;
    };
    invariants: {
        signer_invocations: number;
        actual_spend_usdc: number;
        onchain_settlements: number;
    };
    /**
     * v1.2+: operator-signed Decision Outcome Attestation V1 over this refuse
     * (outcome=blocked_never_signed, decision_id defaults to run_id). Present
     * only when the transcript's invariants prove signer=0 — see
     * attachBlockOutcomeAttestation.
     */
    outcome_attestation?: import("./outcome-attestation.js").DecisionOutcomeAttestation;
    /** Optional clean-seller negative control (arm B) when recorded on the same run */
    negative_control?: {
        clean_seller: string;
        wash_flagged: boolean | null;
        aborted: boolean;
        decision: string | null;
        reason: string | null;
        signer_invocations: number;
        /** true when clean seller was NOT refused while wash was — discrimination holds */
        passed: boolean;
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
    /** Default onBeforePaymentCreation; pass "beforePayment" for stock PayAI seat proofs */
    hook?: "onBeforePaymentCreation" | "beforePayment";
    /** v1.1: stock seat vs harness — required for new S1 claims */
    execution_mode?: ExecutionMode;
    x402_solana_version?: string | null;
    stock_seat_required?: boolean;
    negative_control?: AutogateBlockProof["negative_control"];
    /**
     * When true (default if execution_mode is set), emit schema v1.1.
     * Legacy callers without execution_mode keep v1 for back-compat.
     */
    schema_v1_1?: boolean;
};
export declare function buildAutogateBlockProof(input: BuildAutogateBlockProofInput): AutogateBlockProof;
/**
 * Upgrade a VERIFIED block proof to v1.2 by attaching the operator-signed
 * `blocked_never_signed` attestation (Decision Outcome Attestation V1).
 *
 * Fail closed: the attestation claims the signer was never invoked, so it
 * attaches ONLY when the transcript's own invariants prove that —
 * `verified === true` (aborted, signer_invocations 0, spend 0, settlements
 * 0). Anything else throws instead of minting a false refuse claim.
 *
 * Returns a NEW proof object (input is not mutated) with schema v1.2 and
 * `outcome_attestation` set. `decision_id` defaults to the proof's run_id;
 * pass `decisionId`/`intentHash` when a DecisionToken covered this refuse
 * so the attestation binds to the exact refused intent.
 */
export declare function attachBlockOutcomeAttestation(proof: AutogateBlockProof, options: {
    signer: import("./decision-token.js").DecisionSigner & {
        publicKeyPem?: string;
    };
    decisionId?: string;
    intentHash?: string | null;
    payer?: string | null;
    preflightId?: number | null;
    timestampUnix?: number;
}): Promise<AutogateBlockProof>;
/**
 * Resolve a package version from node_modules on disk.
 * Prefer this over `require("pkg/package.json")` — some packages (x402-solana)
 * do not export package.json and that path yields "unknown".
 *
 * @param packageName e.g. "x402-solana"
 * @param fromUrl import.meta.url of the caller (or any file under the package)
 */
export declare function resolveInstalledPackageVersion(packageName: string, fromUrl?: string | URL): string | null;
//# sourceMappingURL=block-proof.d.ts.map