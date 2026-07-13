/**
 * TWZRD Payment Control — protocol adapters into PaymentIntent v1.
 *
 * Adapters normalize protocol-specific payment shapes into the one canonical
 * intent the policy runtime evaluates. The x402 adapter keeps the existing
 * gate's behavior available on the new core; the AP2/UCP adapter is the
 * non-x402 reference — it exists to prove the runtime combines a USER MANDATE
 * with counterparty risk, not merely that it parses another crypto request.
 */
/**
 * Convert an integer base-unit (micro) amount into a decimal string.
 * x402 wire amounts are base units (USDC = 6dp micro); PaymentIntent.amount is
 * a decimal-USD string that the policy runtime runs through toMicroUsd(), so
 * passing the raw micro value straight through mis-scales every amount policy
 * by 10^decimals. Non-integer input is returned as-is (already decimal).
 */
function microUnitsToDecimal(units, decimals) {
    const t = units.trim();
    if (!/^\d+$/.test(t) || decimals <= 0)
        return t;
    const scale = 10n ** BigInt(decimals);
    const value = BigInt(t);
    const whole = value / scale;
    const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
}
/** Normalize a selected x402 payment requirement (v1 or v2 field names). */
export function x402RequirementsToIntent(req, ctx) {
    const payTo = req.payTo ?? req.pay_to;
    const amountUnits = req.amount ?? req.maxAmountRequired;
    if (!payTo)
        throw new Error("[twzrd] x402 requirement missing payTo");
    if (!amountUnits)
        throw new Error("[twzrd] x402 requirement missing amount");
    return {
        protocol: "x402",
        network: req.network ?? "unknown",
        asset: req.asset ?? "unknown",
        amount: microUnitsToDecimal(amountUnits, ctx?.decimals ?? 6),
        payTo,
        resource: {
            url: req.resource ?? ctx?.resourceUrl,
            method: ctx?.method,
        },
        facilitator: ctx?.facilitator,
        agent: ctx?.agent,
        context: ctx?.purpose ? { purpose: ctx.purpose } : undefined,
    };
}
/** Cart -> canonical intent. The mandate rides along for the policy runtime. */
export function ap2CheckoutToIntent(cart, mandate, options) {
    const intent = {
        protocol: "ap2",
        network: options?.network ?? "fiat:card",
        asset: cart.currency,
        amount: cart.total,
        payTo: cart.payTo,
        resource: {
            url: cart.checkoutUrl,
            operation: `checkout:${cart.merchantId}`,
        },
        agent: {
            id: options?.agentId,
            organization: options?.organization,
            mandateId: mandate.mandateId,
        },
        context: {
            purpose: cart.category,
            recurring: cart.recurring,
            priorSpend: cart.priorCharge,
        },
    };
    const normalizedMandate = {
        mandateId: mandate.mandateId,
        purposes: mandate.categories,
        maxPerTransactionUsd: mandate.maxPerTransaction,
        monthlyCeilingUsd: mandate.monthlyCeiling,
        resourceAllow: mandate.merchantAllowPrefixes,
        expiresAt: mandate.expiresAt,
    };
    return { intent, mandate: normalizedMandate };
}
//# sourceMappingURL=intent-adapters.js.map