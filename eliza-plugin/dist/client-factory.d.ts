import { WzrdClient } from './client.js';
import type { IAgentRuntime } from '@elizaos/core';
import { intelPreflight, verifyReceipt } from '@wzrd_sol/sdk';
/** Intel API base URL from runtime settings (default https://intel.twzrd.xyz). */
export declare function getIntelApiBase(runtime: IAgentRuntime): string;
export declare function getWzrdClient(runtime: IAgentRuntime): WzrdClient;
/** Reset client cache — useful for tests. */
export declare function clearClientCache(): void;
/** Intel client (per plan): reads WZRD_INTEL_URL + paying fetch; thin delegate to SDK. */
export declare function getIntelClient(runtime: IAgentRuntime): {
    preflight: (input: Parameters<typeof intelPreflight>[0]) => Promise<import("@wzrd_sol/sdk").PreflightResponse>;
    trust: (pubkey: string) => Promise<import("@wzrd_sol/sdk").IntelTrustResponse>;
    verify: (receipt: Parameters<typeof verifyReceipt>[0], opts?: Parameters<typeof verifyReceipt>[1]) => Promise<import("@wzrd_sol/sdk").VerifyReceiptResult>;
};
