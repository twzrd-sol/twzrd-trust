/**
 * WZRD_INTEL_TRUST — Paid trust payload + signed V7 receipt via x402-capable
 * fetch. Preflight-gated: free ReadinessCard + free merchant_card wash check run
 * BEFORE payment; decision=block or wash_flagged aborts before any spend.
 *
 * Current service surface is V7. Legacy V6/V5 payloads are labeled, not treated
 * as the current receipt policy.
 */
import type { Action, IAgentRuntime } from '@elizaos/core';
export type RefusePacket = {
    schema: 'twzrd.gate_eval_refuse.v1';
    rail: 'eliza-plugin';
    subject: string;
    reason: string;
    signer_invocation_count: 0;
    usdc_spent: 0;
    at: string;
};
/** Zero-spend refusal record, the same shape monid-x402 writes before any signer exists. */
export declare function refusePacket(reason: string, subject: string): RefusePacket;
/** A paid lookup proceeds only with WZRD_INTEL_ALLOW_PAID (true/1) or content.confirm_spend === true. */
export declare function paidLookupConfirmed(runtime: Pick<IAgentRuntime, 'getSetting'>, content: Record<string, unknown>): boolean;
export declare const intelTrustAction: Action;
