/**
 * twzrd-safe-fetch — experimental AgentCash **pre-invocation** preflight.
 *
 * SECURITY CLASSIFICATION: **advisory_precheck** (not a challenge-bound firewall).
 *
 * AgentCash CLI consumes HTTP 402 internally. This process can only:
 *
 *   1. RAW probe → observe challenge A
 *   2. TWZRD preflight on A
 *   3. If policy allows → shell out to AgentCash, which makes a **second** request
 *      and may receive challenge B ≠ A, then signs B without TWZRD re-check
 *
 * TOCTOU: recipient, network, asset, or amount can change between probe and pay.
 * `requirement_scored_matches_requirement_signed` is always false for this adapter
 * until AgentCash exposes an onPaymentRequested hook that binds the exact requirement.
 *
 * Secure paths:
 *   - installTwzrdAutoGate over raw fetch + injectible pay client
 *   - twzrdOnPaymentRequested MCP hook
 *
 * Never wrap agentcash fetch with withTwzrdGuard — that is too late.
 * Do not market this CLI as a secure AgentCash firewall.
 */
import { type DeliveryCaptureResult } from "./delivery-capture.js";
import type { TwzrdApprovalResult } from "./types.js";
export type SafeFetchOptions = {
    url: string;
    method?: string;
    body?: string;
    headers?: string[];
    /** Prefer payment network for AgentCash (e.g. solana) */
    paymentNetwork?: string;
    gateOnCanSpend?: boolean;
    unsupportedNetworkMode?: "observe" | "strict";
    failOpen?: boolean;
    refuseWashFlagged?: boolean;
    preflightMinScore?: number;
    intelBase?: string;
    /** If true, stop after preflight; never invoke AgentCash */
    dryRun?: boolean;
    /** Skip AgentCash; only raw+preflight (alias dryRun for clarity in some UIs) */
    preflightOnly?: boolean;
    /** AgentCash package for npx (default agentcash@latest) */
    agentcashPackage?: string;
    /** Extra args after `fetch <url>` */
    agentcashExtraArgs?: string[];
    /**
     * Post-settle delivery observation capture (Phase 2 delivery-proof).
     * Default true; also disabled by TWZRD_DELIVERY_CAPTURE=0|false.
     */
    deliveryCapture?: boolean;
    /** Inject fetch for tests */
    fetch?: typeof fetch;
    /** Inject payer runner for tests */
    runPayer?: (args: {
        url: string;
        method: string;
        body?: string;
        headers: string[];
        paymentNetwork?: string;
    }) => Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    onEvent?: (event: string, detail?: Record<string, unknown>) => void;
};
/** Snapshot of an x402 requirement used for TOCTOU / binding diagnostics. */
export type PaymentRequirementSnapshot = {
    payTo?: string;
    network?: string;
    amountMicro?: string;
    asset?: string;
    resource?: string;
};
export type SafeFetchResult = {
    ok: boolean;
    phase: "passthrough" | "blocked" | "dry_run_allowed" | "paid" | "payer_failed" | "error";
    initialStatus: number;
    payTo?: string;
    network?: string;
    amountMicro?: string;
    priceUsdc?: number;
    approval?: TwzrdApprovalResult;
    eventOrder: string[];
    payer?: {
        exitCode: number;
        stdout: string;
        stderr: string;
    };
    error?: string;
    resourceStatus?: number;
    resourceBody?: unknown;
    /**
     * Requirement TWZRD preflighted from the probe 402.
     * For the AgentCash CLI path this is NOT proven equal to what AgentCash signed.
     */
    requirementScored?: PaymentRequirementSnapshot;
    /**
     * Requirement AgentCash signed — only populated if the payer reports it.
     * AgentCash CLI stdout typically does not expose this; then remains undefined.
     */
    requirementSigned?: PaymentRequirementSnapshot;
    /**
     * Always false for the shell-out AgentCash adapter (two independent HTTP requests).
     * True only if a future challenge-bound integration proves equality.
     */
    requirementScoredMatchesRequirementSigned: boolean;
    /**
     * How many HTTP requests hit the *target* resource during this execution.
     * Advisory path: 1 (blocked/dry-run) or 2+ (probe + AgentCash re-fetch).
     */
    targetRequestCount: number;
    /** Security classification of this adapter */
    cliSecurityClassification: "advisory_precheck";
    /**
     * Post-settle delivery observation (paid phase only). posted=false when
     * capture is disabled or the collector endpoint is unreachable; the
     * observation itself is still returned for local transcripts.
     */
    deliveryCapture?: DeliveryCaptureResult;
};
export declare function runAgentcashFetch(args: {
    url: string;
    method: string;
    body?: string;
    headers: string[];
    paymentNetwork?: string;
    agentcashPackage?: string;
    extraArgs?: string[];
}): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
/**
 * Core safe-fetch pipeline (library + CLI).
 */
export declare function safeFetch(opts: SafeFetchOptions): Promise<SafeFetchResult>;
export declare function main(argv?: string[]): Promise<number>;
//# sourceMappingURL=safe-fetch.d.ts.map