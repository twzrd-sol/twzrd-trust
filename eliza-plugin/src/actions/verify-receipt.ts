/**
 * WZRD_VERIFY_RECEIPT — Offline leaf + Ed25519 verification (no network).
 * Handles both V5 and V6 receipts; the SDK selects the leaf binding from the
 * receipt's domain (V6 binds the reputation_* provenance fields into the leaf).
 */
import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { verifyReceipt } from '@wzrd_sol/sdk';
import { getIntelBase, parseReceipt, withTimeout } from '../intel-helpers.js';

export const verifyReceiptAction: Action = {
  name: 'WZRD_VERIFY_RECEIPT',
  similes: ['WZRD_VERIFY', 'VERIFY_TWZRD_RECEIPT', 'CHECK_RECEIPT'],
  description:
    'Offline verify a TwzrdReceipt (V5 or V6): recompute keccak leaf from preimage and check Ed25519 signature ' +
    'against the published TWZRD key. No network required when trustedPubkey is known.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Verify this receipt: {"version":"v5","leaf":"0x...","preimage":{...}}' } },
      { name: '{{agentName}}', content: { text: 'Receipt valid: leaf OK, signature OK.' } },
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
    const content = (message.content ?? {}) as Record<string, unknown>;
    const receipt = parseReceipt(content);
    if (!receipt) {
      await callback?.({
        text: 'Provide a TwzrdReceipt as JSON in text or as content.receipt.',
      });
      return { success: false, error: 'Missing receipt' };
    }

    const apiBase = getIntelBase(runtime);
    const fetchPubkey = content.fetch_pubkey === true || content.fetchPubkey === true;

    try {
      const result = await withTimeout(() => verifyReceipt(receipt, { apiBase, fetchPubkey }));
      const text = result.valid
        ? `Receipt VALID (leaf=${result.leafValid}, sig=${result.signatureValid}, key=${result.trustedPubkey})`
        : `Receipt INVALID: ${result.errors.join('; ') || 'unknown error'}`;
      await callback?.({ text });
      return {
        success: result.valid,
        data: result as unknown as Record<string, unknown>,
        error: result.valid ? undefined : result.errors.join('; '),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Verify failed: ${msg}` });
      return { success: false, error: msg };
    }
  },
};