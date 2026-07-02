/**
 * WZRD_INFER — Server-witnessed inference through WZRD.
 *
 * WZRD calls the AI provider (Gemini/Nous/OpenRouter), grades the response,
 * and returns an execution_id receipt. Pass this to WZRD_REPORT for verified rewards.
 */
import type { Action } from '@elizaos/core';
export declare const inferAction: Action;
