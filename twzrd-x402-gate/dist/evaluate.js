import { resolveConfig } from "./config.js";
import { twzrdApprovePayment } from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { quickCheck } from "./quick.js";
/**
 * Evaluate an x402 resource before the buyer pays:
 *   1. Run free TWZRD preflight on the seller (no auth, no cost).
 *   2. Return decision + trust score.
 *   3. If escalateOnWarn is set and decision=warn: autonomously settle the cheap
 *      $0.001 quick tier and re-decide on the paid score (the autonomous risk loop).
 *   4. Else if autoReceipt=true and decision !== block: auto-fetch the paid TWZRD
 *      trust receipt via x402Fetch (TWZRD earns the receipt fee on-chain).
 *
 * Defaults to gateOnCanSpend=false (decision-only) — the free-tier preflight
 * returns can_spend=false for most unknown sellers, which would block too eagerly
 * on platforms like Agentic.Market where sellers are not yet in the corpus.
 */
export async function evaluate_x402_resource(resourceUrl, paymentRequirements, opts = {}) {
    const config = resolveConfig({
        intelBase: opts.intelBase,
        preflightMinScore: opts.preflightMinScore,
        blockDecisions: opts.blockDecisions,
        failOpen: opts.failOpen,
        // Decision-only gate: unknown sellers score warn (~45), not block.
        // Gating on can_spend would block every Agentic.Market seller not in corpus.
        gateOnCanSpend: opts.gateOnCanSpend,
        fetch: opts.fetch,
    });
    const { payTo, amountMicro, resource } = payToFromRequirements(paymentRequirements);
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
    const approval = await twzrdApprovePayment({
        resourceUrl: resource ?? resourceUrl,
        payTo,
        priceUsdc,
        agentIntent: "evaluate_x402_resource",
    }, config);
    const decision = (approval.card.decision ?? "unknown");
    const receiptUrl = payTo
        ? `${config.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`
        : undefined;
    const base = {
        decision,
        trustScore: approval.card.trust_score ?? null,
        approved: approval.approved,
        reason: approval.reason,
        card: approval.card,
        failOpen: approval.failOpen,
        receiptUrl,
    };
    // Autonomous risk-escalation: a *proceeding* `warn` (uncertain / unknown seller)
    // is vetted by settling the cheap $0.001 quick tier and re-deciding on the paid
    // score. This is the autonomous demand loop - the paid call fires from the agent's
    // own risk policy, and the paid signal gates the spend (only tightens). Fail-soft:
    // if the quick tier cannot answer, the base warn decision is preserved.
    if (opts.escalateOnWarn &&
        typeof opts.x402Fetch === "function" &&
        payTo &&
        decision === "warn" &&
        base.approved &&
        (priceUsdc ?? 0) >= (opts.escalateOnWarn.minSpendUsdc ?? 0)) {
        const floor = opts.escalateOnWarn.blockBelowScore ?? config.preflightMinScore;
        const quick = await quickCheck(payTo, {
            intelBase: config.intelBase,
            fetch: config.fetch,
            x402Fetch: opts.x402Fetch,
        });
        if (quick.available && quick.score !== null) {
            const escApproved = quick.score >= floor;
            return {
                ...base,
                approved: escApproved,
                trustScore: quick.score,
                escalated: true,
                escalatedScore: quick.score,
                escalatedTier: quick.tier,
                reason: escApproved
                    ? `twzrd_escalated_warn_allow (paid quick score ${quick.score} >= ${floor})`
                    : `twzrd_escalated_warn_block (paid quick score ${quick.score} < ${floor})`,
            };
        }
        // Quick tier could not answer (fail-soft) - preserve the base warn decision.
        return { ...base, escalated: true, escalatedScore: null };
    }
    // Auto-upsell: on warn or allow, fetch the paid TWZRD trust receipt.
    // This is the revenue capture path: x402Fetch settles $0.05 USDC to TWZRD.
    if (opts.autoReceipt &&
        typeof opts.x402Fetch === "function" &&
        payTo &&
        decision !== "block") {
        try {
            // Echo the verify->act funnel link so this paid call is attributed to its preflight.
            const headers = { accept: "application/json" };
            if (typeof approval.preflightId === "number") {
                headers["x-twzrd-preflight-id"] = String(approval.preflightId);
            }
            const resp = await opts.x402Fetch(`${config.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`, { method: "GET", headers });
            if (resp.ok) {
                const body = (await resp.json());
                const receipt = body.twzrd_receipt;
                const preimage = receipt?.preimage;
                const tx = body.tx ?? body.tx_pending ?? (typeof preimage?.settlement_tx === "string" ? preimage.settlement_tx : undefined);
                const feeCaptured = !!tx || body.charged === true;
                if (opts.onReceipt)
                    opts.onReceipt(receipt, tx);
                return { ...base, receipt, receiptTx: tx, receiptFeeCaptured: feeCaptured };
            }
        }
        catch {
            // Fail-open: receipt upsell failure does not block access to the resource.
        }
    }
    return base;
}
//# sourceMappingURL=evaluate.js.map