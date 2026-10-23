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
const INTEL_DESCRIPTION = 'TWZRD Agent Intel — free ReadinessCard preflight + free merchant_card wash refuse (default), ' +
    'then optional x402-paid V7 trust receipt (~0.05 USDC, needs WZRD_INTEL_ALLOW_PAID or confirm_spend) + ' +
    'offline verify via twzrd-receipt-verifier. ' +
    'Legacy V6 verification is labeled freshness=derived_from_timestamp. ' +
    'Buyer sequence is call-site / action-driven (not an auto-interceptor of all payments).';
export function createWzrdPlugin() {
    return {
        name: 'wzrd',
        description: INTEL_DESCRIPTION,
        actions: [...intelActions],
    };
}
/** Default plugin: intel actions only (0.6+). */
export const wzrdPlugin = createWzrdPlugin();
export default wzrdPlugin;
export { intelPreflightAction, merchantCardAction, intelTrustAction, verifyReceiptAction, };
export { getIntelApiBase, getIntelClient } from './client-factory.js';
export { setPayingFetch, clearPayingFetch, resolvePayingFetch, installTwzrdAutoGate, autoGateOptions, withTracking, callerTag, GATE_PIN, } from './paying-fetch.js';
export { refusePacket, paidLookupConfirmed } from './actions/intel-trust.js';
/** SDK intel helpers. TRUSTED_RECEIPT_PUBKEY is the v1 key — use CURRENT_RECEIPT_PUBKEY for V7 verify. */
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, fetchMerchantCard, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
export { verifyReceipt, classifyReceipt, describeReceiptSurface, freshnessStatusFor, freshnessFromVerify, formatVerifyResult, CURRENT_RECEIPT_PUBKEY, CURRENT_RECEIPT_KEY_ID, REPUTATION_V5_DOMAIN, REPUTATION_V6_DOMAIN, REPUTATION_V7_DOMAIN, } from './receipt-verify.js';
