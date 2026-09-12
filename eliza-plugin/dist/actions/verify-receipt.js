import { parseReceipt } from '../intel-helpers.js';
import { formatVerifyResult, verifyReceipt } from '../receipt-verify.js';
export const verifyReceiptAction = {
    name: 'WZRD_VERIFY_RECEIPT',
    similes: ['WZRD_VERIFY', 'VERIFY_TWZRD_RECEIPT', 'CHECK_RECEIPT'],
    description: 'Offline verify a TwzrdReceipt with twzrd-receipt-verifier@^1.4.0. ' +
        'V7 is the current surface (freshness signed). V6 is accepted as legacy with ' +
        'freshness=derived_from_timestamp. V5 still verifies but provenance is unsigned. ' +
        'Optional content.max_age_seconds enforces signed timestamp_unix.',
    examples: [
        [
            { name: '{{user1}}', content: { text: 'Verify this receipt: {"version":"v7","kind":"twzrd_reputation_receipt_v7","leaf":"0x...","preimage":{...}}' } },
            { name: '{{agentName}}', content: { text: 'Receipt VALID (v7, freshness=signed, leaf=true, sig=true).' } },
        ],
    ],
    validate: async () => true,
    handler: async (_runtime, message, _state, _opt, callback) => {
        const content = (message.content ?? {});
        const receipt = parseReceipt(content);
        if (!receipt) {
            await callback?.({
                text: 'Provide a TwzrdReceipt as JSON in text or as content.receipt.',
            });
            return { success: false, error: 'Missing receipt' };
        }
        const maxAgeSeconds = num(content.max_age_seconds ?? content.maxAgeSeconds);
        try {
            const result = verifyReceipt(receipt, {
                maxAgeSeconds: maxAgeSeconds && maxAgeSeconds > 0 ? maxAgeSeconds : undefined,
            });
            const text = formatVerifyResult(result);
            await callback?.({ text });
            return {
                success: result.valid,
                data: result,
                error: result.valid ? undefined : result.errors.join('; '),
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await callback?.({ text: `Verify failed: ${msg}` });
            return { success: false, error: msg };
        }
    },
};
function num(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim()) {
        const n = Number(v);
        if (Number.isFinite(n))
            return n;
    }
    return undefined;
}
