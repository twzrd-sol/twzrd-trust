/**
 * @wzrd_sol/eliza-plugin — WZRD Agent Intel for ElizaOS
 *
 * Intel lane (default https://intel.twzrd.xyz):
 *   WZRD_INTEL_PREFLIGHT → WZRD_MERCHANT_CARD → WZRD_INTEL_TRUST → WZRD_VERIFY_RECEIPT
 * Paid intel requires a caller-supplied x402 fetch — either setPayingFetch(payingFetch)
 * (already-composed, unguarded) or installTwzrdAutoGate(payWrap) (default-on: guards the
 * raw fetch before your client signs, then registers it the same way).
 * Default: preSpendGate refuses wash_flagged pay_to (free merchant_card).
 *
 * Legacy earn lane (opt-in via createWzrdPlugin({ legacyEarnActions: true })):
 *   WZRD_INFER → WZRD_REPORT → WZRD_EARN → WZRD_CLAIM / WZRD_REWARDS on api.twzrd.xyz
 *
 * Config (runtime.getSetting):
 *   WZRD_INTEL_URL      — optional, defaults to https://intel.twzrd.xyz
 *   WZRD_API_URL        — earn lane only, defaults to https://api.twzrd.xyz
 *   SOLANA_PRIVATE_KEY  — earn lane only (agent Ed25519 auth)
 */
import type { Action, Plugin } from '@elizaos/core';
import { inferAction } from './actions/infer.js';
import { reportAction } from './actions/report.js';
import { earnAction } from './actions/earn.js';
import { claimAction } from './actions/claim.js';
import { rewardsAction } from './actions/rewards.js';
import { intelPreflightAction } from './actions/intel-preflight.js';
import { merchantCardAction } from './actions/merchant-card.js';
import { intelTrustAction } from './actions/intel-trust.js';
import { verifyReceiptAction } from './actions/verify-receipt.js';
export declare const intelActions: Action[];
export declare const legacyEarnActions: Action[];
export interface WzrdPluginOptions {
    /** Register WZRD_INFER / REPORT / EARN / CLAIM / REWARDS (0.5.x default; off in 0.6+). */
    legacyEarnActions?: boolean;
}
export declare function createWzrdPlugin(options?: WzrdPluginOptions): Plugin;
/** Default plugin: intel actions only (0.6+). */
export declare const wzrdPlugin: Plugin;
/** Pre-0.6 compatibility: intel + legacy earn actions. */
export declare const wzrdPluginWithLegacyEarn: Plugin;
export default wzrdPlugin;
export { intelPreflightAction, merchantCardAction, intelTrustAction, verifyReceiptAction, earnAction, inferAction, reportAction, claimAction, rewardsAction, };
export { getWzrdClient, clearClientCache, getIntelApiBase, getIntelClient } from './client-factory.js';
export { setPayingFetch, clearPayingFetch, resolvePayingFetch, installTwzrdAutoGate, } from './paying-fetch.js';
export { WzrdClient } from './client.js';
export type { InferResult, ReportResult, RewardsBalance, ClaimResult } from './client.js';
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, fetchMerchantCard, verifyReceipt, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
export type { ReadinessCard, PreflightInput, PreflightResponse, MerchantCard, TwzrdReceipt, IntelTrustResponse, VerifyReceiptResult, X402PaymentRequired, } from '@wzrd_sol/sdk';
