import { resolveConfig } from "./config.js";
/**
 * Pure policy — no network. Mirrors scripts/twzrd_gate_agentcash_fetch.sh semantics.
 */
export function evaluateReadinessCard(input) {
    const { card, preflightMinScore, blockDecisions, gateOnCanSpend } = input;
    const decision = card.decision ?? "warn";
    const score = card.trust_score ?? 0;
    if (blockDecisions.has(decision)) {
        return { approved: false, verdict: decision, score: card.trust_score ?? null, card, reason: `twzrd_decision_${decision}` };
    }
    // Decision-only by default: deny on can_spend=false ONLY when the caller
    // explicitly opts in (gateOnCanSpend === true). Matches the documented default
    // (FALSE when omitted) and policy.test.ts. The wrapped integration path
    // (twzrdApprovePayment -> resolveConfig) still passes the resolved config default,
    // so live gating strictness is governed there, not here.
    if (gateOnCanSpend === true && card.can_spend === false) {
        return { approved: false, verdict: decision, score: card.trust_score ?? null, card, reason: "twzrd_can_spend_false" };
    }
    if (score < preflightMinScore) {
        return {
            approved: false,
            verdict: decision,
            score: card.trust_score ?? null,
            card,
            reason: `twzrd_score_${score}_below_${preflightMinScore}`,
        };
    }
    return {
        approved: true,
        verdict: (decision === "warn" ? "warn" : "allow"),
        score: card.trust_score ?? null,
        card,
        reason: decision === "warn" ? "twzrd_warn_allowed" : "twzrd_allow",
    };
}
export function buildPreflightInput(context) {
    const seller = context.sellerWallet ?? context.payTo;
    return {
        resource_name: context.resourceName ?? context.resourceUrl ?? "unknown_x402_resource",
        seller_wallet: seller,
        resource_url: context.resourceUrl,
        price_usdc: context.priceUsdc,
        buyer_wallet: context.buyerWallet,
        agent_intent: context.agentIntent ?? "x402_payment_gate",
        chain: context.chain,
    };
}
export async function twzrdPreflight(input, config) {
    const cfg = config ?? resolveConfig();
    const resp = await cfg.fetch(`${cfg.intelBase}/v1/intel/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    if (!resp.ok) {
        throw new Error(`[twzrd] preflight HTTP ${resp.status}`);
    }
    const data = (await resp.json());
    const card = data.readiness_card ?? data;
    // Surface the server-issued preflight_id (a sibling of readiness_card) onto the card so
    // the verify->act funnel link can be echoed on the paid /v1/intel/trust call.
    if (card.preflight_id == null && typeof data.preflight_id === "number") {
        card.preflight_id = data.preflight_id;
    }
    return card;
}
export async function twzrdApprovePayment(context, config) {
    const cfg = config ?? resolveConfig();
    try {
        const card = await twzrdPreflight(buildPreflightInput(context), cfg);
        const result = evaluateReadinessCard({
            card,
            preflightMinScore: cfg.preflightMinScore,
            blockDecisions: cfg.blockDecisions,
            gateOnCanSpend: cfg.gateOnCanSpend,
        });
        // Fire upsell hook on warn (unknown/low-corpus seller) — fire-and-forget
        if (result.verdict === "warn" && cfg.onWarnUpsell) {
            const seller = card.seller_wallet ?? context.sellerWallet ?? context.payTo;
            void cfg.onWarnUpsell({
                sellerWallet: seller,
                trustScore: card.trust_score ?? null,
                upsellUrl: seller ? `/v1/intel/trust/${seller}` : "/v1/intel/trust/unknown",
                priceUsdc: card.full_report_price_usdc ?? 0.05,
            });
        }
        return { ...result, preflightId: card.preflight_id };
    }
    catch (err) {
        if (!cfg.failOpen) {
            const msg = String(err?.message ?? err).slice(0, 120);
            console.warn(`[twzrd-x402-gate] payment BLOCKED: gate unreachable (fail-closed) — ${msg}. Set TWZRD_FAIL_OPEN=true to allow payments when the gate is down.`);
            return {
                approved: false,
                verdict: "block",
                score: null,
                card: {},
                reason: `twzrd_fail_closed (${msg})`,
                failOpen: false,
            };
        }
        // fail-open: preflight unreachable must not hard-block the agent's payment
        return {
            approved: true,
            verdict: "warn",
            score: null,
            card: {},
            reason: "twzrd_fail_open",
            failOpen: true,
        };
    }
}
//# sourceMappingURL=policy.js.map