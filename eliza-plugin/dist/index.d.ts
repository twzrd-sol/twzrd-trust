/**
 * @wzrd_sol/eliza-plugin-source — V7-migrated TWZRD Agent Intel for ElizaOS
 *
 * Intel lane (default https://intel.twzrd.xyz):
 *   WZRD_INTEL_PREFLIGHT → WZRD_MERCHANT_CARD → WZRD_INTEL_TRUST → WZRD_VERIFY_RECEIPT
 * Paid intel requires a caller-supplied x402 fetch — either setPayingFetch(payingFetch)
 * or installTwzrdAutoGate(payWrap). Current paid receipt surface is V7.
 * Paid lookups need WZRD_INTEL_ALLOW_PAID=true or content.confirm_spend === true.
 *
 * 0.8.0 removed the retired earn actions (infer/report/earn/claim/rewards).
 */
import type { Action, Plugin, Provider } from '@elizaos/core';
import { intelPreflightAction } from './actions/intel-preflight.js';
import { merchantCardAction } from './actions/merchant-card.js';
import { intelTrustAction } from './actions/intel-trust.js';
import { verifyReceiptAction } from './actions/verify-receipt.js';
export { createDemandDeskWalletProvider } from './demand-desk-wallet.js';
export declare const intelActions: Action[];
export declare function createWzrdPlugin(options?: {
    walletProvider?: Provider;
}): Plugin;
/** Default plugin: intel actions only (0.6+). */
export declare const wzrdPlugin: Plugin;
export default wzrdPlugin;
export { intelPreflightAction, merchantCardAction, intelTrustAction, verifyReceiptAction, };
export { getIntelApiBase, getIntelClient } from './client-factory.js';
export { setPayingFetch, clearPayingFetch, resolvePayingFetch, installTwzrdAutoGate, autoGateOptions, withTracking, callerTag, GATE_PIN, } from './paying-fetch.js';
export { refusePacket, paidLookupConfirmed } from './actions/intel-trust.js';
export type { RefusePacket } from './actions/intel-trust.js';
/** SDK intel helpers. From SDK 0.5, TRUSTED_RECEIPT_PUBKEY is the v2 key, equal to CURRENT_RECEIPT_PUBKEY. */
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, fetchMerchantCard, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
export { verifyReceipt, classifyReceipt, describeReceiptSurface, freshnessStatusFor, freshnessFromVerify, formatVerifyResult, CURRENT_RECEIPT_PUBKEY, CURRENT_RECEIPT_KEY_ID, REPUTATION_V5_DOMAIN, REPUTATION_V6_DOMAIN, REPUTATION_V7_DOMAIN, } from './receipt-verify.js';
export type { VerifyReceiptResult, VerifyReceiptOptions, TwzrdReceiptLike, ReceiptVersion, FreshnessStatus, } from './receipt-verify.js';
export type { ReadinessCard, PreflightInput, PreflightResponse, MerchantCard, TwzrdReceipt, IntelTrustResponse, X402PaymentRequired, } from '@wzrd_sol/sdk';
