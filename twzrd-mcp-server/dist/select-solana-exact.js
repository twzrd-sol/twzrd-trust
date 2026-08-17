export const USD_PEGGED_ASSETS = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
    Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr: 6,
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
};
export function parseCap(raw, fallback, name) {
    if (raw === undefined || raw === "")
        return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        console.error(`TWZRD MCP: WARNING — ${name}=${JSON.stringify(raw)} is not a ` +
            `finite non-negative number; falling back to safe default $${fallback}. ` +
            `Spend caps are NEVER disabled on a malformed value.`);
        return fallback;
    }
    return n;
}
export function selectSolanaExact(_x402Version, accepts, caps) {
    const req = (accepts || []).find((a) => {
        const row = a;
        return row?.scheme === "exact" && String(row?.network || "").startsWith("solana:");
    });
    if (!req) {
        throw new Error(`Refusing to pay: no Solana "exact" payment option in challenge (${JSON.stringify((accepts || []).map((a) => {
            const row = a;
            return { scheme: row?.scheme, network: row?.network };
        }))})`);
    }
    const payTo = (req.payTo ?? req.pay_to);
    if (typeof payTo !== "string" || payTo.length === 0) {
        throw new Error(`Refusing to pay: challenge has no payment recipient (payTo)`);
    }
    const rawAmount = req.amount ?? req.maxAmountRequired;
    if (!/^\d+$/.test(String(rawAmount).trim())) {
        throw new Error(`Refusing to pay: charge amount is not a base-unit integer (${JSON.stringify(rawAmount)})`);
    }
    const asset = req.asset;
    const trueDecimals = typeof asset === "string" ? USD_PEGGED_ASSETS[asset] : undefined;
    if (trueDecimals === undefined) {
        throw new Error(`Refusing to pay: asset ${JSON.stringify(asset)} is not a known USD-pegged ` +
            `stablecoin, so its charge cannot be evaluated against a USD spend cap. ` +
            `Supported: ${Object.keys(USD_PEGGED_ASSETS).join(", ")}`);
    }
    const extra = req.extra;
    const declaredDecimals = extra?.decimals;
    if (declaredDecimals !== undefined && Number(declaredDecimals) !== trueDecimals) {
        throw new Error(`Refusing to pay: challenge declares decimals=${JSON.stringify(declaredDecimals)} ` +
            `for ${asset}, which really has ${trueDecimals} decimals. Not evaluable.`);
    }
    const amountUsdc = Number(BigInt(String(rawAmount).trim())) / 10 ** trueDecimals;
    if (amountUsdc > caps.maxPerCall) {
        throw new Error(`Refusing: call price $${amountUsdc} exceeds per-call cap $${caps.maxPerCall}`);
    }
    if (caps.spentUsdc + amountUsdc > caps.maxTotal) {
        throw new Error(`Refusing: would exceed session cap $${caps.maxTotal} (spent $${caps.spentUsdc})`);
    }
    return { req, amountUsdc };
}
