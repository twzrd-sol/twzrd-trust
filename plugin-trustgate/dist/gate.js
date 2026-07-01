/**
 * twzrd trust-gate core - dependency-free.
 *
 * Buyer-side x402 spend guard for autonomous agents. Before signing a payment to
 * a seller, call the FREE TWZRD preflight (no auth, no cost) and refuse when the
 * decision is "block" (e.g. a wash-flagged / captive-payer merchant).
 *
 * Fail-closed by default: a preflight outage blocks and logs loudly so the agent
 * is never silently approved by an intel hiccup. Set failOpen=true to opt into
 * legacy fail-open behavior (allow on outage) when liveness > security.
 *
 * No @elizaos/core or @solana/web3.js dependency - usable from any JS runtime.
 */
const DEFAULT_BASE = "https://intel.twzrd.xyz";
/**
 * Score a seller wallet via the free TWZRD preflight. Never throws.
 */
export async function checkTrust(sellerWallet, config = {}) {
    const base = (config.intelBase ?? DEFAULT_BASE).replace(/\/+$/, "");
    const minScore = config.minScore ?? 0;
    const doFetch = config.fetchImpl ?? globalThis.fetch;
    const timeoutMs = config.timeoutMs ?? 4000;
    if (timeoutMs <= 0)
        throw new Error("[twzrd] TrustGateConfig.timeoutMs must be a positive number");
    const failOpen = config.failOpen ?? false;
    if (!sellerWallet)
        return gateUnavailable(sellerWallet, "no seller wallet supplied", failOpen);
    if (typeof doFetch !== "function")
        return gateUnavailable(sellerWallet, "no fetch implementation", failOpen);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await doFetch(`${base}/v1/intel/preflight`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ seller_wallet: sellerWallet }),
            signal: ctrl.signal,
        });
        if (!res.ok)
            return gateUnavailable(sellerWallet, `preflight HTTP ${res.status}`, failOpen);
        const body = (await res.json());
        const card = (body.readiness_card ?? body);
        // Also check top-level paid_trust_endpoint (server returns it at both levels)
        const paidTrustEndpoint = (body.paid_trust_endpoint ?? card.paid_trust_endpoint);
        if (paidTrustEndpoint)
            card.paid_trust_endpoint = paidTrustEndpoint;
        const raw = String(card.decision ?? "warn").toLowerCase();
        const KNOWN = ["allow", "warn", "block"];
        const decision = KNOWN.includes(raw) ? raw : "block";
        const trustScore = typeof card.trust_score === "number" ? card.trust_score : null;
        const canSpend = card.can_spend === true;
        const scoreBlocks = minScore > 0 && trustScore !== null && trustScore < minScore;
        const blocked = decision === "block" || scoreBlocks;
        const reason = !blocked
            ? `TWZRD preflight: ${decision} (trust_score=${trustScore})`
            : decision === "block"
                ? `TWZRD preflight blocked (trust_score=${trustScore})`
                : `trust_score ${trustScore} below min ${minScore}`;
        const paidDeepDive = decision === "warn"
            ? card.paid_trust_endpoint ??
                `/v1/intel/trust/${sellerWallet}`
            : undefined;
        return { sellerWallet, decision, trustScore, canSpend, blocked, reason, gateAvailable: true, paidDeepDive };
    }
    catch (err) {
        const msg = String(err?.message ?? err).slice(0, 80);
        return gateUnavailable(sellerWallet, `preflight unreachable: ${msg}`, failOpen);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Convenience guard: true => safe to sign/spend, false => abort the payment.
 * Respects config.failOpen (default false => block on a preflight outage).
 */
export async function canSpendSafely(sellerWallet, config = {}) {
    return !(await checkTrust(sellerWallet, config)).blocked;
}
/** Verdict for the "preflight could not produce an answer" path. */
function gateUnavailable(sellerWallet, reason, failOpen) {
    if (!failOpen) {
        console.warn(`[twzrd] payment BLOCKED: gate unreachable (fail-closed) — ${reason}. Pass failOpen:true to allow payments when the gate is down.`);
    }
    return {
        sellerWallet,
        decision: failOpen ? "warn" : "block",
        trustScore: null,
        canSpend: false,
        blocked: !failOpen,
        reason: `${failOpen ? "fail-open" : "fail-closed"} (${reason})`,
        gateAvailable: false,
    };
}
