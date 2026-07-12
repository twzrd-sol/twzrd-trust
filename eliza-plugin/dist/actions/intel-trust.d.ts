/**
 * WZRD_INTEL_TRUST — Paid trust payload + signed V6 receipt via x402-capable
 * fetch. Preflight-gated: free ReadinessCard + free merchant_card wash check run
 * BEFORE payment; decision=block or wash_flagged aborts before any spend.
 */
import type { Action } from '@elizaos/core';
export declare const intelTrustAction: Action;
