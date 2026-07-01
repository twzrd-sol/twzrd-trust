import { inferAction } from './actions/infer.js';
import { reportAction } from './actions/report.js';
import { earnAction } from './actions/earn.js';
import { claimAction } from './actions/claim.js';
import { rewardsAction } from './actions/rewards.js';
import { intelPreflightAction } from './actions/intel-preflight.js';
import { intelTrustAction } from './actions/intel-trust.js';
import { verifyReceiptAction } from './actions/verify-receipt.js';
export const wzrdPlugin = {
    name: 'wzrd',
    description: 'WZRD Agent Intel — free ReadinessCard preflight (gates spends before paying), x402-paid trust receipts ' +
        '(V5/V6), offline verification on intel.twzrd.xyz. Also ships the legacy earn loop (infer/report/claim) ' +
        'on api.twzrd.xyz.',
    actions: [
        intelPreflightAction,
        intelTrustAction,
        verifyReceiptAction,
        earnAction,
        inferAction,
        reportAction,
        claimAction,
        rewardsAction,
    ],
};
export default wzrdPlugin;
export { intelPreflightAction, intelTrustAction, verifyReceiptAction, earnAction, inferAction, reportAction, claimAction, rewardsAction, };
export { getWzrdClient, clearClientCache, getIntelApiBase, getIntelClient } from './client-factory.js';
export { setPayingFetch, clearPayingFetch, resolvePayingFetch } from './paying-fetch.js';
export { WzrdClient } from './client.js';
export { IntelPaymentRequiredError, intelPreflight, fetchIntelTrust, verifyReceipt, preSpendGate, intelTrustUrl, TRUSTED_RECEIPT_PUBKEY, INTEL_TRUST_PRICE_USDC, } from '@wzrd_sol/sdk';
