/**
 * WZRD_VERIFY_RECEIPT — Offline leaf + Ed25519 verification (no network).
 * Handles both V5 and V6 receipts; the SDK selects the leaf binding from the
 * receipt's domain (V6 binds the reputation_* provenance fields into the leaf).
 */
import type { Action } from '@elizaos/core';
export declare const verifyReceiptAction: Action;
