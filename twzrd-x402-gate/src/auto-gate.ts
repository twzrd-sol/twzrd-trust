/**
 * installTwzrdAutoGate — canonical default trust checkpoint entry point.
 *
 * Design: docs/strategy/install-autogate-design.md (#1586).
 *
 * One name across four adapters:
 *   1. Fetch / payWrap     — guard raw fetch, then hand to x402 payer
 *   2. x402 client         — onBeforePaymentCreation (@x402/core Path E)
 *   3. x402-solana seat    — beforePayment on createX402Client (PayAI 2.1.0+)
 *   4. MPP                 — onChallenge via createTwzrdMppOnChallenge
 *
 * Default ON. Kill switch (any):
 *   TWZRD_AUTO_GATE=0|false
 *   TWZRD_GATE_ENABLED=0|false
 *   options.disabled: true
 */

import { withTwzrdGuard, type TwzrdGuardOptions } from "./with-guard.js";
import {
  createTwzrdBeforePaymentHook,
  installTwzrdX402ClientHook,
  type BeforePaymentCreationResult,
  type InstallX402ClientHookOptions,
  type X402ClientLike,
  type X402SelectedRequirements,
  type X402SolanaBeforePaymentContext,
} from "./x402-client-hook.js";
import {
  createTwzrdMppOnChallenge,
  type MppOnChallengeHelpers,
  type MppOnChallengeOptions,
  type MppChallenge,
} from "./mpp-hook.js";

/**
 * Takes a guarded (pre-pay-checked) fetch and returns the fetch your agent actually
 * calls — i.e. your x402 client composed on top of the guard.
 */
export type PayWrap = (guardedFetch: typeof fetch) => typeof fetch;

export type TwzrdAutoGateCommonOptions = {
  /**
   * Force-disable the gate. Mirrors TWZRD_AUTO_GATE=0|false and
   * TWZRD_GATE_ENABLED=0|false. Prefer env for deploy kill switch; use this for tests.
   */
  disabled?: boolean;
};

export type InstallAutoGateFetchOptions = TwzrdGuardOptions &
  TwzrdAutoGateCommonOptions & {
    /**
     * RAW (non-paying) fetch that still surfaces HTTP 402.
     * Default: globalThis.fetch.
     */
    rawFetch?: typeof fetch;
  };

/** @deprecated Prefer InstallAutoGateFetchOptions — same type (fetch adapter). */
export type InstallAutoGateOptions = InstallAutoGateFetchOptions;

export type InstallAutoGateX402Options = InstallX402ClientHookOptions &
  TwzrdAutoGateCommonOptions;

export type InstallAutoGateMppOptions = MppOnChallengeOptions &
  TwzrdAutoGateCommonOptions;

type ClientInstallState = { disabled: boolean };

const clientInstalls = new WeakMap<object, ClientInstallState>();

/** True when env or options ask to skip the gate entirely. */
export function isTwzrdAutoGateDisabled(options?: { disabled?: boolean }): boolean {
  if (options?.disabled === true) return true;
  const auto = process.env.TWZRD_AUTO_GATE;
  if (auto === "0" || auto === "false") return true;
  const gate = process.env.TWZRD_GATE_ENABLED;
  if (gate === "0" || gate === "false") return true;
  return false;
}

function isPayWrap(x: unknown): x is PayWrap {
  return typeof x === "function";
}

function isX402ClientLike(x: unknown): x is X402ClientLike {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as X402ClientLike).onBeforePaymentCreation === "function"
  );
}

/**
 * Fetch adapter — guard RAW fetch, then hand to payWrap.
 *
 * @example
 *   const payingFetch = installTwzrdAutoGate((g) => wrapFetchWithPayment(g, wallet));
 */
export function installTwzrdAutoGate(
  payWrap: PayWrap,
  options?: InstallAutoGateFetchOptions,
): typeof fetch;

/**
 * x402 client adapter — install at onBeforePaymentCreation (before sign).
 *
 * @example
 *   installTwzrdAutoGate(client, { refuseWashFlagged: true });
 */
export function installTwzrdAutoGate(
  client: X402ClientLike,
  options?: InstallAutoGateX402Options,
): X402ClientLike;

/**
 * MPP adapter — returns onChallenge for Mppx.create({ onChallenge }).
 *
 * @example
 *   onChallenge: installTwzrdAutoGate("mpp", { signer, policy: { maxAmountUsd: "1.00" } })
 */
export function installTwzrdAutoGate(
  adapter: "mpp",
  options: InstallAutoGateMppOptions,
): (challenge: MppChallenge, helpers: MppOnChallengeHelpers) => Promise<string | undefined>;

/**
 * PayAI x402-solana stock-client seat (2.1.0+): returns a `beforePayment` hook
 * for `createX402Client({ beforePayment })`. Runs after requirement selection,
 * before signTransaction. Prefer this over the refuse-script-only happy path.
 *
 * @example
 *   const client = createX402Client({
 *     wallet,
 *     network: "solana",
 *     beforePayment: installTwzrdAutoGate("x402-solana", { refuseWashFlagged: true }),
 *   });
 */
export function installTwzrdAutoGate(
  adapter: "x402-solana",
  options?: InstallAutoGateX402Options,
): (
  requirements: X402SelectedRequirements & Record<string, unknown>,
  context?: X402SolanaBeforePaymentContext,
) => Promise<BeforePaymentCreationResult>;

export function installTwzrdAutoGate(
  target: PayWrap | X402ClientLike | "mpp" | "x402-solana",
  options?: InstallAutoGateFetchOptions | InstallAutoGateX402Options | InstallAutoGateMppOptions,
):
  | typeof fetch
  | X402ClientLike
  | ((challenge: MppChallenge, helpers: MppOnChallengeHelpers) => Promise<string | undefined>)
  | ((
      requirements: X402SelectedRequirements & Record<string, unknown>,
      context?: X402SolanaBeforePaymentContext,
    ) => Promise<BeforePaymentCreationResult>) {
  // ── MPP ──────────────────────────────────────────────────────────────
  if (target === "mpp") {
    const mppOpts = options as InstallAutoGateMppOptions;
    if (isTwzrdAutoGateDisabled(mppOpts)) {
      return async (
        _challenge: MppChallenge,
        helpers: MppOnChallengeHelpers,
      ): Promise<string | undefined> => helpers.createCredential();
    }
    return createTwzrdMppOnChallenge(mppOpts);
  }

  // ── PayAI x402-solana beforePayment ────────────────────────────────
  if (target === "x402-solana") {
    const solOpts = options as InstallAutoGateX402Options | undefined;
    if (isTwzrdAutoGateDisabled(solOpts)) {
      return async () => undefined;
    }
    return createTwzrdBeforePaymentHook(solOpts);
  }

  // ── x402 client ──────────────────────────────────────────────────────
  if (isX402ClientLike(target)) {
    const x402Opts = options as InstallAutoGateX402Options | undefined;
    if (isTwzrdAutoGateDisabled(x402Opts)) {
      return target;
    }

    if (clientInstalls.has(target as object)) {
      console.warn(
        "[twzrd-x402-gate] installTwzrdAutoGate: client already gated; dual install may double-evaluate. Call uninstallTwzrdAutoGate first.",
      );
    }
    const state: ClientInstallState = { disabled: false };
    clientInstalls.set(target as object, state);

    // Wrap the registrar so every installed before-payment hook honors uninstall + env kill.
    const originalRegister = target.onBeforePaymentCreation.bind(target);
    target.onBeforePaymentCreation = ((hook) =>
      originalRegister(async (context) => {
        if (state.disabled || isTwzrdAutoGateDisabled()) {
          return undefined; // proceed unguarded
        }
        return hook(context);
      })) as X402ClientLike["onBeforePaymentCreation"];

    installTwzrdX402ClientHook(target, x402Opts);
    return target;
  }

  // ── Fetch / payWrap ──────────────────────────────────────────────────
  if (isPayWrap(target)) {
    const fetchOpts = options as InstallAutoGateFetchOptions | undefined;
    const raw = fetchOpts?.rawFetch ?? globalThis.fetch;
    if (isTwzrdAutoGateDisabled(fetchOpts)) {
      return target(raw);
    }
    // The payWrap they already supply is a paying fetch. Use it as Path A
    // x402Fetch so the canonical install fires warn+material without a
    // second argument. payWrap(raw) is unguarded — no recursion into the gate.
    const x402Fetch = fetchOpts?.x402Fetch ?? target(raw);
    return target(withTwzrdGuard(raw, { ...fetchOpts, x402Fetch }));
  }

  throw new TypeError(
    '[twzrd-x402-gate] installTwzrdAutoGate: expected a PayWrap function, an x402 client with onBeforePaymentCreation, or the string "mpp" / "x402-solana"',
  );
}

/**
 * Disable a prior installTwzrdAutoGate on an x402 client (soft uninstall).
 * Fetch compositions cannot be uninstalled — rebuild with disabled:true instead.
 * Process-wide kill: TWZRD_GATE_ENABLED=false or TWZRD_AUTO_GATE=0.
 */
export function uninstallTwzrdAutoGate(client: X402ClientLike): void {
  const state = clientInstalls.get(client as object);
  if (state) {
    state.disabled = true;
    return;
  }
  console.warn(
    "[twzrd-x402-gate] uninstallTwzrdAutoGate: no install state for this client (noop).",
  );
}
