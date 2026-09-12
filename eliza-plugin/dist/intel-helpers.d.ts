import { IntelPaymentRequiredError, type PreflightInput } from '@wzrd_sol/sdk';
import type { TwzrdReceiptLike } from './receipt-verify.js';
export declare function getIntelBase(runtime: {
    getSetting: (k: string) => string | boolean | number | null;
}): string;
/** Pull structured fields from Eliza message content (flat or JSON-in-text). */
export declare function parsePreflightInput(content: Record<string, unknown>): PreflightInput;
export declare function parseReceipt(content: Record<string, unknown>): TwzrdReceiptLike | null;
export declare function extractPubkey(content: Record<string, unknown>): string | null;
export declare function formatPaymentRequired(err: IntelPaymentRequiredError, apiBase: string, pubkey: string): string;
/**
 * Timeout wrapper for SDK network calls (preflight/trust/verify).
 */
export declare function withTimeout<T>(pOrMake: Promise<T> | ((signal?: AbortSignal) => Promise<T>), ms?: number): Promise<T>;
