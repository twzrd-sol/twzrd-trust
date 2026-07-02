import { IntelPaymentRequiredError, type PreflightInput, type TwzrdReceipt } from '@wzrd_sol/sdk';
export declare function getIntelBase(runtime: {
    getSetting: (k: string) => string | boolean | number | null;
}): string;
/** Pull structured fields from Eliza message content (flat or JSON-in-text). */
export declare function parsePreflightInput(content: Record<string, unknown>): PreflightInput;
export declare function parseReceipt(content: Record<string, unknown>): TwzrdReceipt | null;
export declare function extractPubkey(content: Record<string, unknown>): string | null;
export declare function formatPaymentRequired(err: IntelPaymentRequiredError, apiBase: string, pubkey: string): string;
/**
 * Timeout wrapper for SDK network calls (preflight/trust/verify).
 * Supports two call forms for minimal change:
 * - withTimeout(promise) for preflight (SDK does not expose fetchImpl/signal)
 * - withTimeout((signal) => sdkCallWithFetchImpl(abortingFetch)) for trust/verify
 * Uses AbortController + signal: abort() is called on timeout so that when caller
 * wires the returned signal into fetchImpl, the underlying network request is aborted.
 * Always clears timer in finally (no leak). Attaches rejection observer to the
 * call promise (without altering settlement) to avoid unhandled rejections on the
 * loser of the race.
 * Applied to actions + getIntelClient delegates.
 */
export declare function withTimeout<T>(pOrMake: Promise<T> | ((signal?: AbortSignal) => Promise<T>), ms?: number): Promise<T>;
