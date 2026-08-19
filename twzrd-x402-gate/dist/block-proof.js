/**
 * AutoGate block-proof transcript schema + builder.
 * Used by examples/autogate-block-proof.ts and unit tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CLIENT_VERSION } from "./version.js";
import { toTrustGateBlockReason } from "./trust-gate-reason.js";
/**
 * v1 = original block transcript (hook + invariants only).
 * v1.1 = adds execution_mode + resolved peer versions so stock-seat proofs
 * cannot be confused with harness fallback (S1 closure 2026-08-03).
 * v1.2 = adds the operator-signed Decision Outcome Attestation V1
 * (blocked_never_signed) so the refuse is portable signed evidence, not
 * only a JSON transcript. Attached via attachBlockOutcomeAttestation.
 */
export const AUTOGATE_BLOCK_PROOF_SCHEMA = "twzrd.autogate_block_proof.v1";
export const AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1 = "twzrd.autogate_block_proof.v1.1";
export const AUTOGATE_BLOCK_PROOF_SCHEMA_V1_2 = "twzrd.autogate_block_proof.v1.2";
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
    const useV11 = input.schema_v1_1 === true ||
        input.execution_mode != null ||
        input.negative_control != null;
    const proof = {
        schema_version: useV11
            ? AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1
            : AUTOGATE_BLOCK_PROOF_SCHEMA,
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
            hook: input.hook ?? "onBeforePaymentCreation",
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
    if (useV11) {
        proof.execution_mode = input.execution_mode;
        proof.x402_solana_version =
            input.x402_solana_version !== undefined ? input.x402_solana_version : null;
        if (input.stock_seat_required != null) {
            proof.stock_seat_required = input.stock_seat_required;
        }
        if (input.negative_control) {
            proof.negative_control = input.negative_control;
        }
    }
    return proof;
}
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
export async function attachBlockOutcomeAttestation(proof, options) {
    if (proof.verified !== true) {
        throw new Error("[twzrd] attachBlockOutcomeAttestation requires a VERIFIED block proof " +
            "(aborted, signer_invocations=0, spend=0, settlements=0) — refusing to " +
            "sign a blocked_never_signed claim the transcript does not prove");
    }
    const { buildOutcomeAttestation } = await import("./outcome-attestation.js");
    const attestation = await buildOutcomeAttestation({
        decisionId: options.decisionId ?? proof.run_id,
        counterparty: proof.target_seller,
        verdict: "block",
        outcome: "blocked_never_signed",
        timestampUnix: options.timestampUnix ?? Math.floor(Date.parse(proof.timestamp) / 1000),
        // No DecisionToken covered this refuse -> no fabricated intent bind.
        intentHash: options.intentHash ?? null,
        payer: options.payer ?? null,
        settlementTx: null,
        preflightId: options.preflightId ?? null,
    }, options.signer);
    return {
        ...proof,
        schema_version: AUTOGATE_BLOCK_PROOF_SCHEMA_V1_2,
        outcome_attestation: attestation,
    };
}
/**
 * Resolve a package version from node_modules on disk.
 * Prefer this over `require("pkg/package.json")` — some packages (x402-solana)
 * do not export package.json and that path yields "unknown".
 *
 * @param packageName e.g. "x402-solana"
 * @param fromUrl import.meta.url of the caller (or any file under the package)
 */
export function resolveInstalledPackageVersion(packageName, fromUrl = import.meta.url) {
    // createRequire wants a file URL or absolute path to a real module file.
    const filename = typeof fromUrl === "string"
        ? fromUrl.startsWith("file:")
            ? fromUrl
            : fromUrl
        : fromUrl.href;
    const req = createRequire(filename);
    // 1) package.json export if present
    try {
        const pkgJsonPath = req.resolve(`${packageName}/package.json`);
        const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        if (typeof raw.version === "string")
            return raw.version;
    }
    catch {
        /* blocked export — walk from entry */
    }
    // 2) resolve package entry, walk parents for package.json with matching name
    let entry = null;
    for (const spec of [packageName, `${packageName}/dist/index.js`, `${packageName}/dist/index.cjs`]) {
        try {
            entry = req.resolve(spec);
            break;
        }
        catch {
            /* try next */
        }
    }
    if (!entry)
        return null;
    let dir = dirname(entry);
    for (let i = 0; i < 8; i++) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
            try {
                const raw = JSON.parse(readFileSync(candidate, "utf8"));
                if (raw.name === packageName && typeof raw.version === "string") {
                    return raw.version;
                }
            }
            catch {
                /* continue */
            }
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
//# sourceMappingURL=block-proof.js.map