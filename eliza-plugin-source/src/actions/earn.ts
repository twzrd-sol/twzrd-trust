/**
 * WZRD_EARN — Full earn cycle: infer → report → check rewards.
 *
 * Single action that runs the complete server-witnessed earn loop.
 * For agents that want one-shot earning without managing execution_ids.
 */
import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { getWzrdClient } from '../client-factory.js';

const EVAL_PROMPTS: Record<string, string[]> = {
  code: [
    'Write a Python function that checks if a binary tree is balanced. Include time complexity analysis.',
    'Implement a thread-safe LRU cache in Rust with O(1) get and put operations.',
    'Write a TypeScript generic function that deep-merges two objects, handling arrays and nested objects.',
  ],
  chat: [
    'Explain the difference between TCP and UDP to someone who has never programmed before.',
    'What are the tradeoffs between microservices and monolithic architecture?',
    'Describe how consensus works in proof-of-stake blockchains.',
  ],
  reasoning: [
    'A farmer has a fox, a chicken, and a bag of grain. He must cross a river in a boat that can only carry him and one item. How does he do it?',
    'If it takes 5 machines 5 minutes to make 5 widgets, how long does it take 100 machines to make 100 widgets?',
    'Three people check into a hotel room that costs $30. They each pay $10. The manager realizes the room should cost $25 and gives $5 to the bellboy to return. The bellboy keeps $2 and gives $1 back to each person. So each person paid $9 (total $27) plus the bellboy kept $2 (total $29). Where is the missing dollar?',
  ],
};

function pickPrompt(taskType: string): string {
  const prompts = EVAL_PROMPTS[taskType] || EVAL_PROMPTS.chat;
  return prompts[Math.floor(Math.random() * prompts.length)];
}

export const earnAction: Action = {
  name: 'WZRD_EARN',
  similes: ['WZRD_EARN_CCM', 'EARN_REWARDS', 'RUN_EARN_LOOP'],
  description:
    'Run the full WZRD earn cycle: pick a prompt, run server-witnessed inference, ' +
    'report the outcome, and check pending rewards. One action, complete loop.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Earn some CCM on WZRD' } },
      {
        name: '{{agentName}}',
        content: {
          text: 'Earn cycle complete. Model: gemini-2.5-flash, quality: 0.85, verified. Pending: 142.5 CCM.',
        },
      },
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
    const content = message.content as { task_type?: string; prompt?: string };
    const taskType = content.task_type || 'code';
    const prompt = content.prompt || pickPrompt(taskType);
    const client = getWzrdClient(runtime);
    const steps: string[] = [];

    try {
      // Step 1: Pick model + Infer
      steps.push('→ Picking model from leaderboard...');
      const model = await client.pickModel(taskType);
      steps.push(`→ Running inference: ${model} (${taskType})...`);
      const infer = await client.infer(prompt, model, taskType);
      steps.push(
        `✓ Inference: ${infer.executed_model} (${infer.provider}), quality ${infer.quality_score.toFixed(2)}, ${infer.latency_ms}ms`,
      );

      // Step 2: Report with execution_id
      steps.push('→ Reporting outcome...');
      const report = await client.report({
        model_id: infer.requested_model,
        execution_id: infer.execution_id,
        task_type: taskType,
        quality_score: infer.quality_score,
        latency_ms: infer.latency_ms,
      });
      steps.push(
        `✓ Reported: ${report.verification_state}, contribution #${report.contribution_id}, pending ${(report.pending_ccm / 1e9).toFixed(2)} CCM`,
      );

      // Step 3: Check rewards
      steps.push('→ Checking rewards...');
      const rewards = await client.getRewards();
      steps.push(
        `✓ Rewards: ${(rewards.pending_ccm / 1e9).toFixed(2)} CCM pending, ` +
          `${(rewards.total_rewarded_ccm / 1e9).toFixed(2)} CCM lifetime` +
          (rewards.rank ? `, rank #${rewards.rank}` : ''),
      );

      const text = `Earn cycle complete:\n${steps.join('\n')}`;
      await callback?.({ text });
      return {
        success: true,
        data: { infer, report, rewards } as unknown as Record<string, unknown>,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push(`✗ Failed: ${msg}`);
      await callback?.({ text: `Earn cycle failed:\n${steps.join('\n')}` });
      return { success: false, error: msg };
    }
  },
};
