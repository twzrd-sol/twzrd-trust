import { fetchMerchantCard } from '@wzrd_sol/sdk';
import { extractPubkey, getIntelBase, withTimeout } from '../intel-helpers.js';
function formatMerchantCard(card) {
    const lines = [
        `Merchant card for ${card.merchant ?? 'unknown'}`,
        `In corpus: ${card.in_corpus ? 'yes' : 'no'}`,
        `Wash flagged: ${card.wash_flagged === true ? 'YES — default refuse pay' : card.wash_flagged === false ? 'no' : 'unknown'}`,
    ];
    if (card.wash_label)
        lines.push(`Wash label: ${card.wash_label}`);
    if (card.provider_reputation_tier)
        lines.push(`Tier: ${card.provider_reputation_tier}`);
    if (card.unique_payers_90d != null)
        lines.push(`Unique payers (90d): ${card.unique_payers_90d}`);
    if (card.offering_status)
        lines.push(`Offering: ${card.offering_status}`);
    if (card.catalog_enriched) {
        const name = card.catalog && typeof card.catalog === 'object' && 'name' in card.catalog
            ? String(card.catalog.name ?? '')
            : '';
        lines.push(`Catalog enriched: yes${name ? ` (${name})` : ''} — listing only, not quality proof`);
    }
    else {
        lines.push('Catalog enriched: no (graph only)');
    }
    if (card.wash_flagged === true) {
        lines.push('Policy: do not pay this pay_to (trustless default). Cap only if operator set washMaxUsdc.');
    }
    return lines.join('\n');
}
export const merchantCardAction = {
    name: 'WZRD_MERCHANT_CARD',
    similes: ['WZRD_MERCHANT', 'MERCHANT_CARD', 'INTEL_MERCHANT_CARD', 'CHECK_WASH'],
    description: 'Free GET merchant demand-quality card for a Solana receive wallet (no auth). ' +
        'Returns wash_flagged, tier, unique payers, catalog join when listed. ' +
        'Default: if wash_flagged is true, do not pay that pay_to.',
    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Merchant card for 7G73dUxj8Qn4yH4x9zXkKqZ8oKqZ8oKqZ8o' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Merchant card: wash_flagged YES — default refuse pay' },
            },
        ],
    ],
    validate: async () => true,
    handler: async (runtime, message, _state, _opt, callback) => {
        const content = (message.content ?? {});
        const pubkey = extractPubkey(content);
        if (!pubkey) {
            await callback?.({
                text: 'Provide a merchant/seller wallet (32-44 char base58) for merchant_card.',
            });
            return { success: false, error: 'Missing pubkey' };
        }
        const apiBase = getIntelBase(runtime);
        try {
            const card = await withTimeout(() => fetchMerchantCard(pubkey, { apiBase }));
            if (!card) {
                await callback?.({
                    text: `Merchant card unavailable for ${pubkey} (network or invalid). ` +
                        `Fail-open: do not invent wash_flagged; use WZRD_INTEL_PREFLIGHT decision only.`,
                });
                return { success: false, error: 'merchant_card_unavailable' };
            }
            const text = formatMerchantCard(card);
            await callback?.({ text });
            return {
                success: true,
                data: {
                    ...card,
                    refuse_pay: card.wash_flagged === true,
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await callback?.({ text: `Merchant card failed: ${msg}` });
            return { success: false, error: msg };
        }
    },
};
