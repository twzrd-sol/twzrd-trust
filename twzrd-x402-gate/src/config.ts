import type { TwzrdGateConfig } from "./types.js";

export type ResolvedTwzrdGateConfig = {
  intelBase: string;
  preflightMinScore: number;
  blockDecisions: Set<string>;
  failOpen: boolean;
  gateOnCanSpend: boolean;
  fetch: typeof fetch;
};

function parseBlockDecisions(raw: string | undefined): Set<string> {
  const source = raw ?? "block";
  return new Set(
    source
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function resolveConfig(overrides?: TwzrdGateConfig): ResolvedTwzrdGateConfig {
  const intelBase = (
    overrides?.intelBase ??
    process.env.TWZRD_INTEL_BASE ??
    "https://intel.twzrd.xyz"
  ).replace(/\/+$/, "");

  const preflightMinScore =
    overrides?.preflightMinScore ??
    Number(process.env.TWZRD_PREFLIGHT_MIN_SCORE ?? "40");

  const blockDecisions =
    overrides?.blockDecisions != null
      ? new Set([...overrides.blockDecisions].map((s) => s.trim()).filter(Boolean))
      : parseBlockDecisions(process.env.TWZRD_BLOCK_DECISIONS);

  const failOpen =
    overrides?.failOpen ??
    (process.env.TWZRD_FAIL_OPEN !== "false" &&
      process.env.TWZRD_FAIL_OPEN !== "0");

  const gateOnCanSpend =
    overrides?.gateOnCanSpend ??
    (process.env.TWZRD_GATE_ON_CAN_SPEND !== "false" &&
      process.env.TWZRD_GATE_ON_CAN_SPEND !== "0");

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
  };
}
