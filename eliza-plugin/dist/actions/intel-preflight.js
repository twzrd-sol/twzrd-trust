import { intelPreflight } from '@wzrd_sol/sdk';
import { getIntelBase, parsePreflightInput, withTimeout } from '../intel-helpers.js';
function isValidBase58Wallet(s) {
    if (!s)
        return false;
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}
function validatePreflight(input) {
    if (input.seller_wallet && !isValidBase58Wallet(input.seller_wallet))
        return 'seller_wallet must be 32-44 char base58';
    if (input.price_usdc != null && (input.price_usdc < 0 || !Number.isFinite(input.price_usdc)))
        return 'price_usdc must be non-negative finite number';
    if (input.resource_name && typeof input.resource_name !== 'string')
        return 'resource_name must be string';
    return null;
}
function formatCard(card, preflightId) {
    const lines = [
        `ReadinessCard v${card.version}`,
        `Decision: ${card.decision}`,
        `Trust score: ${card.trust_score ?? 'n/a'}`,
        `Can spend: ${card.can_spend ? 'yes' : 'no'}`,
    ];
    if (preflightId)
        lines.push(`Preflight ID: ${preflightId}`);
    if (card.resource_name)
        lines.push(`Resource: ${card.resource_name}`);
    if (card.seller_wallet)
        lines.push(`Seller: ${card.seller_wallet}`);
    if (card.price_usdc != null)
        lines.push(`Price: ${card.price_usdc} USDC`);
    if (card.caveats?.length)
        lines.push(`Caveats: ${card.caveats.join('; ')}`);
    if (card.next_fixes?.length)
        lines.push(`Next fixes: ${card.next_fixes.join('; ')}`);
    if (card.paid_deep_dive) {
        lines.push(`Paid deep dive available (${card.paid_price_usdc ?? 0.05} USDC) — use WZRD_INTEL_TRUST`);
    }
    return lines.join('\n');
}
export const intelPreflightAction = {
    name: 'WZRD_INTEL_PREFLIGHT',
    similes: ['WZRD_PREFLIGHT', 'INTEL_PREFLIGHT', 'READINESS_CARD'],
    description: 'Free pre-spend ReadinessCard for a seller/resource/price/intent. Returns decision (allow/warn/block), ' +
        'trust_score, can_spend, caveats, paid_deep_dive upsell, and root_provenance when applicable. ' +
        'Step 1 of the buyer sequence before any x402 payment; follow with WZRD_MERCHANT_CARD (wash refuse default) ' +
        'or preSpendGate which runs both free checks.',
    examples: [
        [
            {
                name: '{{user1}}',
                content: {
                    text: 'Preflight Jupiter Quote Preview before I pay 0.25 USDC to 6EF8rrect...',
                },
            },
            {
                name: '{{agentName}}',
                content: { text: 'ReadinessCard: decision ALLOW, trust_score 72, can_spend yes.' },
            },
        ],
    ],
    validate: async () => true,
    handler: async (runtime, message, _state, _opt, callback) => {
        const content = (message.content ?? {});
        const input = parsePreflightInput(content);
        if (!input.seller_wallet && !input.resource_name && !input.resource_url) {
            await callback?.({
                text: 'Provide seller_wallet, resource_name, or resource_url for preflight. ' +
                    'Example: "Preflight seller JUP6Lkb... at 0.25 USDC"',
            });
            return { success: false, error: 'Missing preflight input' };
        }
        const vErr = validatePreflight(input);
        if (vErr) {
            await callback?.({ text: `Invalid preflight input: ${vErr}` });
            return { success: false, error: vErr };
        }
        const apiBase = getIntelBase(runtime);
        try {
            const res = await withTimeout(() => intelPreflight(input, apiBase));
            const card = res.readiness_card;
            if (!card) {
                const text = `Preflight OK (legacy). decision=${res.decision ?? 'unknown'}, score=${res.trust_score ?? 'n/a'}`;
                await callback?.({ text });
                return { success: true, data: res };
            }
            const preflightId = res.preflight_id;
            const text = formatCard(card, preflightId);
            await callback?.({ text });
            return { success: true, data: { ...res, readiness_card: card } };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await callback?.({ text: `Preflight failed: ${msg}` });
            return { success: false, error: msg };
        }
    },
};
