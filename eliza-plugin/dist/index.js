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
    'then optional x402-paid V6 trust receipt (~0.05 USDC) + offline verify on intel.twzrd.xyz. ' +
    'Buyer sequence is call-site / action-driven (not an auto-interceptor of all payments).';
const LEGACY_EARN_SUFFIX = ' Legacy earn actions (infer/report/claim/rewards) on api.twzrd.xyz are enabled.';
export function createWzrdPlugin(options = {}) {
    const actions = options.legacyEarnActions
        ? [...intelActions, ...legacyEarnActions]
        : [...intelActions];
    return {
        name: 'wzrd',
        description: options.legacyEarnActions
            ? INTEL_DESCRIPTION + LEGACY_EARN_SUFFIX
            : INTEL_DESCRIPTION,
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
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, fetchMerchantCard, verifyReceipt, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
