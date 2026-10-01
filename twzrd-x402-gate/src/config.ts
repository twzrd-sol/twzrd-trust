import type { TwzrdGateConfig, TwzrdUpsellContext } from "./types.js";

export type ResolvedTwzrdGateConfig = {
  intelBase: string;
  preflightMinScore: number;
  blockDecisions: Set<string>;
  failOpen: boolean;
  gateOnCanSpend: boolean;
  /** Default false: an unevaluated seller is allowed up to the card's recommended cap. */
  refuseUnevaluated: boolean;
  /** Deadline for each intel call (preflight, merchant card, paid receipts), ms. Default 2000. */
  intelTimeoutMs: number;
  /** Default true: refuse when free merchant_card.wash_flagged */
  refuseWashFlagged: boolean;
  /** Soft cap USDC when wash_flagged; null = hard refuse */
  washMaxUsdc: number | null;
  /**
   * Policy for networks that are not scored. Solana mainnet and Base mainnet
   * (`eip155:8453`) are scored. Other EVM networks are not. Default observe.
   * @see UnsupportedNetworkMode in network.ts
   */
  unsupportedNetworkMode: "observe" | "strict";
  fetch: typeof fetch;
  onWarnUpsell?: (ctx: TwzrdUpsellContext) => void | Promise<void>;
  /** Opt-in preflight run attribution (see TwzrdGateConfig.attribution). */
  attribution?: { integration: string; runId: string };
};

function parseBlockDecisions(raw: string | undefined): Set<string> {
  const source = raw?.trim() || "block";
  return new Set(
    source
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Opt-in strict knobs (refuseUnevaluated, gateOnCanSpend) read any common
 * truthy spelling as on: true, 1, "true", "1", "yes", "on" in any case.
 * A typo must not silently leave strict mode off (0.11.2).
 */
const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["", "false", "0", "no", "off"]);
const warnedFlags = new Set<string>();
/**
 * One reading of a boolean flag for every seat (0.11.3): true, 1, or the strings
 * true/1/yes/on in any case are on. Everything else is off, and an unrecognised
 * non-empty string (a typo) is off with a one-time warning, never silently on.
 */
export function isTrueFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (TRUTHY.has(t)) return true;
    if (!FALSY.has(t) && !warnedFlags.has(t)) {
      warnedFlags.add(t);
      console.warn(`[twzrd-x402-gate] unrecognised flag value ${JSON.stringify(v)} treated as off; use true/false`);
    }
  }
  return false;
}
function strictFlag(override: unknown, env: string | undefined): boolean {
  return isTrueFlag(override !== undefined && override !== null ? override : env);
}

const DEFAULT_INTEL_TIMEOUT_MS = 2000;
function intelTimeout(override: unknown, env: string | undefined): number {
  const raw = override ?? env;
  const n = typeof raw === "number" ? raw : raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2_147_483_647) : DEFAULT_INTEL_TIMEOUT_MS;
}

export function resolveConfig(overrides?: TwzrdGateConfig): ResolvedTwzrdGateConfig {
  const intelBase = (
    overrides?.intelBase ??
    process.env.TWZRD_INTEL_BASE ??
    "https://intel.twzrd.xyz"
  ).replace(/\/+$/, "");

  const rawMin =
    overrides?.preflightMinScore ??
    Number(process.env.TWZRD_PREFLIGHT_MIN_SCORE ?? "40");
  const preflightMinScore = (Number.isFinite(rawMin) && rawMin >= 0) ? rawMin : 40;

  const blockDecisions =
    overrides?.blockDecisions != null
      ? new Set([...overrides.blockDecisions].map((s) => s.trim()).filter(Boolean))
      : parseBlockDecisions(process.env.TWZRD_BLOCK_DECISIONS);

  // Default false (fail-closed): block and log loudly on preflight outage,
  // and on merchant_card outage on the reputation-scored path.
  // Opt in to legacy fail-open with TWZRD_FAIL_OPEN=true or TWZRD_FAIL_OPEN=1.
  const failOpen =
    overrides?.failOpen != null
      ? isTrueFlag(overrides.failOpen)
      : process.env.TWZRD_FAIL_OPEN === "true" || process.env.TWZRD_FAIL_OPEN === "1";

  // Default false: can_spend false alone does not block. null_reason
  // unknown_subject is handled earlier (refuseUnevaluated) and is not this
  // knob. Opt in to strict can_spend gating with TWZRD_GATE_ON_CAN_SPEND (true/1/yes/on, any case).
  const gateOnCanSpend = strictFlag(overrides?.gateOnCanSpend, process.env.TWZRD_GATE_ON_CAN_SPEND);

  // Default false (0.11.0+): a seller the server never evaluated is allowed up to
  // the card's recommended_cap_usdc, and refused above it or when no cap is given.
  // Opt in to refusing every unevaluated seller with refuseUnevaluated:true or
  // TWZRD_REFUSE_UNEVALUATED (true/1/yes/on, any case).
  const refuseUnevaluated = strictFlag(overrides?.refuseUnevaluated, process.env.TWZRD_REFUSE_UNEVALUATED);

  // Default true: free merchant_card.wash_flagged → refuse pay (trustless step 3).
  // Opt out: refuseWashFlagged:false or TWZRD_REFUSE_WASH_FLAGGED=0|false.
  const refuseWashEnv = process.env.TWZRD_REFUSE_WASH_FLAGGED;
  const refuseWashFlagged =
    overrides?.refuseWashFlagged ??
    !(refuseWashEnv === "0" || refuseWashEnv === "false");

  let washMaxUsdc: number | null = null;
  if (overrides?.washMaxUsdc != null && Number.isFinite(overrides.washMaxUsdc)) {
    washMaxUsdc = overrides.washMaxUsdc;
  } else if (process.env.TWZRD_WASH_MAX_USDC != null && process.env.TWZRD_WASH_MAX_USDC !== "") {
    const n = Number(process.env.TWZRD_WASH_MAX_USDC);
    if (Number.isFinite(n) && n >= 0) washMaxUsdc = n;
  }

  // Default observe for unscored networks. Solana mainnet and Base mainnet
  // are scored, so they run the preflight. Other EVM networks skip that
  // preflight and are marked decision=unknown (policy allow ≠ reputation
  // allow). Wash still runs — wash_flagged refuses before sign. Strict blocks
  // unscored networks outright.
  const envMode = (process.env.TWZRD_UNSUPPORTED_NETWORK_MODE ?? "").trim().toLowerCase();
  const unsupportedNetworkMode: "observe" | "strict" =
    overrides?.unsupportedNetworkMode ??
    (envMode === "strict" ? "strict" : "observe");

  const fetchFn = overrides?.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("[twzrd-x402-gate] fetch is not available; pass config.fetch");
  }

  // Run attribution (integration + runId). When set, also narrows X-Twzrd-Caller.
  // Seat identity (X-Twzrd-Caller / X-TWZRD-Client) is always stamped on
  // twzrdPreflight AND the paid trust/quick receipt fetches, even without this
  // pair — see policy.ts fork-1 seat metric.
  let attribution: { integration: string; runId: string } | undefined;
  const attrIntegration =
    overrides?.attribution?.integration ?? process.env.TWZRD_ATTRIBUTION_INTEGRATION;
  const attrRunId =
    overrides?.attribution?.runId ?? process.env.TWZRD_ATTRIBUTION_RUN_ID;
  if (attrIntegration && attrRunId) {
    attribution = { integration: attrIntegration, runId: attrRunId };
  }

  return {
    intelBase,
    preflightMinScore,
    blockDecisions,
    failOpen,
    gateOnCanSpend,
    refuseUnevaluated,
    intelTimeoutMs: intelTimeout(overrides?.intelTimeoutMs, process.env.TWZRD_INTEL_TIMEOUT_MS),
    refuseWashFlagged,
    washMaxUsdc,
    unsupportedNetworkMode,
    fetch: fetchFn,
    onWarnUpsell: overrides?.onWarnUpsell,
    attribution,
  };
}
