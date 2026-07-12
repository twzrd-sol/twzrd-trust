import { withTwzrdGuard, type TwzrdGuardOptions } from "./with-guard.js";

/**
 * Takes a guarded (pre-pay-checked) fetch and returns the fetch your agent actually
 * calls — i.e. your x402 client composed on top of the guard (agentcash, ClawRouter,
 * @x402/svm, PayAI, etc.).
 */
export type PayWrap = (guardedFetch: typeof fetch) => typeof fetch;

export type InstallAutoGateOptions = TwzrdGuardOptions & {
  /**
   * The RAW (non-paying) fetch to guard. This MUST be a fetch that still surfaces
   * HTTP 402 — do not pass an already-paying client here (see compatibility note
   * in README: proxied clients like AgentCash/.fetch resolve 402 internally and
   * return 200, so the guard would never see the block condition).
   * Default: globalThis.fetch.
   */
  rawFetch?: typeof fetch;
  /**
   * Force-disable the gate (payWrap gets the raw fetch, unguarded). Mirrors
   * TWZRD_AUTO_GATE=0 / "false". Prefer the env var for a deploy-time kill switch;
   * use this for tests.
   */
  disabled?: boolean;
};

/**
 * Default-on composition helper: guards the RAW fetch with the free TWZRD preflight,
 * THEN hands the guarded fetch to your payment wrapper. This is the one-liner form of
 * the two-step pattern documented in the README:
 *
 *   const raw = globalThis.fetch;
 *   const gated = withTwzrdGuard(raw);
 *   const paying = payWrap(gated);
 *
 * Composing it this way by construction rules out the common mis-wiring of guarding
 * an already-paying fetch (which returns 200 and never gives the guard a 402 to act on).
 *
 * Default ON — a blocked seller throws before payWrap's client ever signs. Opt out with
 * TWZRD_AUTO_GATE=0 (env) or { disabled: true } (per-call), e.g. for a local dev harness
 * that intentionally wants the unguarded fetch.
 *
 * @example
 *   import { installTwzrdAutoGate } from "twzrd-x402-gate";
 *   import { wrapFetchWithPayment } from "@x402/svm";
 *
 *   const payingFetch = installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));
 *   await payingFetch("https://api.exa.ai/search"); // blocked sellers throw before signing
 */
export function installTwzrdAutoGate(
  payWrap: PayWrap,
  options?: InstallAutoGateOptions,
): typeof fetch {
  const raw = options?.rawFetch ?? globalThis.fetch;
  const envDisabled =
    process.env.TWZRD_AUTO_GATE === "0" || process.env.TWZRD_AUTO_GATE === "false";
  const disabled = options?.disabled ?? envDisabled;
  if (disabled) return payWrap(raw);
  const guarded = withTwzrdGuard(raw, options);
  return payWrap(guarded);
}
