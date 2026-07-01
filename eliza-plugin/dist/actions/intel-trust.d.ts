/**
 * WZRD_INTEL_TRUST — Paid trust payload + signed receipt (V5/V6) via x402-capable
 * fetch. Preflight-gated: the free ReadinessCard runs BEFORE the payment and a
 * decision=block aborts before any spend (the protocol's preflight-before-pay rule).
 */
import type { Action } from '@elizaos/core';
export declare const intelTrustAction: Action;
