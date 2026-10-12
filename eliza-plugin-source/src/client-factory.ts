/** Intel client factory: reads WZRD_INTEL_URL + the host's paying fetch. */
import type { IAgentRuntime } from '@elizaos/core';
import { getIntelBase, withTimeout } from './intel-helpers.js';
import { callerTag, resolvePayingFetch, withTracking } from './paying-fetch.js';
import { intelPreflight, fetchIntelTrust } from '@wzrd_sol/sdk';
import { verifyReceipt } from './receipt-verify.js';

/** Intel API base URL from runtime settings (default https://intel.twzrd.xyz). */
export function getIntelApiBase(runtime: IAgentRuntime): string {
  return getIntelBase(runtime);
}

/** Intel client (per plan): reads WZRD_INTEL_URL + paying fetch; thin delegate to SDK. */
export function getIntelClient(runtime: IAgentRuntime) {
  const apiBase = getIntelApiBase(runtime);
  return {
    preflight: (input: Parameters<typeof intelPreflight>[0]) =>
      withTimeout(() => intelPreflight(input, apiBase, callerTag())),
    trust: (pubkey: string) =>
      withTimeout((signal) => {
        const f = resolvePayingFetch(runtime);
        const abortingFetch = ((input: any, init?: any) =>
          f(input, { ...(init || {}), signal })) as typeof fetch;
        return fetchIntelTrust(pubkey, {
          apiBase,
          fetchImpl: withTracking(abortingFetch),
          caller: callerTag(),
        });
      }),
    verify: (receipt: Parameters<typeof verifyReceipt>[0], opts?: Parameters<typeof verifyReceipt>[1]) =>
      verifyReceipt(receipt, opts),
  };
}
