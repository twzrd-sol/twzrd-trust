/**
 * WZRD_INTEL_TRUST — Paid trust payload + signed receipt (V5/V6) via x402-capable
 * fetch. Preflight-gated: the free ReadinessCard runs BEFORE the payment and a
 * decision=block aborts before any spend (the protocol's preflight-before-pay rule).
 */
import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { fetchIntelTrust, preSpendGate, IntelPaymentRequiredError } from '@wzrd_sol/sdk';
import { extractPubkey, formatPaymentRequired, getIntelBase, withTimeout } from '../intel-helpers.js';
import { resolvePayingFetch } from '../paying-fetch.js';

export const intelTrustAction: Action = {
  name: 'WZRD_INTEL_TRUST',
  similes: ['WZRD_TRUST_RECEIPT', 'INTEL_TRUST', 'GET_TRUST_RECEIPT'],
  description:
    'Paid GET /v1/intel/trust/{pubkey} (~0.05 USDC). Returns trust score + signed twzrd_receipt (V5/V6). ' +
    'Runs the free preflight first and aborts on decision=block before spending. ' +
    'Requires an x402-capable fetchImpl (setPayingFetch or host service). ' +
    'Surfaces payment requirements if no payer is configured.',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' } },
      { name: '{{agentName}}', content: { text: 'Trust receipt received. score=42, receipt leaf=0x...' } },
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
    const pubkey = extractPubkey(content);
    if (!pubkey) {
      await callback?.({ text: 'Provide a seller pubkey (32-44 char base58) for trust lookup.' });
      return { success: false, error: 'Missing pubkey' };
    }

    const apiBase = getIntelBase(runtime);
    const baseFetchImpl = resolvePayingFetch(runtime);

    // preflight-before-pay: run the FREE ReadinessCard on the counterparty and
    // abort on decision=block BEFORE any payment is signed/sent. failOpen=false so
    // the block-on-block guarantee holds even if the gate errors — a reference
    // plugin must demonstrate the safe posture, not bypass it. The preflight call
    // is free (the gate only ever reads), so this adds no spend.
    try {
      const gate = await preSpendGate(
        { seller_wallet: pubkey },
        { apiBase, failOpen: false, fetchImpl: baseFetchImpl },
      );
      if (!gate.allow) {
        await callback?.({
          text:
            `Preflight blocked the trust purchase for ${pubkey}.\n` +
            `Decision: ${gate.decision}${gate.trustScore != null ? `, trust_score=${gate.trustScore}` : ''}\n` +
            `Reason: ${gate.reason}\n` +
            `No payment was sent.`,
        });
        return {
          success: false,
          error: 'preflight_block',
          data: { decision: gate.decision, trustScore: gate.trustScore, reason: gate.reason },
        };
      }
    } catch (gateErr) {
      // failOpen=false means a gate error should NOT silently pay. Surface it and stop.
      const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
      await callback?.({ text: `Preflight gate unavailable (${msg}); not spending. Try again shortly.` });
      return { success: false, error: 'preflight_unavailable', data: { detail: msg } };
    }

    try {
      const res = await withTimeout((signal) => {
        const abortingFetch = ((input: any, init?: any) =>
          baseFetchImpl(input, { ...(init || {}), signal })) as typeof fetch;
        return fetchIntelTrust(pubkey, { apiBase, fetchImpl: abortingFetch });
      });
      const receipt = res.twzrd_receipt;
      const text =
        `Trust payload for ${pubkey}\n` +
        `Score: ${res.trust?.score ?? 'n/a'}\n` +
        `Paid: ${res.paid ? 'yes' : 'no'}\n` +
        (res.tx ? `Settlement tx: ${res.tx}\n` : '') +
        (receipt
          ? `Receipt v${receipt.version}, leaf: ${receipt.leaf}\n` +
            `Use WZRD_VERIFY_RECEIPT to verify offline.`
          : 'No twzrd_receipt in response.');
      await callback?.({ text });
      return { success: true, data: res as unknown as Record<string, unknown> };
    } catch (err) {
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