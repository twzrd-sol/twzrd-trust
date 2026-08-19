/**
 * Host-configurable Path A receipt policy (V6 / $0.05 trust endpoint).
 *
 * Free preflight still decides allow|warn|block. This policy only decides when
 * the host should auto-purchase a paid portable receipt, and whether failure
 * of that purchase should harden into a deny (true incentive loop).
 */
/** Default spend threshold (USD) above which Path A is required when enabled. */
export const DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC = 10;
/**
 * Normalize host config: `true` → defaults; object → merge defaults; false/omit → null.
 */
export function resolveRequireReceiptPolicy(raw) {
    if (raw === undefined || raw === false)
        return null;
    if (raw === true) {
        return {
            minSpendUsdc: DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC,
            onWarn: true,
            hard: true,
            materialWarnOnly: false,
        };
    }
    return {
        minSpendUsdc: typeof raw.minSpendUsdc === "number" && Number.isFinite(raw.minSpendUsdc)
            ? raw.minSpendUsdc
            : DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC,
        onWarn: raw.onWarn !== false,
        hard: raw.hard !== false,
        materialWarnOnly: raw.materialWarnOnly === true,
    };
}
/**
 * Whether Path A should run for this free decision + resource price.
 * Never for `block` (and not for non-proceeding unknown/block paths).
 */
export function shouldRequirePathAReceipt(input) {
    const { policy } = input;
    if (!policy)
        return false;
    const decision = input.decision ?? "unknown";
    if (decision === "block")
        return false;
    const price = typeof input.priceUsdc === "number" && Number.isFinite(input.priceUsdc)
        ? input.priceUsdc
        : null;
    if (price !== null && price > policy.minSpendUsdc)
        return true;
    if (policy.onWarn && decision === "warn") {
        if (policy.materialWarnOnly) {
            return price !== null && price >= policy.minSpendUsdc;
        }
        return true;
    }
    return false;
}
/**
 * Whether to attempt Path A purchase (explicit autoReceipt or threshold trigger).
 * Still never on block.
 */
export function shouldAttemptPathAReceipt(input) {
    const decision = input.decision ?? "unknown";
    if (decision === "block")
        return false;
    if (input.autoReceipt)
        return true;
    const policy = resolveRequireReceiptPolicy(input.requireReceipt);
    return shouldRequirePathAReceipt({
        policy,
        decision,
        priceUsdc: input.priceUsdc,
    });
}
//# sourceMappingURL=receipt-policy.js.map