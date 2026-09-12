/**
 * @wzrd_sol/eliza-plugin-source — V7-migrated WZRD Agent Intel for ElizaOS
 *
 * Intel lane (default https://intel.twzrd.xyz):
 *   WZRD_INTEL_PREFLIGHT → WZRD_MERCHANT_CARD → WZRD_INTEL_TRUST → WZRD_VERIFY_RECEIPT
 * Paid intel requires a caller-supplied x402 fetch — either setPayingFetch(payingFetch)
 * or installTwzrdAutoGate(payWrap). Current paid receipt surface is V7.
 *
 * Legacy earn lane (opt-in via createWzrdPlugin({ legacyEarnActions: true })):
 *   WZRD_INFER → WZRD_REPORT → WZRD_EARN → WZRD_CLAIM / WZRD_REWARDS on api.twzrd.xyz
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
/** SDK intel helpers. TRUSTED_RECEIPT_PUBKEY is the v1 key — use CURRENT_RECEIPT_PUBKEY for V7 verify. */
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, fetchMerchantCard, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
export { verifyReceipt, classifyReceipt, describeReceiptSurface, freshnessStatusFor, freshnessFromVerify, formatVerifyResult, CURRENT_RECEIPT_PUBKEY, CURRENT_RECEIPT_KEY_ID, REPUTATION_V5_DOMAIN, REPUTATION_V6_DOMAIN, REPUTATION_V7_DOMAIN, } from './receipt-verify.js';
export type { VerifyReceiptResult, VerifyReceiptOptions, TwzrdReceiptLike, ReceiptVersion, FreshnessStatus, } from './receipt-verify.js';
export type { ReadinessCard, PreflightInput, PreflightResponse, MerchantCard, TwzrdReceipt, IntelTrustResponse, X402PaymentRequired, } from '@wzrd_sol/sdk';
