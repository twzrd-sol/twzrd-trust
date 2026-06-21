/**
 * elizaOS Provider wrapper around the dep-free trust-gate core.
 *
 * Injects the counterparty seller's TWZRD trust verdict into the agent's context
 * BEFORE it decides to pay, so the model sees "BLOCK - do not pay" for wash-flagged
 * merchants. This provider makes the agent AWARE; it does not intercept signatures.
 * Deterministic enforcement is the explicit `canSpendSafely(payTo)` call your payment
 * action makes before signing - see README.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { checkTrust, type TrustGateConfig, type TrustVerdict } from "./gate.js";

// Base58 (Solana pubkey) shape - used to lift a candidate seller from message text.
const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
// Payment-intent words that tend to precede the seller address in free text.
const SELLER_KEYWORDS = /(pay\s*to|paying|seller|merchant|recipient|payee|send\s*to|transfer\s*to)\b/i;
const STATE_KEYS = ["sellerWallet", "seller_wallet", "targetWallet", "payTo", "pay_to", "merchant", "recipient"];

/**
 * Resolve the seller wallet to check. Priority:
 *   1. explicit state values (sellerWallet / payTo / merchant / ...)  - most reliable
 *   2. a base58 address sitting right after a payment keyword in the message text
 *   3. the first base58 address in the message (best-effort)
 * Reliable enforcement should pass the known payTo to canSpendSafely() directly.
 */
function resolveSeller(message: Memory, state?: State): string | undefined {
  const values = state?.values as Record<string, unknown> | undefined;
  for (const k of STATE_KEYS) {
    const cand = values?.[k];
    if (typeof cand === "string" && cand.length >= 32) return cand;
  }
  const text = (message?.content as { text?: string } | undefined)?.text;
  if (!text) return undefined;
  const matches = [...text.matchAll(BASE58)];
  if (matches.length > 1) {
    for (const m of matches) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
      if (SELLER_KEYWORDS.test(before)) return m[0];
    }
  }
  return matches[0]?.[0];
}

/** Build a trust-gate provider with custom config (host, minScore, failOpen, timeout). */
export function createTrustGateProvider(config: TrustGateConfig = {}): Provider {
  return {
    name: "TWZRD_TRUST_GATE",
    description:
      "Buyer-side x402 trust check: scores the counterparty seller wallet via the free TWZRD " +
      "preflight (corpus-backed wash/sybil reputation) so the agent refuses block-rated merchants.",
    dynamic: true,
    get: async (_runtime: IAgentRuntime, message: Memory, state: State) => {
      const seller = resolveSeller(message, state);
      if (!seller) return { text: "", values: {}, data: {} };
      const v: TrustVerdict = await checkTrust(seller, config);
      const flag = v.blocked ? "BLOCK - do NOT pay" : v.decision.toUpperCase();
      return {
        text: `TWZRD trust-gate: seller ${seller.slice(0, 6)}... -> ${flag} (score ${v.trustScore ?? "n/a"}). ${v.reason}`,
        values: {
          twzrdDecision: v.decision,
          twzrdBlocked: v.blocked,
          twzrdTrustScore: v.trustScore,
          twzrdGateAvailable: v.gateAvailable,
        },
        data: { trustVerdict: v },
      };
    },
  };
}

/** Default provider (hits https://intel.twzrd.xyz, decision-only gating, fail-open). */
export const trustGateProvider: Provider = createTrustGateProvider();
