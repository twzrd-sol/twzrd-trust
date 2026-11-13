const BOUND_FIELDS = ["scheme", "network", "payTo", "amount", "asset"];
function assertBuiltForCheckedOption(checked, accepted) {
    const refuse = (why) => {
        throw new Error(`Refusing to pay: the payment that was built is not the option that was checked (${why})`);
    };
    if (typeof accepted !== "object" || accepted === null)
        refuse("the payload names no accepted option");
    const built = accepted;
    if (typeof checked.payTo !== "string" || typeof built.payTo !== "string")
        refuse("payTo is not a string");
    for (const field of BOUND_FIELDS) {
        if (built[field] !== checked[field])
            refuse(`${field} differs`);
    }
}
export async function createCheckedPaymentPayload(paymentRequired, deps) {
    const checked = deps.select(paymentRequired.x402Version ?? 2, paymentRequired.accepts ?? []);
    await deps.check(checked);
    const payload = await deps.createPaymentPayload({ ...paymentRequired, accepts: [checked] });
    assertBuiltForCheckedOption(checked, payload?.accepted);
    return payload;
}
