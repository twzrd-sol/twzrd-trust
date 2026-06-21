/**
 * @wzrd_sol/eliza-plugin — WZRD Agent Intel + Earn Loop for ElizaOS
 *
 * Intel lane (default https://intel.twzrd.xyz):
 *   WZRD_INTEL_PREFLIGHT → WZRD_INTEL_TRUST → WZRD_VERIFY_RECEIPT
 * Paid intel requires caller-supplied x402 fetch via setPayingFetch().
 *
 * Earn lane (default https://api.twzrd.xyz):
 *   WZRD_INFER → WZRD_REPORT → WZRD_EARN → WZRD_CLAIM / WZRD_REWARDS
 *
 * Config (runtime.getSetting):
 *   SOLANA_PRIVATE_KEY  — required for earn tx/auth
 *   WZRD_API_URL        — optional, defaults to https://api.twzrd.xyz
 *   WZRD_INTEL_URL      — optional, defaults to https://intel.twzrd.xyz
 */
import type { Plugin } from '@elizaos/core';
import { inferAction } from './actions/infer.js';
import { reportAction } from './actions/report.js';
import { earnAction } from './actions/earn.js';
import { claimAction } from './actions/claim.js';
import { rewardsAction } from './actions/rewards.js';
import { intelPreflightAction } from './actions/intel-preflight.js';
import { intelTrustAction } from './actions/intel-trust.js';
import { verifyReceiptAction } from './actions/verify-receipt.js';

export const wzrdPlugin: Plugin = {
  name: 'wzrd',
  description:
    'WZRD Agent Intel — free ReadinessCard preflight (gates spends before paying), x402-paid trust receipts ' +
    '(V5/V6), offline verification on intel.twzrd.xyz. Also ships the legacy earn loop (infer/report/claim) ' +
    'on api.twzrd.xyz.',
  actions: [
    intelPreflightAction,
    intelTrustAction,
    verifyReceiptAction,
    earnAction,
    inferAction,
    reportAction,
    claimAction,
    rewardsAction,
  ],
};

export default wzrdPlugin;

export {
  intelPreflightAction,
  intelTrustAction,
  verifyReceiptAction,
  earnAction,
  inferAction,
  reportAction,
  claimAction,
  rewardsAction,
};

export { getWzrdClient, clearClientCache, getIntelApiBase, getIntelClient } from './client-factory.js';
export { setPayingFetch, clearPayingFetch, resolvePayingFetch } from './paying-fetch.js';
export { WzrdClient } from './client.js';
export type { InferResult, ReportResult, RewardsBalance, ClaimResult } from './client.js';

export {
  IntelPaymentRequiredError,
  intelPreflight,
  fetchIntelTrust,
  verifyReceipt,
  preSpendGate,
  intelTrustUrl,
  TRUSTED_RECEIPT_PUBKEY,
  INTEL_TRUST_PRICE_USDC,
} from '@wzrd_sol/sdk';

export type {
  ReadinessCard,
  PreflightInput,
  PreflightResponse,
  TwzrdReceipt,
  IntelTrustResponse,
  VerifyReceiptResult,
  X402PaymentRequired,
} from '@wzrd_sol/sdk';