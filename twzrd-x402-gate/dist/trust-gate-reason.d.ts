/**
 * Stable public reason codes for AutoGate intercept transcripts and logs.
 *
 * Internal policy still uses `twzrd_wash_flagged` etc. (tests + wire history).
 * Map to these strings when emitting operator-facing proof artifacts so docs
 * and cold-agent guides stay consistent.
 */
/** Canonical wash-refuse code for block-proof transcripts. */
export declare const TWZRD_TRUST_GATE_BLOCK_WASH = "TWZRD_TRUST_GATE_BLOCK: wash_flagged";
export declare const TWZRD_TRUST_GATE_BLOCK_CAN_SPEND = "TWZRD_TRUST_GATE_BLOCK: can_spend_false";
export declare const TWZRD_TRUST_GATE_BLOCK_DECISION = "TWZRD_TRUST_GATE_BLOCK: decision_block";
export declare const TWZRD_TRUST_GATE_BLOCK_BUDGET = "TWZRD_TRUST_GATE_BLOCK: budget_exceeded";
/**
 * Map an internal `approval.reason` (or hook abort reason fragment) to a stable
 * public block code. Unknown reasons are namespaced, not dropped.
 */
export declare function toTrustGateBlockReason(internalReason: string): string;
//# sourceMappingURL=trust-gate-reason.d.ts.map