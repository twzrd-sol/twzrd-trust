/**
 * @wzrd_sol/eliza-plugin-source — V7-migrated WZRD Agent Intel for ElizaOS
 *
 * Intel lane (default https://intel.twzrd.xyz):
 *   WZRD_INTEL_PREFLIGHT → WZRD_MERCHANT_CARD → WZRD_INTEL_TRUST → WZRD_VERIFY_RECEIPT
 * Paid intel requires a caller-supplied x402 fetch — either setPayingFetch(payingFetch)
 * or installTwzrdAutoGate(payWrap). Current paid receipt surface is V7.
 * Paid lookups need WZRD_INTEL_ALLOW_PAID=true or content.confirm_spend === true.
 *
 * 0.8.0 removed the retired earn actions (infer/report/earn/claim/rewards).
 */
import type { Action, Plugin } from '@elizaos/core';
import { intelPreflightAction } from './actions/intel-preflight.js';
import { merchantCardAction } from './actions/merchant-card.js';
import { intelTrustAction } from './actions/intel-trust.js';
import { verifyReceiptAction } from './actions/verify-receipt.js';

export const intelActions: Action[] = [
  intelPreflightAction,
  merchantCardAction,
  intelTrustAction,
  verifyReceiptAction,
];

const INTEL_DESCRIPTION =
  'WZRD Agent Intel — free ReadinessCard preflight + free merchant_card wash refuse (default), ' +
  'then optional x402-paid V7 trust receipt (~0.05 USDC, needs WZRD_INTEL_ALLOW_PAID or confirm_spend) + ' +
  'offline verify via twzrd-receipt-verifier. ' +
  'Legacy V6 verification is labeled freshness=derived_from_timestamp. ' +
  'Buyer sequence is call-site / action-driven (not an auto-interceptor of all payments).';

export function createWzrdPlugin(): Plugin {
  return {
    name: 'wzrd',
    description: INTEL_DESCRIPTION,
    actions: [...intelActions],
  };
}

/** Default plugin: intel actions only (0.6+). */
export const wzrdPlugin = createWzrdPlugin();
export default wzrdPlugin;

export {
  intelPreflightAction,
  merchantCardAction,
  intelTrustAction,
  verifyReceiptAction,
};

export { getIntelApiBase, getIntelClient } from './client-factory.js';
export {
  setPayingFetch,
  clearPayingFetch,
  resolvePayingFetch,
  installTwzrdAutoGate,
  autoGateOptions,
} from './paying-fetch.js';
export { refusePacket, paidLookupConfirmed } from './actions/intel-trust.js';
export type { RefusePacket } from './actions/intel-trust.js';

/** SDK intel helpers. TRUSTED_RECEIPT_PUBKEY is the v1 key — use CURRENT_RECEIPT_PUBKEY for V7 verify. */
export {
  IntelPaymentRequiredError,
  intelPreflight,
  fetchIntelTrust,
  fetchMerchantCard,
  preSpendGate,
  intelTrustUrl,
  TRUSTED_RECEIPT_PUBKEY,
  INTEL_TRUST_PRICE_USDC,
} from '@wzrd_sol/sdk';

export {
  verifyReceipt,
  classifyReceipt,
  describeReceiptSurface,
  freshnessStatusFor,
  freshnessFromVerify,
  formatVerifyResult,
  CURRENT_RECEIPT_PUBKEY,
  CURRENT_RECEIPT_KEY_ID,
  REPUTATION_V5_DOMAIN,
  REPUTATION_V6_DOMAIN,
  REPUTATION_V7_DOMAIN,
} from './receipt-verify.js';

export type {
  VerifyReceiptResult,
  VerifyReceiptOptions,
  TwzrdReceiptLike,
  ReceiptVersion,
  FreshnessStatus,
} from './receipt-verify.js';

export type {
  ReadinessCard,
  PreflightInput,
  PreflightResponse,
  MerchantCard,
  TwzrdReceipt,
  IntelTrustResponse,
  X402PaymentRequired,
} from '@wzrd_sol/sdk';
