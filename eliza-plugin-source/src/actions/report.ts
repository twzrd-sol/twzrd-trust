/**
 * WZRD_REPORT — Report a model pick with execution receipt for verified CCM rewards.
 *
 * Must be called after WZRD_INFER. Pass the execution_id from the infer result
 * to get server-verified status and quality-weighted rewards.
 */
import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { getWzrdClient } from '../client-factory.js';

export const reportAction: Action = {
  name: 'WZRD_REPORT',
  similes: ['WZRD_REPORT_OUTCOME', 'REPORT_MODEL_PICK', 'SUBMIT_SIGNAL'],
  description:
    'Report a model pick to WZRD with an execution_id from WZRD_INFER. ' +
    'Verified reports earn CCM rewards with quality multiplier.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Report the inference result to earn CCM' } },
      { name: '{{agentName}}', content: { text: 'Reported. Verification: verified, contribution #4521.' } },
    ],
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    _opt,
    callback?: HandlerCallback,
  ) => {
    const content = message.content as {
      execution_id?: string;
      model_id?: string;
      task_type?: string;
      quality_score?: number;
      latency_ms?: number;
    };

    if (!content.execution_id || !content.model_id) {
      await callback?.({
        text: 'Missing required: execution_id and model_id. Run WZRD_INFER first to get an execution receipt.',
      });
      return { success: false, error: 'Missing execution_id or model_id' };
    }

    const client = getWzrdClient(runtime);

    try {
      const result = await client.report({
        model_id: content.model_id,
        execution_id: content.execution_id,
        task_type: content.task_type,
        quality_score: content.quality_score,
        latency_ms: content.latency_ms,
      });

      const text =
        `Reported to WZRD.\n` +
        `Verification: ${result.verification_state}\n` +
        `Contribution: #${result.contribution_id}\n` +
        `Pending CCM: ${(result.pending_ccm / 1e9).toFixed(2)}\n` +
        `Pipeline: ${result.pipeline_state}`;
      await callback?.({ text });
      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Report failed: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
