import { getIntelBase, withTimeout } from './intel-helpers.js';
import { callerTag, resolvePayingFetch, withTracking } from './paying-fetch.js';
import { intelPreflight, fetchIntelTrust } from '@wzrd_sol/sdk';
import { verifyReceipt } from './receipt-verify.js';
/** Intel API base URL from runtime settings (default https://intel.twzrd.xyz). */
export function getIntelApiBase(runtime) {
    return getIntelBase(runtime);
}
/** Intel client (per plan): reads WZRD_INTEL_URL + paying fetch; thin delegate to SDK. */
export function getIntelClient(runtime) {
    const apiBase = getIntelApiBase(runtime);
    return {
        preflight: (input) => withTimeout(() => intelPreflight(input, apiBase, callerTag())),
        trust: (pubkey) => withTimeout((signal) => {
            const f = resolvePayingFetch(runtime);
            const abortingFetch = ((input, init) => f(input, { ...(init || {}), signal }));
            return fetchIntelTrust(pubkey, {
                apiBase,
                fetchImpl: withTracking(abortingFetch),
                caller: callerTag(),
            });
        }),
        verify: (receipt, opts) => verifyReceipt(receipt, opts),
    };
}
