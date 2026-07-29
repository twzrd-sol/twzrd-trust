/**
 * Stable public reason codes for AutoGate intercept transcripts and logs.
 *
 * Internal policy still uses `twzrd_wash_flagged` etc. (tests + wire history).
 * Map to these strings when emitting operator-facing proof artifacts so docs
 * and cold-agent guides stay consistent.
 */
/** Canonical wash-refuse code for block-proof transcripts. */
export const TWZRD_TRUST_GATE_BLOCK_WASH = "TWZRD_TRUST_GATE_BLOCK: wash_flagged";
export const TWZRD_TRUST_GATE_BLOCK_CAN_SPEND = "TWZRD_TRUST_GATE_BLOCK: can_spend_false";
export const TWZRD_TRUST_GATE_BLOCK_DECISION = "TWZRD_TRUST_GATE_BLOCK: decision_block";
/**
 * Map an internal `approval.reason` (or hook abort reason fragment) to a stable
 * public block code. Unknown reasons are namespaced, not dropped.
 */
export function toTrustGateBlockReason(internalReason) {
    const r = (internalReason || "").trim();
    // Strip optional `[twzrd] ` prefix from x402 hook abort strings.
    const core = r.replace(/^\[twzrd\]\s*/i, "").split(/\s+payTo=/)[0] ?? r;
    if (core === "twzrd_wash_flagged" ||
        core.startsWith("twzrd_wash_flagged_above_cap") ||
        core.startsWith("twzrd_wash_flagged_")) {
        return TWZRD_TRUST_GATE_BLOCK_WASH;
    }
    if (core === "twzrd_can_spend_false") {
        return TWZRD_TRUST_GATE_BLOCK_CAN_SPEND;
    }
    if (core === "twzrd_decision_block" || core.startsWith("twzrd_decision_block")) {
        return TWZRD_TRUST_GATE_BLOCK_DECISION;
    }
    if (core.startsWith("TWZRD_TRUST_GATE_BLOCK:")) {
        return core;
    }
    return `TWZRD_TRUST_GATE_BLOCK: ${core || "unknown"}`;
}
//# sourceMappingURL=trust-gate-reason.js.map