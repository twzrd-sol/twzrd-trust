import { checkTrust } from "./gate.js";
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
function resolveSeller(message, state) {
    const values = state?.values;
    for (const k of STATE_KEYS) {
        const cand = values?.[k];
        if (typeof cand === "string" && cand.length >= 32)
            return cand;
    }
    const text = message?.content?.text;
    if (!text)
        return undefined;
    const matches = [...text.matchAll(BASE58)];
    if (matches.length > 1) {
        for (const m of matches) {
            const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
            if (SELLER_KEYWORDS.test(before))
                return m[0];
        }
    }
    return matches[0]?.[0];
}
/** Build a trust-gate provider with custom config (host, minScore, failOpen, timeout). */
export function createTrustGateProvider(config = {}) {
    return {
        name: "TWZRD_TRUST_GATE",
        description: "Buyer-side x402 trust check: scores the counterparty seller wallet via the free TWZRD " +
            "preflight (corpus-backed wash/sybil reputation) so the agent refuses block-rated merchants.",
        dynamic: true,
        get: async (_runtime, message, state) => {
            const seller = resolveSeller(message, state);
            if (!seller)
                return { text: "", values: {}, data: {} };
            const v = await checkTrust(seller, config);
            const flag = v.blocked ? "BLOCK - do NOT pay" : v.decision.toUpperCase();
            const upsellHint = v.decision === "warn" && v.paidDeepDive
                ? ` [upgrade: POST https://intel.twzrd.xyz${v.paidDeepDive} ($0.05 USDC) for full trust proof]`
                : "";
            return {
                text: `TWZRD trust-gate: seller ${seller.slice(0, 6)}... -> ${flag} (score ${v.trustScore ?? "n/a"}). ${v.reason}${upsellHint}`,
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
export const trustGateProvider = createTrustGateProvider();
