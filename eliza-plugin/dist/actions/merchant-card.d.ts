/**
 * WZRD_MERCHANT_CARD — Free demand-quality graph card for a receive wallet.
 * Forward-ported from the 0.6.1 artifact (dist/actions/merchant-card.js); this
 * file did not exist in the 98e4b78 historical source baseline.
 */
import type { Action } from '@elizaos/core';
import { type MerchantCard } from '@wzrd_sol/sdk';
type Coverage = {
    washConfidence: string | null;
    coverageFull: boolean;
};
/** Same coverage rule as twzrd-x402-gate isWashCoverageAdequate: full, ring evaluated, not stale. */
export declare function cardCoverage(card: MerchantCard): Coverage;
export declare const merchantCardAction: Action;
export {};
