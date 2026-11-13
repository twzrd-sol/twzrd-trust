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
 * An answer that arrives but carries no readable decision is not an outage: it
 * blocks whatever failOpen says. Only "allow" and "warn", spelled as strings on
 * a JSON object, let a payment through.
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
        const body = await res.json();
        if (!isRecord(body))
            return unreadableAnswer(sellerWallet, "the body is not a JSON object");
        // A readiness_card that is present must be an object; absent (or null) means the card is the body.
        const nested = body.readiness_card;
        if (nested !== undefined && nested !== null && !isRecord(nested)) {
            return unreadableAnswer(sellerWallet, "readiness_card is not an object");
        }
        const card = isRecord(nested) ? nested : body;
        // Also check top-level paid_trust_endpoint (server returns it at both levels)
        const paidTrustEndpoint = (body.paid_trust_endpoint ?? card.paid_trust_endpoint);
        if (paidTrustEndpoint)
            card.paid_trust_endpoint = paidTrustEndpoint;
        // No default and no coercion: `{}` or an error envelope used to read as "warn",
        // and String(["allow"]) reads as "allow".
        if (typeof card.decision !== "string") {
            return unreadableAnswer(sellerWallet, card.decision === undefined ? "no decision field" : "decision is not a string");
        }
        const raw = card.decision.toLowerCase();
        const KNOWN = ["allow", "warn", "block"];
        if (!KNOWN.includes(raw)) {
            return unreadableAnswer(sellerWallet, "decision is not allow, warn or block");
        }
        const decision = raw;
        const trustScore = typeof card.trust_score === "number" && Number.isFinite(card.trust_score) ? card.trust_score : null;
        const canSpend = card.can_spend === true;
        // A floor needs a score to compare: no numeric trust_score, no pass.
        const scoreBlocks = minScore > 0 && (trustScore === null || trustScore < minScore);
        const blocked = decision === "block" || scoreBlocks;
        const reason = !blocked
            ? `TWZRD preflight: ${decision} (trust_score=${trustScore})`
            : decision === "block"
                ? `TWZRD preflight blocked (trust_score=${trustScore})`
                : trustScore === null
                    ? `no numeric trust_score to check against min ${minScore}`
                    : `trust_score ${trustScore} below min ${minScore}`;
        const teaser = (card.paid_teaser ?? card.paid_quick_endpoint);
        const paidDeepDive = decision === "warn"
            ? typeof teaser === "string" && teaser.includes("/quick")
                ? teaser
                : `/v1/intel/quick/${sellerWallet}`
            : undefined;
        const preflightId = typeof body.preflight_id === "number" ? body.preflight_id : undefined;
        return { sellerWallet, decision, trustScore, canSpend, blocked, reason, gateAvailable: true, paidDeepDive, preflightId };
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
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Verdict for "the preflight answered, and the answer says nothing the gate can read".
 * Always a block: failOpen is an outage setting, and this is not an outage.
 */
function unreadableAnswer(sellerWallet, why) {
    console.warn(`[twzrd] payment BLOCKED: the preflight answered with no readable decision (${why}).`);
    return {
        sellerWallet,
        decision: "block",
        trustScore: null,
        canSpend: false,
        blocked: true,
        reason: `TWZRD preflight returned no readable decision (${why})`,
        gateAvailable: true,
    };
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
