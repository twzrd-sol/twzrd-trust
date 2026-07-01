/**
 * WZRD_EARN — Full earn cycle: infer → report → check rewards.
 *
 * Single action that runs the complete server-witnessed earn loop.
 * For agents that want one-shot earning without managing execution_ids.
 */
import type { Action } from '@elizaos/core';
export declare const earnAction: Action;
