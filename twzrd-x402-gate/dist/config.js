function parseBlockDecisions(raw) {
    const source = raw?.trim() || "block";
    return new Set(source
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean));
}
export function resolveConfig(overrides) {
    const intelBase = (overrides?.intelBase ??
        process.env.TWZRD_INTEL_BASE ??
        "https://intel.twzrd.xyz").replace(/\/+$/, "");
    const rawMin = overrides?.preflightMinScore ??
        Number(process.env.TWZRD_PREFLIGHT_MIN_SCORE ?? "40");
    const preflightMinScore = (Number.isFinite(rawMin) && rawMin >= 0) ? rawMin : 40;
    const blockDecisions = overrides?.blockDecisions != null
        ? new Set([...overrides.blockDecisions].map((s) => s.trim()).filter(Boolean))
        : parseBlockDecisions(process.env.TWZRD_BLOCK_DECISIONS);
    // Default false (fail-closed): block and log loudly on preflight outage.
    // Opt in to legacy fail-open with TWZRD_FAIL_OPEN=true or TWZRD_FAIL_OPEN=1.
    const failOpen = overrides?.failOpen ??
        (process.env.TWZRD_FAIL_OPEN === "true" ||
            process.env.TWZRD_FAIL_OPEN === "1");
    // Default false (decision-only): an unknown seller (warn / can_spend=false,
    // which is EVERY not-yet-seen merchant at score 45) is NOT blocked by default —
    // only an explicit decision=block (a real wash/sybil flag) blocks. This matches
    // the sister package @wzrd_sol/plugin-trustgate and the preflight's own
    // warn-not-block intent, and keeps the gate usable for discovery. Opt in to
    // strict can_spend gating with TWZRD_GATE_ON_CAN_SPEND=true or =1.
    const gateOnCanSpend = overrides?.gateOnCanSpend ??
        (process.env.TWZRD_GATE_ON_CAN_SPEND === "true" ||
            process.env.TWZRD_GATE_ON_CAN_SPEND === "1");
    const fetchFn = overrides?.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("[twzrd-x402-gate] fetch is not available; pass config.fetch");
    }
    return {
        intelBase,
        preflightMinScore,
        blockDecisions,
        failOpen,
        gateOnCanSpend,
        fetch: fetchFn,
        onWarnUpsell: overrides?.onWarnUpsell,
    };
}
//# sourceMappingURL=config.js.map