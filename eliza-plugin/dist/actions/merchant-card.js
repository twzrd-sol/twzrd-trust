import { fetchMerchantCard } from '@wzrd_sol/sdk';
import { extractPubkey, getIntelBase, withTimeout } from '../intel-helpers.js';
import { withTracking } from '../paying-fetch.js';
/** Same coverage rule as twzrd-x402-gate isWashCoverageAdequate: full, ring evaluated, not stale. */
export function cardCoverage(card) {
    const rec = card;
    const raw = typeof rec.wash_confidence === 'string' && rec.wash_confidence.trim()
        ? rec.wash_confidence
        : typeof rec.confidence === 'string' && rec.confidence.trim()
            ? rec.confidence
            : null;
    const washConfidence = raw ? raw.trim() : null;
    const signals = rec.circular_flow_signals;
    const ringEvaluated = typeof rec.ring_evaluated === 'boolean'
        ? rec.ring_evaluated
        : typeof signals?.ring_evaluated === 'boolean'
            ? signals.ring_evaluated
            : null;
    const coverageFull = washConfidence?.toLowerCase() === 'full' && ringEvaluated !== false && rec.wash_stale !== true;
    return { washConfidence, coverageFull };
}
function formatMerchantCard(card, coverage) {
    const lines = [
        `Merchant card for ${card.merchant ?? 'unknown'}`,
        `In corpus: ${card.in_corpus ? 'yes' : 'no'}`,
        `Wash flagged: ${card.wash_flagged === true ? 'YES — default refuse pay' : card.wash_flagged === false ? 'no' : 'unknown'}`,
        `Wash coverage: ${coverage.washConfidence ?? 'none'}${coverage.coverageFull ? ' (full)' : ''}`,
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
    else if (card.wash_flagged !== false || !coverage.coverageFull) {
        lines.push('Wash status unknown: not a clean bill. Strict hosts (twzrd-x402-gate refuseWashUnknown) refuse this pay_to.');
    }
    return lines.join('\n');
}
export const merchantCardAction = {
    name: 'WZRD_MERCHANT_CARD',
    similes: ['WZRD_MERCHANT', 'MERCHANT_CARD', 'INTEL_MERCHANT_CARD', 'CHECK_WASH'],
    description: 'Free GET merchant demand-quality card for a Solana receive wallet (no auth). ' +
        'Returns wash_flagged, tier, unique payers, catalog join when listed. ' +
        'Default: if wash_flagged is true, do not pay that pay_to. If the card is unavailable, do not pay (fail-closed).',
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
            const card = await withTimeout(() => fetchMerchantCard(pubkey, { apiBase, fetchImpl: withTracking(globalThis.fetch) }));
            if (!card) {
                await callback?.({
                    text: `Merchant card unavailable for ${pubkey} (network or invalid), so the wash check could not run. ` +
                        `Fail-closed: do not pay this pay_to until a merchant card answers.`,
                });
                return {
                    success: false,
                    error: 'merchant_card_unavailable',
                    data: { refuse_pay: true, reason: 'merchant_card_unavailable' },
                };
            }
            const coverage = cardCoverage(card);
            const text = formatMerchantCard(card, coverage);
            await callback?.({ text });
            return {
                success: true,
                data: {
                    ...card,
                    wash_confidence: coverage.washConfidence,
                    coverage_full: coverage.coverageFull,
                    refuse_pay: card.wash_flagged === true,
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await callback?.({
                text: `Merchant card failed: ${msg}. The wash check could not run; do not pay this pay_to (fail-closed).`,
            });
            return { success: false, error: msg, data: { refuse_pay: true, reason: 'merchant_card_error' } };
        }
    },
};
