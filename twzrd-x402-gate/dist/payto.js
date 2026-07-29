/**
 * Pick the best payment requirements from an x402 accepts[] array.
 * Prefers the Solana-network entry when multiple networks are listed
 * (e.g. CDP 402 bodies list EVM first, Solana second).
 */
/**
 * TWZRD's own facilitator fee payer (== its GET /supported feePayer). Exported so
 * a caller can pass `preferFeePayer: TWZRD_FEE_PAYER`, or set the env alias
 * `TWZRD_PREFER_FEE_PAYER=twzrd`.
 */
export const TWZRD_FEE_PAYER = "4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE";
function feePayerOf(e) {
    const extra = e.extra;
    const fp = extra?.feePayer ?? e.feePayer;
    return typeof fp === "string" ? fp : undefined;
}
/**
 * Resolve the preferred fee payer: explicit option first, then the
 * `TWZRD_PREFER_FEE_PAYER` env var (the literal alias `twzrd` maps to
 * `TWZRD_FEE_PAYER`), else none.
 */
function resolvePreferFeePayer(explicit) {
    const raw = explicit ??
        (typeof process !== "undefined"
            ? process.env?.TWZRD_PREFER_FEE_PAYER
            : undefined);
    if (!raw)
        return undefined;
    return raw.toLowerCase() === "twzrd" ? TWZRD_FEE_PAYER : raw;
}
export function pickRequirements(accepts, opts) {
    const list = accepts ?? [];
    const isSolana = (e) => String(e.network ?? "").toLowerCase().includes("solana");
    // Prefer mainnet: bare "solana", "mainnet" substring, or CAIP-2 with mainnet genesis prefix.
    const isMainnet = (e) => {
        const n = String(e.network ?? "").toLowerCase();
        return n === "solana" || n.includes("mainnet") || n.includes("5eykt4");
    };
    // Fee-payer preference (W2): when a seller multi-lists facilitators in accepts[]
    // (e.g. Dexter + TWZRD), route settlement to the preferred fee payer by SELECTING
    // the matching entry the seller already offers. This never adds, rewrites, or
    // forces an accepts entry onto the seller's 402 — if no offered entry matches, it
    // falls through to the normal network preference below. Only applies within
    // Solana mainnet, where the preferred fee payer is valid.
    const prefer = resolvePreferFeePayer(opts?.preferFeePayer);
    if (prefer) {
        const preferred = list.find((e) => isSolana(e) && isMainnet(e) && feePayerOf(e) === prefer);
        if (preferred)
            return preferred;
    }
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