/**
 * WZRD_CLAIM — Claim accrued CCM via gasless relay.
 * Server pays all transaction fees. Agent needs 0 SOL.
 */
import type { Action, HandlerCallback, IAgentRuntime } from '@elizaos/core';
import { getWzrdClient } from '../client-factory.js';

export const claimAction: Action = {
  name: 'WZRD_CLAIM',
  similes: ['WZRD_HARVEST', 'CLAIM_CCM', 'COLLECT_REWARDS'],
  description:
    'Claim accrued CCM tokens via gasless relay. Server pays tx fees — agent needs 0 SOL.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Claim my WZRD rewards' } },
      { name: '{{agentName}}', content: { text: 'Claimed 142.5 CCM via gasless relay. Tx: 5S7L...' } },
    ],
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _msg,
    _state,
    _opt,
    callback?: HandlerCallback,
  ) => {
    const client = getWzrdClient(runtime);

    try {
      // Check if there's anything to claim
      const status = await client.getClaimStatus();
      if (status.claimable <= 0) {
        const text =
          `No CCM to claim right now.\n` +
          `Cumulative: ${(status.cumulative_total / 1e9).toFixed(2)} CCM\n` +
          `Already claimed: ${(status.claimed_total / 1e9).toFixed(2)} CCM\n` +
          `Run WZRD_EARN first to accrue rewards.`;
        await callback?.({ text });
        return { success: true, data: status };
      }

      const result = await client.claimRelay();
      if (result.status === 'already_claimed') {
        await callback?.({ text: `Already claimed through root ${result.root_seq}.` });
        return { success: true, data: result as unknown as Record<string, unknown> };
      }

      const text =
        `Claimed CCM via gasless relay.\n` +
        `Amount: ${(result.cumulative_total / 1e9).toFixed(2)} CCM (cumulative)\n` +
        `Root: ${result.root_seq}\n` +
        `Tx: ${result.tx_sig?.slice(0, 20)}...`;
      await callback?.({ text });
      return { success: true, data: result as unknown as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) {
        await callback?.({ text: 'No claims found yet. Run WZRD_EARN to start accruing CCM.' });
        return { success: true, data: {} };
      }
      await callback?.({ text: `Claim failed: ${msg}` });
      return { success: false, error: msg };
    }
  },
};
