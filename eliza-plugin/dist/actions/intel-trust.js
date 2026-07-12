import { fetchIntelTrust, preSpendGate, IntelPaymentRequiredError } from '@wzrd_sol/sdk';
import { extractPubkey, formatPaymentRequired, getIntelBase, withTimeout } from '../intel-helpers.js';
import { resolvePayingFetch } from '../paying-fetch.js';
export const intelTrustAction = {
    name: 'WZRD_INTEL_TRUST',
    similes: ['WZRD_TRUST_RECEIPT', 'INTEL_TRUST', 'GET_TRUST_RECEIPT'],
    description: 'Paid GET /v1/intel/trust/{pubkey} (~0.05 USDC on Solana). Returns renormalized trust score + signed V6 ' +
        'twzrd_receipt (portable offline proof). Runs free preflight + merchant_card wash check first; ' +
        'aborts on decision=block or wash_flagged before any spend. ' +
        'Requires an x402-capable fetchImpl (setPayingFetch or host service). ' +
        'Surfaces payment requirements if no payer is configured.',
    examples: [
        [
            { name: '{{user1}}', content: { text: 'Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' } },
            { name: '{{agentName}}', content: { text: 'Trust receipt received. score=42, receipt leaf=0x...' } },
        ],
    ],
    validate: async () => true,
    handler: async (runtime, message, _state, _opt, callback) => {
        const content = (message.content ?? {});
        const pubkey = extractPubkey(content);
        if (!pubkey) {
            await callback?.({ text: 'Provide a seller pubkey (32-44 char base58) for trust lookup.' });
            return { success: false, error: 'Missing pubkey' };
        }
        const apiBase = getIntelBase(runtime);
        const baseFetchImpl = resolvePayingFetch(runtime);
        // preflight-before-pay + wash refuse: FREE ReadinessCard + free merchant_card.
        // Abort on decision=block or wash_flagged before any payment. failOpen=false so
        // the block-on-block guarantee holds even if the gate errors — a reference
        // plugin must demonstrate the safe posture, not bypass it. Free reads only.
        try {
            const gate = await preSpendGate({ seller_wallet: pubkey }, { apiBase, failOpen: false, refuseWashFlagged: true, fetchImpl: baseFetchImpl });
            if (!gate.allow) {
                const washLine = gate.washFlagged === true
                    ? `Wash flagged: yes (merchant_card refuse default)\n`
                    : '';
                await callback?.({
                    text: `Preflight blocked the trust purchase for ${pubkey}.\n` +
                        `Decision: ${gate.decision}${gate.trustScore != null ? `, trust_score=${gate.trustScore}` : ''}\n` +
                        washLine +
                        `Reason: ${gate.reason}\n` +
                        `No payment was sent.`,
                });
                return {
                    success: false,
                    error: gate.washFlagged === true ? 'wash_flagged' : 'preflight_block',
                    data: {
                        decision: gate.decision,
                        trustScore: gate.trustScore,
                        reason: gate.reason,
                        washFlagged: gate.washFlagged ?? null,
                    },
                };
            }
        }
        catch (gateErr) {
            // failOpen=false means a gate error should NOT silently pay. Surface it and stop.
            const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
            await callback?.({ text: `Preflight gate unavailable (${msg}); not spending. Try again shortly.` });
            return { success: false, error: 'preflight_unavailable', data: { detail: msg } };
        }
        try {
            const res = await withTimeout((signal) => {
                const abortingFetch = ((input, init) => baseFetchImpl(input, { ...(init || {}), signal }));
                return fetchIntelTrust(pubkey, { apiBase, fetchImpl: abortingFetch });
            });
            const receipt = res.twzrd_receipt;
            const vc = res.reputation_credential?.credentialSubject;
            const lines = [
                `Trust payload for ${pubkey}`,
                `Score: ${res.trust?.score ?? 'n/a'}  Paid: ${res.paid ? 'yes' : 'no'}`,
            ];
            const settleTx = res.tx ?? res.tx_pending;
            if (settleTx)
                lines.push(`Settlement tx${res.tx ? '' : ' (pending)'}: ${settleTx}`);
            if (vc) {
                lines.push(`Reputation credential (ERC-8004 AgentReputationCredential):`, `  effectiveTrustScore: ${vc.effectiveTrustScore ?? 'n/a'}`, `  trustScore: ${vc.trustScore ?? 'n/a'}  washFactor: ${vc.washFactor ?? 'n/a'}`, `  distinctCounterparties: ${vc.distinctCounterparties ?? 'n/a'}`, `  corpusScope: ${vc.corpusScope ?? 'n/a'}`, `  version: ${vc.trustScoreVersion ?? 'n/a'}`, `Routing gate: effectiveTrustScore < 30 → block, 30-60 → warn, > 60 → allow`);
            }
            lines.push(receipt
                ? `Receipt v${receipt.version}, leaf: ${receipt.leaf}\nUse WZRD_VERIFY_RECEIPT to verify offline.`
                : 'No twzrd_receipt in response.');
            const text = lines.join('\n');
            await callback?.({ text });
            return { success: true, data: res };
        }
        catch (err) {
            if (err instanceof IntelPaymentRequiredError) {
                const text = formatPaymentRequired(err, apiBase, pubkey);
                await callback?.({ text });
                return { success: false, error: 'payment_required', data: { paymentRequirements: err.paymentRequirements } };
            }
            const msg = err instanceof Error ? err.message : String(err);
            await callback?.({ text: `Intel trust failed: ${msg}` });
            return { success: false, error: msg };
        }
    },
};
