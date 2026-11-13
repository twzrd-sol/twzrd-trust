import { checkTrust } from "./gate.js";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Whole runs of base58 characters. A run is taken whole, never cut to fit: a
// 44-character slice of an 88-character signature is not an address.
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;
const STATE_KEYS = ["sellerWallet", "seller_wallet", "targetWallet", "payTo", "pay_to", "merchant", "recipient"];
/** The most wallets one message can name and still get a verdict. Past this the provider refuses. */
const MAX_WALLETS = 4;
/** True when `run` is 32-44 base58 characters that decode to exactly 32 bytes (a Solana public key). */
function isWalletShaped(run) {
    if (run.length < 32 || run.length > 44)
        return false;
    let value = 0n;
    for (const ch of run)
        value = value * 58n + BigInt(BASE58_ALPHABET.indexOf(ch));
    let bytes = 0;
    while (bytes < run.length && run[bytes] === "1")
        bytes += 1; // each leading "1" is a zero byte
    for (; value > 0n; value >>= 8n)
        bytes += 1;
    return bytes === 32;
}
/**
 * Every distinct wallet the payment context names:
 *   - each explicit state value (sellerWallet / payTo / merchant / ...)
 *   - each wallet-shaped address in the message text
 *
 * All of them, not a best guess. Picking one (a state value, else the address
 * after a seller keyword, else the first) let a message name a clean wallet
 * where the picker looked and the real destination somewhere else, and the
 * agent was told ALLOW for a wallet it was not about to pay.
 * Reliable enforcement still passes the known payTo to canSpendSafely() directly.
 */
function namedWallets(message, state) {
    const found = [];
    const add = (wallet) => {
        if (!found.includes(wallet))
            found.push(wallet);
    };
    const values = state?.values;
    for (const k of STATE_KEYS) {
        const cand = values?.[k];
        if (typeof cand === "string" && cand.length >= 32)
            add(cand);
    }
    const text = message?.content?.text;
    if (typeof text === "string") {
        for (const m of text.matchAll(BASE58_RUN))
            if (isWalletShaped(m[0]))
                add(m[0]);
    }
    return found;
}
const short = (wallet) => `${wallet.slice(0, 6)}...`;
/** Higher is worse: blocked, then warn, then allow; a missing score is worse than any number. */
function worseFirst(a, b) {
    const rank = (v) => (v.blocked ? 2 : v.decision === "warn" ? 1 : 0);
    const score = (v) => v.trustScore ?? -1;
    return rank(b) - rank(a) || score(a) - score(b);
}
function paidHint(v) {
    return v.decision === "warn" && v.paidDeepDive
        ? ` [first paid hop: GET https://intel.twzrd.xyz${v.paidDeepDive} ($0.001 USDC). Optional V7 GET /v1/intel/trust $0.05]`
        : "";
}
/** Build a trust-gate provider with custom config (host, minScore, failOpen, timeout). */
export function createTrustGateProvider(config = {}) {
    return {
        name: "TWZRD_TRUST_GATE",
        description: "Buyer-side x402 trust check: scores the wallets a payment message names via the free TWZRD " +
            "preflight (corpus-backed wash/sybil reputation) so the agent refuses block-rated merchants.",
        dynamic: true,
        get: async (_runtime, message, state) => {
            const wallets = namedWallets(message, state);
            if (wallets.length === 0)
                return { text: "", values: {}, data: {} };
            if (wallets.length > MAX_WALLETS) {
                // Too many to check, so nothing is checked and nothing is allowed.
                const reason = `${wallets.length} wallets named, more than the ${MAX_WALLETS} this provider checks`;
                const refused = {
                    sellerWallet: "",
                    decision: "block",
                    trustScore: null,
                    canSpend: false,
                    blocked: true,
                    reason,
                    gateAvailable: false,
                };
                return {
                    text: `TWZRD trust-gate: ${wallets.length} wallets named -> BLOCK - do NOT pay. None was checked ` +
                        `(the limit is ${MAX_WALLETS}). Name the one wallet being paid, or call canSpendSafely(payTo) on it before signing.`,
                    values: { twzrdDecision: "block", twzrdBlocked: true, twzrdTrustScore: null, twzrdGateAvailable: false },
                    data: { trustVerdict: refused, trustVerdicts: [] },
                };
            }
            const verdicts = await Promise.all(wallets.map((wallet) => checkTrust(wallet, config)));
            if (verdicts.length === 1) {
                const v = verdicts[0];
                const flag = v.blocked ? "BLOCK - do NOT pay" : v.decision.toUpperCase();
                return {
                    text: `TWZRD trust-gate: seller ${short(wallets[0])} -> ${flag} (score ${v.trustScore ?? "n/a"}). ${v.reason}${paidHint(v)}`,
                    values: {
                        twzrdDecision: v.decision,
                        twzrdBlocked: v.blocked,
                        twzrdTrustScore: v.trustScore,
                        twzrdGateAvailable: v.gateAvailable,
                    },
                    data: { trustVerdict: v, trustVerdicts: verdicts },
                };
            }
            // Several wallets: the answer is the worst one, and every wallet is listed
            // so the agent can see which verdict belongs to the wallet it pays.
            const worst = [...verdicts].sort(worseFirst)[0];
            const blockedOnes = verdicts.filter((v) => v.blocked);
            const head = worst.blocked
                ? `BLOCK - do NOT pay (${blockedOnes.map((v) => short(v.sellerWallet)).join(", ")} blocked)`
                : `${worst.decision.toUpperCase()} at worst, none blocked`;
            const each = verdicts
                .map((v) => `${short(v.sellerWallet)} ${v.blocked ? "block" : v.decision} (score ${v.trustScore ?? "n/a"})`)
                .join("; ");
            return {
                text: `TWZRD trust-gate: ${verdicts.length} wallets named -> ${head}. ${each}. ` +
                    `The verdict that counts is the one for the wallet being paid: call canSpendSafely(payTo) on it before signing.` +
                    paidHint(worst),
                values: {
                    twzrdDecision: worst.blocked ? "block" : worst.decision,
                    twzrdBlocked: worst.blocked,
                    twzrdTrustScore: worst.trustScore,
                    twzrdGateAvailable: verdicts.every((v) => v.gateAvailable),
                },
                data: { trustVerdict: worst, trustVerdicts: verdicts },
            };
        },
    };
}
/** Default provider (hits https://intel.twzrd.xyz, decision-only gating, fail-closed). */
export const trustGateProvider = createTrustGateProvider();
