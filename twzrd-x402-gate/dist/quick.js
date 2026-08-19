import { CLIENT_VERSION } from "./version.js";
const DEFAULT_BASE = "https://intel.twzrd.xyz";
/** Server price for the quick tier (AMOUNT_TEASER = "1000" micro = $0.001). */
export const QUICK_PRICE_USDC = 0.001;
function unavailable(sellerWallet, reason) {
    return { sellerWallet, tier: null, score: null, payments: null, lastSeen: null,
        paid: false, chargedUsdc: null, available: false, reason };
}
/**
 * $0.001 paid tier+score check for a seller wallet. Never throws (fail-soft).
 * Requires an x402-capable `x402Fetch` to settle the charge.
 */
export async function quickCheck(sellerWallet, opts = {}) {
    if (!sellerWallet)
        return unavailable(sellerWallet, "no seller wallet supplied");
    const x402 = opts.x402Fetch;
    if (typeof x402 !== "function") {
        return unavailable(sellerWallet, "no x402Fetch — quick tier needs a paying fetch ($0.001)");
    }
    const base = (opts.intelBase ?? DEFAULT_BASE).replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? 5000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        // Seat identity (fork-1 caller_id metric — same pair twzrdPreflight always
        // stamps). This quick-tier call previously sent {accept} only, so every
        // $0.001 challenge event landed with caller_id=NULL.
        const clientTag = `twzrd-x402-gate/${CLIENT_VERSION}`;
        const resp = await x402(`${base}/v1/intel/quick/${encodeURIComponent(sellerWallet)}`, {
            method: "GET",
            headers: {
                accept: "application/json",
                "X-TWZRD-Client": clientTag,
                "X-Twzrd-Caller": opts.attribution ? `${opts.attribution.integration}@${CLIENT_VERSION}` : clientTag,
            },
            signal: ctrl.signal,
        });
        if (!resp.ok)
            return unavailable(sellerWallet, `quick HTTP ${resp.status}`);
        const body = (await resp.json());
        const score = typeof body.score === "number" ? body.score : null;
        const tier = (typeof body.tier === "string" ? body.tier : null);
        const payments = typeof body.payments === "number" ? body.payments : null;
        const lastSeen = typeof body.last_seen === "string" ? body.last_seen : null;
        const chargedUsdc = typeof body.charged_amount_usdc === "number" ? body.charged_amount_usdc : null;
        return {
            sellerWallet, tier, score, payments, lastSeen,
            paid: body.paid === true,
            chargedUsdc,
            available: score !== null || tier !== null,
            reason: `quick tier ${tier ?? "?"} (score=${score})`,
        };
    }
    catch (err) {
        const msg = String(err?.message ?? err).slice(0, 80);
        return unavailable(sellerWallet, `quick unreachable: ${msg}`);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=quick.js.map