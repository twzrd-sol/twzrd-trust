/**
 * Pick the best payment requirements from an x402 accepts[] array.
 * Prefers the Solana-network entry when multiple networks are listed
 * (e.g. CDP 402 bodies list EVM first, Solana second).
 */
export function pickRequirements(accepts) {
    const list = accepts ?? [];
    const isSolana = (e) => String(e.network ?? "").toLowerCase().includes("solana");
    // Prefer mainnet: bare "solana", "mainnet" substring, or CAIP-2 with mainnet genesis prefix.
    const isMainnet = (e) => {
        const n = String(e.network ?? "").toLowerCase();
        return n === "solana" || n.includes("mainnet") || n.includes("5eykt4");
    };
    const solanaMainnet = list.find((e) => isSolana(e) && isMainnet(e));
    const solanaAny = list.find(isSolana);
    return (solanaMainnet ?? solanaAny ?? list[0] ?? {});
}
export function payToFromRequirements(req) {
    const payTo = req.payTo ?? req.pay_to;
    const amountMicro = req.maxAmountRequired ?? req.amount;
    return { payTo, amountMicro, resource: req.resource };
}
export function priceUsdcFromAmountMicro(amountMicro) {
    if (amountMicro == null || amountMicro === "")
        return undefined;
    const n = Number(amountMicro);
    if (!Number.isFinite(n))
        return undefined;
    return n / 1_000_000;
}
//# sourceMappingURL=payto.js.map