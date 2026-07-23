/**
 * Gate Adoption Proof Harness — deterministic, no-spend, package-local.
 *
 * Closes the install→transcript gap for operators who already installed
 * installTwzrdX402ClientHook / installTwzrdAutoGate:
 *   1) exact selectedRequirements reach the pre-sign hook
 *   2) onDecision emits a verdict
 *   3) block path aborts and never invokes a wallet/signer stub
 *   4) attribution (integration + runId + client) is stamped on preflight only
 *
 * This harness is correlation / integration evidence. It is NOT EXTERNAL_RUN
 * by itself (see docs/strategy/gate-adoption-operator-proof.md).
 */
import { type X402SelectedRequirements } from "./x402-client-hook.js";
export declare const ADOPTION_TRANSCRIPT_SCHEMA: "twzrd.gate_adoption_transcript.v1";
/** Fixture merchant pubkey (base58-shaped); not a live spend target. */
export declare const ADOPTION_PROOF_SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
export declare const ADOPTION_PROOF_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export declare const ADOPTION_PROOF_RESOURCE = "https://merchant.example/twzrd-adoption-proof";
export type GateAdoptionStepName = "block_path" | "allow_path";
export type GateAdoptionStep = {
    name: GateAdoptionStepName;
    selectedRequirements: X402SelectedRequirements;
    abort: boolean;
    reason?: string;
    decisionEmitted: boolean;
    verdict: string;
    approved: boolean;
    /**
     * payTo as reported by the hook's onDecision callback (hook-derived).
     * Used to prove selectedRequirements reached the real hook path — not
     * merely echoed from harness-local selectedRequirements.
     */
    hookPayTo?: string;
    /**
     * seller_wallet from the preflight JSON body the hook actually POSTed
     * (hook-derived via mocked fetch recorder).
     */
    preflightSellerWallet?: string | null;
    /** Count of wallet/signer stub invocations during this step (must be 0). */
    signerInvocations: number;
    /** Headers observed on the mocked preflight fetch for this step. */
    preflightAttribution: {
        integration: string | null;
        runId: string | null;
        client: string | null;
    };
};
export type GateAdoptionAssertions = {
    selectedRequirementReachedHook: boolean;
    decisionEmitted: boolean;
    blockedPathNeverInvokesSigner: boolean;
    allowPathNeverInvokesSigner: boolean;
    attributionSurfaced: boolean;
};
/**
 * Lineage of this transcript.
 * - dogfood: package harness, CI, or TWZRD-authored run
 * - external_candidate: operator-supplied integration id (still needs server-side join for EXTERNAL_RUN)
 */
export type GateAdoptionLineage = "dogfood" | "external_candidate";
export type GateAdoptionTranscript = {
    schema: typeof ADOPTION_TRANSCRIPT_SCHEMA;
    package: "twzrd-x402-gate";
    packageVersion: string;
    proofKind: "local_deterministic_harness";
    mode: "no_spend";
    integration: string;
    runId: string;
    lineage: GateAdoptionLineage;
    clientHeader: string;
    steps: GateAdoptionStep[];
    assertions: GateAdoptionAssertions;
    ok: boolean;
    /**
     * What this transcript is NOT. Operators must not treat package downloads,
     * free preflight hits alone, or self-authored runIds as EXTERNAL_RUN.
     */
    notExternalRunProof: string[];
    /** Human pointer to the acceptance contract. */
    acceptanceDoc: "docs/strategy/gate-adoption-operator-proof.md";
};
export type RunGateAdoptionProofOptions = {
    /** Stable integration label (e.g. "acme-agent-v1"). Default dogfood label. */
    integration?: string;
    /** Per-run id. Default random UUID. Echo in your issue / transcript. */
    runId?: string;
    /**
     * Mark lineage external_candidate when the operator sets a non-internal integration id.
     * Still not EXTERNAL_RUN without server-side observation (see acceptance doc).
     */
    lineage?: GateAdoptionLineage;
};
/**
 * Run the deterministic no-spend adoption proof.
 * Never contacts a wallet; never spends USDC. Preflight is mocked.
 */
export declare function runGateAdoptionProof(opts?: RunGateAdoptionProofOptions): Promise<GateAdoptionTranscript>;
/** CLI entry: print one JSON transcript to stdout; exit 0 if ok else 1. */
export declare function main(argv?: string[]): Promise<number>;
//# sourceMappingURL=adoption-proof.d.ts.map