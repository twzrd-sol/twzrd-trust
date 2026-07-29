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
    // Default true: free merchant_card.wash_flagged → refuse pay (trustless step 3).
    // Opt out: refuseWashFlagged:false or TWZRD_REFUSE_WASH_FLAGGED=0|false.
    const refuseWashEnv = process.env.TWZRD_REFUSE_WASH_FLAGGED;
    const refuseWashFlagged = overrides?.refuseWashFlagged ??
        !(refuseWashEnv === "0" || refuseWashEnv === "false");
    let washMaxUsdc = null;
    if (overrides?.washMaxUsdc != null && Number.isFinite(overrides.washMaxUsdc)) {
        washMaxUsdc = overrides.washMaxUsdc;
    }
    else if (process.env.TWZRD_WASH_MAX_USDC != null && process.env.TWZRD_WASH_MAX_USDC !== "") {
        const n = Number(process.env.TWZRD_WASH_MAX_USDC);
        if (Number.isFinite(n) && n >= 0)
            washMaxUsdc = n;
    }
    // Default observe: Base/EVM payments are allowed but marked decision=unknown
    // (policy allow ≠ reputation allow). Strict blocks unscored networks before sign.
    const envMode = (process.env.TWZRD_UNSUPPORTED_NETWORK_MODE ?? "").trim().toLowerCase();
    const unsupportedNetworkMode = overrides?.unsupportedNetworkMode ??
        (envMode === "strict" ? "strict" : "observe");
    const fetchFn = overrides?.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("[twzrd-x402-gate] fetch is not available; pass config.fetch");
    }
    // Run attribution (integration + runId). When set, also narrows X-Twzrd-Caller.
    // Seat identity (X-Twzrd-Caller / X-TWZRD-Client) is always stamped in
    // twzrdPreflight even without this pair — see policy.ts fork-1 seat metric.
    let attribution;
    const attrIntegration = overrides?.attribution?.integration ?? process.env.TWZRD_ATTRIBUTION_INTEGRATION;
    const attrRunId = overrides?.attribution?.runId ?? process.env.TWZRD_ATTRIBUTION_RUN_ID;
    if (attrIntegration && attrRunId) {
        attribution = { integration: attrIntegration, runId: attrRunId };
    }
    return {
        intelBase,
        preflightMinScore,
        blockDecisions,
        failOpen,
        gateOnCanSpend,
        refuseWashFlagged,
        washMaxUsdc,
        unsupportedNetworkMode,
        fetch: fetchFn,
        onWarnUpsell: overrides?.onWarnUpsell,
        attribution,
    };
}
//# sourceMappingURL=config.js.map