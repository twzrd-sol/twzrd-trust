/**
 * WZRD_INTEL_TRUST — Paid trust payload + signed V7 receipt via x402-capable
 * fetch. Preflight-gated: free ReadinessCard + free merchant_card wash check run
 * BEFORE payment; decision=block or wash_flagged aborts before any spend.
 *
 * Current service surface is V7. Legacy V6/V5 payloads are labeled, not treated
 * as the current receipt policy.
 */
import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { fetchIntelTrust, preSpendGate, IntelPaymentRequiredError } from '@wzrd_sol/sdk';
import { extractPubkey, formatPaymentRequired, getIntelBase, withTimeout } from '../intel-helpers.js';
import { resolvePayingFetch } from '../paying-fetch.js';
import {
  classifyReceipt,
  describeReceiptSurface,
  freshnessFromVerify,
  verifyReceipt,
  type TwzrdReceiptLike,
} from '../receipt-verify.js';

export const intelTrustAction: Action = {
  name: 'WZRD_INTEL_TRUST',
  similes: ['WZRD_TRUST_RECEIPT', 'INTEL_TRUST', 'GET_TRUST_RECEIPT'],
  description:
    'Paid GET /v1/intel/trust/{pubkey} (~0.05 USDC on Solana). Returns renormalized trust score + signed V7 ' +
    'twzrd_receipt (portable offline proof; freshness fields are leaf-bound). Runs free preflight + merchant_card ' +
    'wash check first; aborts on decision=block or wash_flagged before any spend. ' +
    'Legacy V6 receipts, if still returned, are labeled freshness=derived_from_timestamp. ' +
    'Requires an x402-capable fetchImpl (setPayingFetch or host service).',
  examples: [
    [
      { name: '{{user1}}', content: { text: 'Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' } },
      { name: '{{agentName}}', content: { text: 'Trust receipt received. score=42, Receipt v7 (current surface), leaf=0x...' } },
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

    try {
      const gate = await preSpendGate(
        { seller_wallet: pubkey },
        { apiBase, failOpen: false, refuseWashFlagged: true, fetchImpl: baseFetchImpl },
      );
      if (!gate.allow) {
        const washLine =
          gate.washFlagged === true ? `Wash flagged: yes (merchant_card refuse default)\n` : '';
        await callback?.({
          text:
            `Preflight blocked the trust purchase for ${pubkey}.\n` +
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
    } catch (gateErr) {
      const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
      await callback?.({ text: `Preflight gate unavailable (${msg}); not spending. Try again shortly.` });
      return { success: false, error: 'preflight_unavailable', data: { detail: msg } };
    }

    try {
      const res = await withTimeout((signal) => {
        const abortingFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
          baseFetchImpl(input, { ...(init || {}), signal })) as typeof fetch;
        return fetchIntelTrust(pubkey, { apiBase, fetchImpl: abortingFetch });
      });
      const paid = res as typeof res & {
        reputation_credential?: {
          credentialSubject?: {
            effectiveTrustScore?: number;
            trustScore?: number;
            washFactor?: number;
            distinctCounterparties?: number;
            corpusScope?: string;
            trustScoreVersion?: string;
          };
        };
      };
      const receipt = paid.twzrd_receipt as TwzrdReceiptLike | undefined;
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
      if (settleTx) lines.push(`Settlement tx${res.tx ? '' : ' (pending)'}: ${settleTx}`);
      if (vc) {
        lines.push(
          `Reputation credential (ERC-8004 AgentReputationCredential):`,
          `  effectiveTrustScore: ${vc.effectiveTrustScore ?? 'n/a'}`,
          `  trustScore: ${vc.trustScore ?? 'n/a'}  washFactor: ${vc.washFactor ?? 'n/a'}`,
          `  distinctCounterparties: ${vc.distinctCounterparties ?? 'n/a'}`,
          `  corpusScope: ${vc.corpusScope ?? 'n/a'}`,
          `  version: ${vc.trustScoreVersion ?? 'n/a'}`,
          `Routing gate: effectiveTrustScore < 30 → block, 30-60 → warn, > 60 → allow`,
        );
      }
      if (receipt) {
        lines.push(
          `${surface.label}, leaf: ${receipt.leaf}`,
          `Offline verify: ${verified?.valid ? 'VALID' : 'INVALID'} (freshness=${freshness})`,
          verified?.valid
            ? surface.detail
            : 'Do not treat freshness as signed unless offline verify is VALID on a V7 domain.',
          'Use WZRD_VERIFY_RECEIPT (twzrd-receipt-verifier) to re-check offline.',
        );
      } else {
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
        } as unknown as Record<string, unknown>,
      };
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
