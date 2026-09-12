/**
 * WZRD_INTEL_TRUST — Paid trust payload + signed V7 receipt via x402-capable
 * fetch. Preflight-gated: free ReadinessCard + free merchant_card wash check run
 * BEFORE payment; decision=block or wash_flagged aborts before any spend.
 *
 * Current service surface is V7. Legacy V6/V5 payloads are labeled, not treated
 * as the current receipt policy.
 */
import type { Action } from '@elizaos/core';
export declare const intelTrustAction: Action;
