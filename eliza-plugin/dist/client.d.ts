/**
 * Standalone WZRD API client for ElizaOS agents.
 * No external dependencies beyond @solana/web3.js for Ed25519 signing.
 *
 * Auth flow: challenge → sign → verify → Bearer token (24h TTL)
 * Earn flow: infer → report(execution_id) → claim
 */
import { Keypair } from '@solana/web3.js';
export interface InferResult {
    execution_id: string;
    executed_model: string;
    requested_model: string;
    provider: string;
    quality_score: number;
    response_preview: string;
    latency_ms: number;
    cost_usd?: number;
}
export interface ReportResult {
    contribution_id: number;
    verification_state: string;
    lifetime_contributions: number;
    pending_ccm: number;
    pipeline_state: string;
    idempotent: boolean;
    provider_receipt_present: boolean;
}
export interface RewardsBalance {
    pending_ccm: number;
    total_rewarded_ccm: number;
    rank: number | null;
    contribution_count: number;
}
export interface ClaimResult {
    tx_sig: string | null;
    root_seq: number;
    cumulative_total: number;
    status: string;
}
export interface LeaderboardResult {
    market_count: number;
    total_tvl: number;
    root: {
        root_seq: number;
    };
    markets: Array<{
        market_id: number;
        metric: string;
        platform: string;
        velocity_ema: number;
        multiplier_bps: number;
        snapshot_count: number;
    }>;
}
export declare class WzrdClient {
    private keypair;
    private apiUrl;
    private token;
    private tokenExpiry;
    constructor(keypair: Keypair, apiUrl?: string);
    get pubkey(): string;
    /** Ed25519 challenge → sign → verify → Bearer token */
    private authenticate;
    /** Authenticated fetch helper */
    private authedFetch;
    /** Pick a model from the momentum signal — returns top model's channel_id */
    pickModel(taskType?: string): Promise<string>;
    /** Server-witnessed inference — WZRD calls the provider, grades quality */
    infer(prompt: string, model?: string, taskType?: string): Promise<InferResult>;
    /** Report model pick with execution_id for verified rewards */
    report(params: {
        model_id: string;
        execution_id: string;
        task_type?: string;
        quality_score?: number;
        latency_ms?: number;
    }): Promise<ReportResult>;
    /** Check pending + total rewards (reads flat /v1/agent/earned response) */
    getRewards(): Promise<RewardsBalance>;
    /** Gasless CCM claim via server relay */
    claimRelay(): Promise<ClaimResult>;
    /** Public: fetch leaderboard (no auth) */
    getLeaderboard(limit?: number): Promise<LeaderboardResult>;
    /** Public: fetch claims status */
    getClaimStatus(): Promise<{
        cumulative_total: number;
        claimed_total: number;
        claimable: number;
    }>;
}
export { intelPreflight as intelPreflightClient, fetchIntelTrust as fetchIntelTrustClient, verifyReceipt as verifyReceiptClient, } from '@wzrd_sol/sdk';
