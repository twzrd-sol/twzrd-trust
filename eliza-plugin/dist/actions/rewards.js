import { getWzrdClient } from '../client-factory.js';
export const rewardsAction = {
    name: 'WZRD_REWARDS',
    similes: ['WZRD_BALANCE', 'CHECK_REWARDS', 'MY_CCM'],
    description: 'Check your pending CCM rewards, lifetime total, rank, and contribution count.',
    examples: [
        [
            { name: '{{user1}}', content: { text: 'How much CCM have I earned?' } },
            { name: '{{agentName}}', content: { text: 'Pending: 142.5 CCM. Lifetime: 326,000 CCM. Rank #3.' } },
        ],
    ],
    validate: async () => true,
    handler: async (runtime, _msg, _state, _opt, callback) => {
        const client = getWzrdClient(runtime);
        try {
            const rewards = await client.getRewards();
            const text = `WZRD Rewards:\n` +
                `Pending: ${(rewards.pending_ccm / 1e9).toFixed(2)} CCM\n` +
                `Lifetime: ${(rewards.total_rewarded_ccm / 1e9).toFixed(2)} CCM\n` +
                `Contributions: ${rewards.contribution_count}\n` +
                (rewards.rank ? `Rank: #${rewards.rank}` : 'Rank: unranked');
            await callback?.({ text });
            return { success: true, data: rewards };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await callback?.({ text: `Failed to fetch rewards: ${msg}` });
            return { success: false, error: msg };
        }
    },
};
