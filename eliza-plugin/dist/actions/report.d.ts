/**
 * WZRD_REPORT — Report a model pick with execution receipt for verified CCM rewards.
 *
 * Must be called after WZRD_INFER. Pass the execution_id from the infer result
 * to get server-verified status and quality-weighted rewards.
 */
import type { Action } from '@elizaos/core';
export declare const reportAction: Action;
