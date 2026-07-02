import type { ResolvedTwzrdGateConfig } from "./config.js";
/**
 * Wrap fetch: on HTTP 402, run TWZRD preflight on payTo before caller retries with payment.
 * Throws if policy denies; returns original 402 if approved (caller attaches payment).
 */
export declare function wrapFetchWithTwzrdGate(innerFetch: typeof fetch, config?: ResolvedTwzrdGateConfig): typeof fetch;
//# sourceMappingURL=wrap-fetch.d.ts.map