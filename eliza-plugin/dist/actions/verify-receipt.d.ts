/**
 * WZRD_VERIFY_RECEIPT — Offline leaf + Ed25519 verification (no network).
 * Primary surface is V6 (reputation leaf). Older V5 receipts still verify when
 * presented; the SDK selects the leaf binding from the receipt domain.
 */
import type { Action } from '@elizaos/core';
export declare const verifyReceiptAction: Action;
