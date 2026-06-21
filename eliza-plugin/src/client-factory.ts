/** Extract keypair from ElizaOS runtime, return cached WzrdClient. */
import { Keypair } from '@solana/web3.js';
import { WzrdClient } from './client.js';
import type { IAgentRuntime } from '@elizaos/core';
import { getIntelBase, withTimeout } from './intel-helpers.js';
import { resolvePayingFetch } from './paying-fetch.js';
import { intelPreflight, fetchIntelTrust, verifyReceipt } from '@wzrd_sol/sdk';

const cache = new Map<string, WzrdClient>();

/** Intel API base URL from runtime settings (default https://intel.twzrd.xyz). */
export function getIntelApiBase(runtime: IAgentRuntime): string {
  return getIntelBase(runtime);
}

export function getWzrdClient(runtime: IAgentRuntime): WzrdClient {
  const sk = runtime.getSetting('SOLANA_PRIVATE_KEY');
  if (!sk) throw new Error('SOLANA_PRIVATE_KEY not configured in ElizaOS runtime');

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(String(sk))));
  const pub = kp.publicKey.toBase58();

  if (!cache.has(pub)) {
    const apiUrl = runtime.getSetting('WZRD_API_URL');
    cache.set(
      pub,
      new WzrdClient(kp, typeof apiUrl === 'string' ? apiUrl : undefined),
    );
  }
  return cache.get(pub)!;
}

/** Reset client cache — useful for tests. */
export function clearClientCache(): void {
  cache.clear();
}

/** Intel client (per plan): reads WZRD_INTEL_URL + paying fetch; thin delegate to SDK. */
export function getIntelClient(runtime: IAgentRuntime) {
  const apiBase = getIntelApiBase(runtime);
  return {
    preflight: (input: Parameters<typeof intelPreflight>[0]) =>
      withTimeout(() => intelPreflight(input, apiBase)),
    trust: (pubkey: string) =>
      withTimeout((signal) => {
        const f = resolvePayingFetch(runtime);
        const abortingFetch = ((input: any, init?: any) =>
          f(input, { ...(init || {}), signal })) as typeof fetch;
        return fetchIntelTrust(pubkey, { apiBase, fetchImpl: abortingFetch });
      }),
    verify: (receipt: Parameters<typeof verifyReceipt>[0], opts?: Parameters<typeof verifyReceipt>[1]) =>
      withTimeout(() => verifyReceipt(receipt, { apiBase, ...(opts || {}) })),
  };
}
