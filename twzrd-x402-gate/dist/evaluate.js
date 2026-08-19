import { resolveConfig } from "./config.js";
import { twzrdApprovePayment } from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { quickCheck } from "./quick.js";
import { CLIENT_VERSION } from "./version.js";
import { resolveRequireReceiptPolicy, shouldAttemptPathAReceipt, shouldRequirePathAReceipt, } from "./receipt-policy.js";
/**
 * Evaluate an x402 resource before the buyer pays:
 *   1. Run free TWZRD preflight on the seller (no auth, no cost).
 *   2. Return decision + trust score.
 *   3. If autoReceipt / requireReceipt triggers and decision !== block:
 *      auto-fetch the paid TWZRD trust receipt via x402Fetch (Path A, $0.05 V6).
 *      With requireReceipt.hard (default), deny spend if Path A fails.
 *   4. Else if escalateOnWarn is set and decision=warn: settle the cheap
 *      $0.001 quick tier and re-decide on the paid score (only when Path A
 *      did not already fire).
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
        refuseWashFlagged: opts.refuseWashFlagged,
        washMaxUsdc: opts.washMaxUsdc,
        unsupportedNetworkMode: opts.unsupportedNetworkMode,
        fetch: opts.fetch,
        attribution: opts.attribution,
    });
    const { payTo, amountMicro, resource } = payToFromRequirements(paymentRequirements);
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
    const approval = await twzrdApprovePayment({
        resourceUrl: resource ?? resourceUrl,
        payTo,
        priceUsdc,
        agentIntent: "evaluate_x402_resource",
        // Evaluate the exact network on the requirement the pay client will use
        // (pickRequirements prefers Solana when dual-listed).
        chain: paymentRequirements.network,
    }, 
    // resolveConfig already embeds refuseWashFlagged / washMaxUsdc
    config);
    // Unscored networks: decision stays "unknown" — never map to reputation allow/warn/block.
    const decision = (approval.verdict === "unknown"
        ? "unknown"
        : (approval.card.decision ?? approval.verdict ?? "unknown"));
    // Paid trust receipt is Solana-only product surface — omit for unscored nets.
    const receiptUrl = payTo && approval.reputationScored === true
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
        network: approval.network,
        networkSupported: approval.networkSupported,
        reputationScored: approval.reputationScored,
        policyAction: approval.policyAction,
    };
    // Path A first ($0.05 V6 on material warn/allow). escalateOnWarn ($0.001)
    // only runs when Path A is not required — otherwise it would steal the
    // cash SKU. Never on block.
    const receiptPolicy = resolveRequireReceiptPolicy(opts.requireReceipt);
    const receiptRequired = shouldRequirePathAReceipt({
        policy: receiptPolicy,
        decision,
        priceUsdc,
    });
    const attemptReceipt = shouldAttemptPathAReceipt({
        autoReceipt: opts.autoReceipt,
        requireReceipt: opts.requireReceipt,
        decision,
        priceUsdc,
    });
    if (attemptReceipt && typeof opts.x402Fetch === "function" && payTo) {
        try {
            // Seat identity (fork-1 caller_id metric — same pair twzrdPreflight always
            // stamps). This paid receipt fetch previously sent no identity headers at
            // all, so every Path A challenge event landed with caller_id=NULL.
            const clientTag = `twzrd-x402-gate/${CLIENT_VERSION}`;
            const headers = {
                accept: "application/json",
                "X-TWZRD-Client": clientTag,
                "X-Twzrd-Caller": config.attribution ? `${config.attribution.integration}@${CLIENT_VERSION}` : clientTag,
            };
            // Echo the verify->act funnel link so this paid call is attributed to its preflight.
            if (typeof approval.preflightId === "number") {
                headers["x-twzrd-preflight-id"] = String(approval.preflightId);
            }
            const resp = await opts.x402Fetch(`${config.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`, { method: "GET", headers });
            if (resp.ok) {
                const body = (await resp.json());
                const receipt = body.twzrd_receipt;
                const preimage = receipt?.preimage;
                const tx = body.tx ??
                    body.tx_pending ??
                    (typeof preimage?.settlement_tx === "string"
                        ? preimage.settlement_tx
                        : undefined);
                const feeCaptured = !!tx || body.charged === true;
                if (opts.onReceipt)
                    opts.onReceipt(receipt, tx);
                return {
                    ...base,
                    receipt,
                    receiptTx: tx,
                    receiptFeeCaptured: feeCaptured,
                    receiptRequired,
                };
            }
            // Non-OK paid response: hard require → deny; soft → fail-open.
            if (receiptRequired && receiptPolicy?.hard !== false) {
                return {
                    ...base,
                    approved: false,
                    receiptRequired: true,
                    receiptRequiredDenied: true,
                    reason: `twzrd_receipt_required_failed (HTTP ${resp.status}; price=${priceUsdc ?? "?"} decision=${decision})`,
                    policyAction: "block",
                };
            }
        }
        catch {
            if (receiptRequired && receiptPolicy?.hard !== false) {
                return {
                    ...base,
                    approved: false,
                    receiptRequired: true,
                    receiptRequiredDenied: true,
                    reason: `twzrd_receipt_required_error (price=${priceUsdc ?? "?"} decision=${decision})`,
                    policyAction: "block",
                };
            }
            // Soft autoReceipt: fail-open — do not block merchant spend.
        }
    }
    else if (receiptRequired &&
        receiptPolicy?.hard !== false &&
        typeof opts.x402Fetch !== "function") {
        // Host enabled hard threshold policy but forgot x402Fetch — deny rather
        // than silently skip (would re-create the free-only loop).
        return {
            ...base,
            approved: false,
            receiptRequired: true,
            receiptRequiredDenied: true,
            reason: "twzrd_receipt_required_missing_x402Fetch (wire x402Fetch for Path A)",
            policyAction: "block",
        };
    }
    // Cheap re-decide only when Path A did not already fire.
    if (!receiptRequired &&
        !attemptReceipt &&
        opts.escalateOnWarn &&
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
                receiptRequired: receiptRequired || undefined,
                reason: escApproved
                    ? `twzrd_escalated_warn_allow (paid quick score ${quick.score} >= ${floor})`
                    : `twzrd_escalated_warn_block (paid quick score ${quick.score} < ${floor})`,
            };
        }
        return {
            ...base,
            escalated: true,
            escalatedScore: null,
            receiptRequired: receiptRequired || undefined,
        };
    }
    return { ...base, receiptRequired: receiptRequired || undefined };
}
//# sourceMappingURL=evaluate.js.map