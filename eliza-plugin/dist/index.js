import { inferAction } from './actions/infer.js';
import { reportAction } from './actions/report.js';
import { earnAction } from './actions/earn.js';
import { claimAction } from './actions/claim.js';
import { rewardsAction } from './actions/rewards.js';
import { intelPreflightAction } from './actions/intel-preflight.js';
import { merchantCardAction } from './actions/merchant-card.js';
import { intelTrustAction } from './actions/intel-trust.js';
import { verifyReceiptAction } from './actions/verify-receipt.js';
export const intelActions = [
    intelPreflightAction,
    merchantCardAction,
    intelTrustAction,
    verifyReceiptAction,
];
export const legacyEarnActions = [
    earnAction,
    inferAction,
    reportAction,
    claimAction,
    rewardsAction,
];
const INTEL_DESCRIPTION = 'WZRD Agent Intel — free ReadinessCard preflight + free merchant_card wash refuse (default), ' +
    'then optional x402-paid V7 trust receipt (~0.05 USDC) + offline verify via twzrd-receipt-verifier. ' +
    'Legacy V6 verification is labeled freshness=derived_from_timestamp. ' +
    'Buyer sequence is call-site / action-driven (not an auto-interceptor of all payments).';
const LEGACY_EARN_SUFFIX = ' Legacy earn actions (infer/report/claim/rewards) on api.twzrd.xyz are enabled.';
export function createWzrdPlugin(options = {}) {
    const actions = options.legacyEarnActions
        ? [...intelActions, ...legacyEarnActions]
        : [...intelActions];
    return {
        name: 'wzrd',
        description: options.legacyEarnActions ? INTEL_DESCRIPTION + LEGACY_EARN_SUFFIX : INTEL_DESCRIPTION,
        actions,
    };
}
/** Default plugin: intel actions only (0.6+). */
export const wzrdPlugin = createWzrdPlugin();
/** Pre-0.6 compatibility: intel + legacy earn actions. */
export const wzrdPluginWithLegacyEarn = createWzrdPlugin({ legacyEarnActions: true });
export default wzrdPlugin;
export { intelPreflightAction, merchantCardAction, intelTrustAction, verifyReceiptAction, earnAction, inferAction, reportAction, claimAction, rewardsAction, };
export { getWzrdClient, clearClientCache, getIntelApiBase, getIntelClient } from './client-factory.js';
export { setPayingFetch, clearPayingFetch, resolvePayingFetch, installTwzrdAutoGate, } from './paying-fetch.js';
export { WzrdClient } from './client.js';
/** SDK intel helpers. TRUSTED_RECEIPT_PUBKEY is the v1 key — use CURRENT_RECEIPT_PUBKEY for V7 verify. */
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, fetchMerchantCard, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
export { verifyReceipt, classifyReceipt, describeReceiptSurface, freshnessStatusFor, freshnessFromVerify, formatVerifyResult, CURRENT_RECEIPT_PUBKEY, CURRENT_RECEIPT_KEY_ID, REPUTATION_V5_DOMAIN, REPUTATION_V6_DOMAIN, REPUTATION_V7_DOMAIN, } from './receipt-verify.js';
