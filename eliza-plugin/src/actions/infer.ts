/**
 * WZRD_INFER — Server-witnessed inference through WZRD.
 *
 * WZRD calls the AI provider (Gemini/Nous/OpenRouter), grades the response,
 * and returns an execution_id receipt. Pass this to WZRD_REPORT for verified rewards.
 */
import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { getWzrdClient } from '../client-factory.js';

export const inferAction: Action = {
  name: 'WZRD_INFER',
  similes: ['WZRD_RUN_INFERENCE', 'ASK_MODEL', 'RUN_MODEL'],
  description:
    'Run inference through WZRD. The server calls the AI provider, grades quality, ' +
    'and returns an execution receipt. Use the execution_id with WZRD_REPORT to earn CCM.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Run inference through WZRD: explain quicksort in Python' } },
      { name: '{{agentName}}', content: { text: 'Inference complete. Model: gemini-2.5-flash, quality: 0.85. execution_id: abc-123...' } },
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
    const content = message.content as { text?: string; prompt?: string; task_type?: string };
    const prompt = content.prompt || content.text || '';
    if (!prompt) {
      await callback?.({ text: 'No prompt provided. Include a prompt or text to run inference.' });
      return { success: false, error: 'No prompt' };
    }

    const taskType = content.task_type || 'chat';
    const model = (content as { model?: string }).model;
    const client = getWzrdClient(runtime);

    try {
      const result = await client.infer(prompt, model, taskType);
      const text =
        `Inference complete.\n` +
        `Model: ${result.executed_model} (${result.provider})\n` +
        `Quality: ${result.quality_score.toFixed(2)}\n` +
        `Latency: ${result.latency_ms}ms\n` +
        `execution_id: ${result.execution_id}\n\n` +
        `Response: ${result.response_preview}`;
      await callback?.({ text });
      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Inference failed: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
