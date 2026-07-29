/**
 * AutoGate block-proof transcript schema + builder.
 * Used by examples/autogate-block-proof.ts and unit tests.
 */
import { CLIENT_VERSION } from "./version.js";
import { toTrustGateBlockReason } from "./trust-gate-reason.js";
export const AUTOGATE_BLOCK_PROOF_SCHEMA = "twzrd.autogate_block_proof.v1";
export function buildAutogateBlockProof(input) {
    const internal = input.internal_reason;
    const publicReason = internal
        ? toTrustGateBlockReason(internal)
        : "TWZRD_TRUST_GATE_BLOCK: unknown";
    const signer = input.signer_invocations;
    const spend = input.actual_spend_usdc ?? 0;
    const onchain = input.onchain_settlements ?? 0;
    const verified = input.aborted === true &&
        signer === 0 &&
        spend === 0 &&
        onchain === 0;
    return {
        schema_version: AUTOGATE_BLOCK_PROOF_SCHEMA,
        run_id: input.run_id,
        timestamp: (input.now?.() ?? new Date()).toISOString(),
        package_version: input.package_version ?? CLIENT_VERSION,
        target_seller: input.target_seller,
        preflight_result: {
            decision: input.decision ?? null,
            wash_flagged: input.wash_flagged ?? null,
            trust_score: input.trust_score ?? null,
            internal_reason: internal,
        },
        interception: {
            hook: "onBeforePaymentCreation",
            aborted: input.aborted,
            reason: publicReason,
            internal_reason: internal,
        },
        invariants: {
            signer_invocations: signer,
            actual_spend_usdc: spend,
            onchain_settlements: onchain,
        },
        verified,
    };
}
//# sourceMappingURL=block-proof.js.map