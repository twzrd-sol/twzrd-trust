import { evaluateWashOnlyBeforePayment } from "twzrd-x402-gate";
export async function refuseWashBeforePay(req) {
    const payTo = typeof req.payTo === "string"
        ? req.payTo
        : typeof req.pay_to === "string"
            ? req.pay_to
            : undefined;
    const amount = req.amount != null
        ? String(req.amount)
        : req.maxAmountRequired != null
            ? String(req.maxAmountRequired)
            : undefined;
    const network = typeof req.network === "string" ? req.network : undefined;
    const resource = typeof req.resource === "string" ? req.resource : undefined;
    const decision = await evaluateWashOnlyBeforePayment({
        payTo,
        amount,
        network,
        resource,
    });
    if (decision && decision.abort === true) {
        throw new Error(decision.reason);
    }
}
