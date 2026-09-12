/**
 * WZRD_VERIFY_RECEIPT — Offline leaf + Ed25519 verification.
 * Primary surface is V7 (freshness signed into the leaf). Legacy V6 still
 * verifies with freshness=derived_from_timestamp. Older V5 remains accepted
 * with unauthenticated provenance/freshness.
 */
import type { Action } from '@elizaos/core';
export declare const verifyReceiptAction: Action;
