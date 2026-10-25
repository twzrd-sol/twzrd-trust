import { fetchIntelTrust, preSpendGate, IntelPaymentRequiredError } from '@wzrd_sol/sdk';
import { extractPubkey, formatPaymentRequired, getIntelBase, withTimeout } from '../intel-helpers.js';
import { callerTag, resolvePayingFetch, withTracking } from '../paying-fetch.js';
import { classifyReceipt, describeReceiptSurface, freshnessFromVerify, verifyReceipt, } from '../receipt-verify.js';
/** Zero-spend refusal record, the same shape monid-x402 writes before any signer exists. */
export function refusePacket(reason, subject) {
    return {
        schema: 'twzrd.gate_eval_refuse.v1',
        rail: 'eliza-plugin',
        subject,
        reason,
        signer_invocation_count: 0,
        usdc_spent: 0,
        at: new Date().toISOString(),
    };
}
/** A paid lookup proceeds only with WZRD_INTEL_ALLOW_PAID (true/1) or content.confirm_spend === true. */
export function paidLookupConfirmed(runtime, content) {
    if (content.confirm_spend === true)
        return true;
    const v = runtime.getSetting('WZRD_INTEL_ALLOW_PAID');
    if (v === true || v === 1)
        return true;
    return typeof v === 'string' && ['true', '1'].includes(v.trim().toLowerCase());
}
export const intelTrustAction = {
    name: 'WZRD_INTEL_TRUST',
    similes: ['WZRD_TRUST_RECEIPT', 'INTEL_TRUST', 'GET_TRUST_RECEIPT'],
    description: 'Paid GET /v1/intel/trust/{pubkey} (~0.05 USDC on Solana). Returns renormalized trust score + signed V7 ' +
        'twzrd_receipt (portable offline proof; freshness fields are leaf-bound). Runs free preflight + merchant_card ' +
        'wash check first; aborts on decision=block or wash_flagged before any spend. ' +
        'Legacy V6 receipts, if still returned, are labeled freshness=derived_from_timestamp. ' +
        'Requires an x402-capable fetchImpl (setPayingFetch or host service), and a spend confirmation: ' +
        'runtime setting WZRD_INTEL_ALLOW_PAID=true or message content confirm_spend: true. Without one, nothing is paid.',
    examples: [
        [
            { name: '{{user1}}', content: { text: 'Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' } },
            { name: '{{agentName}}', content: { text: 'Trust receipt received. score=42, Receipt v7 (current surface), leaf=0x...' } },
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
        if (!paidLookupConfirmed(runtime, content)) {
            await callback?.({
                text: `Trust lookup for ${pubkey} costs ~0.05 USDC and was not confirmed. ` +
                    `Set WZRD_INTEL_ALLOW_PAID=true for this agent, or send the request with confirm_spend: true. ` +
                    `No payment was sent.`,
            });
            return {
                success: false,
                error: 'spend_not_confirmed',
                data: { refuse: refusePacket('spend_not_confirmed', pubkey) },
            };
        }
        const apiBase = getIntelBase(runtime);
        const baseFetchImpl = resolvePayingFetch(runtime);
        try {
            const gate = await preSpendGate({ seller_wallet: pubkey }, { apiBase, failOpen: false, refuseWashFlagged: true, fetchImpl: withTracking(baseFetchImpl) });
            if (!gate.allow) {
                const washLine = gate.washFlagged === true ? `Wash flagged: yes (merchant_card refuse default)\n` : '';
                await callback?.({
                    text: `Preflight blocked the trust purchase for ${pubkey}.\n` +
                        `Decision: ${gate.decision}${gate.trustScore != null ? `, trust_score=${gate.trustScore}` : ''}\n` +
                        washLine +
                        `Reason: ${gate.reason}\n` +
                        `No payment was sent.`,
                });
                const error = gate.washFlagged === true ? 'wash_flagged' : 'preflight_block';
                return {
                    success: false,
                    error,
                    data: {
                        decision: gate.decision,
                        trustScore: gate.trustScore,
                        reason: gate.reason,
                        washFlagged: gate.washFlagged ?? null,
                        refuse: refusePacket(error, pubkey),
                    },
                };
            }
            // The SDK returns allow=true with merchantCard=null when the card lookup
            // cannot finish. The SDK's preSpendGate refuses only wash_flagged=true, not
            // incomplete coverage; a missing card does refuse here.
            if (gate.merchantCard == null) {
                await callback?.({
                    text: `Merchant card unavailable for ${pubkey}, so the wash check could not finish. ` +
                        `Fail-closed: do not pay this pay_to. No payment was sent.`,
                });
                return {
                    success: false,
                    error: 'merchant_card_unavailable',
                    data: { refuse: refusePacket('merchant_card_unavailable', pubkey) },
                };
            }
        }
        catch (gateErr) {
            const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
            await callback?.({ text: `Preflight gate unavailable (${msg}); not spending. Try again shortly.` });
            return {
                success: false,
                error: 'preflight_unavailable',
                data: { detail: msg, refuse: refusePacket('preflight_unavailable', pubkey) },
            };
        }
        try {
            const res = await withTimeout((signal) => {
                const abortingFetch = ((input, init) => baseFetchImpl(input, { ...(init || {}), signal }));
                return fetchIntelTrust(pubkey, {
                    apiBase,
                    fetchImpl: withTracking(abortingFetch),
                    caller: callerTag(),
                });
            });
            const paid = res;
            const receipt = paid.twzrd_receipt;
            const verified = receipt ? verifyReceipt(receipt) : null;
            const surface = describeReceiptSurface(receipt);
            const freshness = verified
                ? freshnessFromVerify(verified)
                : surface.freshness;
            const vc = paid.reputation_credential?.credentialSubject;
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
            if (receipt) {
                lines.push(`${surface.label}, leaf: ${receipt.leaf}`, `Offline verify: ${verified?.valid ? 'VALID' : 'INVALID'} (freshness=${freshness})`, verified?.valid
                    ? surface.detail
                    : 'Do not treat freshness as signed unless offline verify is VALID on a V7 domain.', 'Use WZRD_VERIFY_RECEIPT (twzrd-receipt-verifier) to re-check offline.');
            }
            else {
                lines.push('No twzrd_receipt in response.');
            }
            const text = lines.join('\n');
            await callback?.({ text });
            return {
                success: true,
                data: {
                    ...res,
                    receipt_surface: classifyReceipt(receipt),
                    freshness,
                    receipt_valid: verified?.valid ?? false,
                },
            };
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
