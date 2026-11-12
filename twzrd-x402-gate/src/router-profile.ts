import type { TwzrdGateConfig } from "./types.js";

/**
 * Router profile: one explicit gate config for routers and payment proxies that
 * run the gate in their own process (a pre-sign hook, a fetch wrapper, an MPP
 * challenge handler) on behalf of their users.
 *
 * What it pins, and why:
 *
 * - Every decision setting is written out, so the gate's own defaults no
 *   longer reach this config. 0.13.0 turned three refusals on by default; a
 *   router on this profile would not have seen that change. resolveConfig lets
 *   an option beat its env variable, so the env variables for the pinned
 *   settings do not move it either.
 * - Missing evidence does not refuse on its own. `refuseUnevaluated: false`: a
 *   seller intel has never evaluated is paid up to the card's own
 *   `recommended_cap_usdc` and refused above it, or when no cap or no price is
 *   known. `refuseWashUnknown: false`: a reachable merchant card that has not
 *   fully answered the wash question does not refuse.
 * - A finding still refuses. `decision: "block"`, a score below 40, an
 *   evaluated warn without a finite cap or above it, and `wash_flagged: true`
 *   all refuse before the signer. `washMaxUsdc: null` keeps the wash refusal
 *   hard: there is no soft cap, and `TWZRD_WASH_MAX_USDC` on the host is not
 *   read.
 * - `failOpen` has no default here. The caller decides what an intel outage
 *   does: `true` pays through it, `false` refuses it.
 * - Nothing is added to what the gate sends. No `attribution` is set, so the
 *   preflight carries only the constant `X-TWZRD-Client` / `X-Twzrd-Caller:
 *   twzrd-x402-gate/<version>` pair the gate always sends there, and the
 *   merchant card call carries no TWZRD header.
 *
 * Not pinned, so an option or env variable still reaches them: `intelBase`
 * (`TWZRD_INTEL_BASE`), `attribution` (`TWZRD_ATTRIBUTION_INTEGRATION` +
 * `TWZRD_ATTRIBUTION_RUN_ID`), the `.kill` / `.pause` sentinels (`stateDir`,
 * `TWZRD_STATE_DIR`) and `tripPauseOnBlockMs` (`TWZRD_TRIP_PAUSE_ON_BLOCK_MS`).
 * Each is off or inert unless the operator sets it.
 *
 * Spread it to override a field: `{ ...routerProfile({ failOpen: true }),
 * intelTimeoutMs: 800 }`. A soft wash cap is such an override, written in the
 * router's own code (`washMaxUsdc: 0.02`); the env variable cannot set it. A
 * changed value in this object ships only in a minor release, with a CHANGELOG
 * entry.
 */
export type RouterProfileOptions = {
  /** Required. What an intel outage (preflight or merchant card) does: true pays, false refuses. */
  failOpen: boolean;
};

export type TwzrdRouterProfile = Readonly<{
  failOpen: boolean;
  refuseUnevaluated: false;
  refuseWashUnknown: false;
  refuseWashFlagged: true;
  washMaxUsdc: null;
  refuseUncappedWarn: true;
  preflightMinScore: 40;
  blockDecisions: readonly ["block"];
  gateOnCanSpend: false;
  unsupportedNetworkMode: "observe";
  intelTimeoutMs: 2000;
}>;

export function routerProfile(options: RouterProfileOptions): TwzrdRouterProfile {
  const failOpen = (options as { failOpen?: unknown } | null | undefined)?.failOpen;
  if (typeof failOpen !== "boolean") {
    throw new TypeError(
      "[twzrd-x402-gate] routerProfile needs failOpen: true or false. It has no default: choose what an intel outage does.",
    );
  }
  const profile = {
    failOpen,
    refuseUnevaluated: false,
    refuseWashUnknown: false,
    refuseWashFlagged: true,
    washMaxUsdc: null,
    refuseUncappedWarn: true,
    preflightMinScore: 40,
    blockDecisions: Object.freeze(["block"] as const),
    gateOnCanSpend: false,
    unsupportedNetworkMode: "observe",
    intelTimeoutMs: 2000,
  } as const;
  // Compile-time check that the profile is a gate config every seat accepts.
  const asConfig: TwzrdGateConfig = profile;
  void asConfig;
  return Object.freeze(profile);
}
