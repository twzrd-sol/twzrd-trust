/**
 * installTwzrdAutoGate — canonical default trust checkpoint entry point.
 *
 * Design: docs/strategy/install-autogate-design.md (#1586).
 *
 * One name across five adapters:
 *   1. Fetch / payWrap     — guard raw fetch, then hand to x402 payer
 *   2. x402 client         — onBeforePaymentCreation (@x402/core Path E)
 *   3. x402-solana seat    — beforePayment on createX402Client (PayAI 2.1.0+)
 *   4. MPP                 — onChallenge via createTwzrdMppOnChallenge
 *   5. PayKit seat         — onBeforeX402PaymentCreation on createPayKitClient
 *                           (Foundation pay-kit #303; optional / duck-typed)
 *
 * Default ON. Kill switch (any):
 *   TWZRD_AUTO_GATE=0|false
 *   TWZRD_GATE_ENABLED=0|false
 *   options.disabled: true
 *
 * Kill-switch timing, which differs by kind and is deliberate:
 *   - The ENV switches are re-read PER CALL on the MPP, x402-solana,
 *     pay-kit and x402-client adapters, so flipping one takes effect on
 *     already-installed hooks. It is a running switch, not only a deploy-time one.
 *   - `options.disabled: true` is an install-time opt-out and is permanent for
 *     that install: nothing is constructed and no later env change revives it.
 *   - EXCEPTION, adapter 1: the fetch / payWrap adapter still resolves the
 *     switch once, at install, because it composes fetch wrappers rather than
 *     dispatching per call. This is permanent in BOTH directions: setting
 *     TWZRD_AUTO_GATE=0 afterwards does not un-gate an already-composed fetch,
 *     and — the direction that matters — a fetch composed WHILE the switch was
 *     off stays ungated after it is cleared. Rebuild it either way.
 */

import { withTwzrdGuard, type TwzrdGuardOptions } from "./with-guard.js";
import {
  createTwzrdBeforePaymentHook,
  createTwzrdPayKitBeforePaymentHook,
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
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

/** All installs on a client, oldest first. A second install used to REPLACE the
 *  entry, so uninstall only reached the newest and the older install's hook kept
 *  gating with its own `disabled: false`. */
const clientInstalls = new WeakMap<object, ClientInstallState[]>();

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

/**
 * PayKit seat (Foundation pay-kit #303): returns the official `@x402/core`
 * `BeforePaymentCreationHook` for `createPayKitClient({
 *   onBeforeX402PaymentCreation,
 * })`. Same evaluator as `createTwzrdPayKitBeforePaymentHook`. No hard
 * dependency on `@solana/pay-kit`.
 *
 * @example
 *   const client = await createPayKitClient({
 *     accept: ["x402"],
 *     onBeforeX402PaymentCreation: installTwzrdAutoGate("pay-kit", {
 *       refuseWashFlagged: true,
 *     }),
 *     rpcUrl,
 *     signer,
 *   });
 */
export function installTwzrdAutoGate(
  adapter: "pay-kit",
  options?: InstallAutoGateX402Options,
): (context: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>;

export function installTwzrdAutoGate(
  target: PayWrap | X402ClientLike | "mpp" | "x402-solana" | "pay-kit",
  options?: InstallAutoGateFetchOptions | InstallAutoGateX402Options | InstallAutoGateMppOptions,
):
  | typeof fetch
  | X402ClientLike
  | ((challenge: MppChallenge, helpers: MppOnChallengeHelpers) => Promise<string | undefined>)
  | ((
      requirements: X402SelectedRequirements & Record<string, unknown>,
      context?: X402SolanaBeforePaymentContext,
    ) => Promise<BeforePaymentCreationResult>)
  | ((context: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>) {
  // ── MPP ──────────────────────────────────────────────────────────────
  if (target === "mpp") {
    const mppOpts = options as InstallAutoGateMppOptions;
    // `options.disabled` is an install-time decision and stays permanent.
    if (mppOpts?.disabled === true) {
      return async (
        _challenge: MppChallenge,
        helpers: MppOnChallengeHelpers,
      ): Promise<string | undefined> => helpers.createCredential();
    }
    // AUDIT FIX: the env kill switch used to be read ONCE here, so a hook built
    // before TWZRD_AUTO_GATE=0 kept gating forever while the x402-client adapter
    // honoured the same variable per call. Re-read it per call so one documented
    // switch means the same thing on every adapter.
    const gated = createTwzrdMppOnChallenge(mppOpts);
    return async (
      challenge: MppChallenge,
      helpers: MppOnChallengeHelpers,
    ): Promise<string | undefined> =>
      isTwzrdAutoGateDisabled(mppOpts) ? helpers.createCredential() : gated(challenge, helpers);
  }

  // ── PayAI x402-solana beforePayment ────────────────────────────────
  if (target === "x402-solana") {
    const solOpts = options as InstallAutoGateX402Options | undefined;
    if (solOpts?.disabled === true) {
      return async () => undefined;
    }
    // AUDIT FIX: same as the MPP seat — the env kill switch is re-read per call.
    const gated = createTwzrdBeforePaymentHook(solOpts);
    return async (
      requirements: X402SelectedRequirements & Record<string, unknown>,
      context?: X402SolanaBeforePaymentContext,
    ): Promise<BeforePaymentCreationResult> =>
      isTwzrdAutoGateDisabled(solOpts) ? undefined : gated(requirements, context);
  }

  // ── PayKit onBeforeX402PaymentCreation (official @x402/core context) ─
  if (target === "pay-kit") {
    const payKitOpts = options as InstallAutoGateX402Options | undefined;
    if (payKitOpts?.disabled === true) {
      return async () => undefined;
    }
    const gated = createTwzrdPayKitBeforePaymentHook(payKitOpts);
    return async (
      context: BeforePaymentCreationContext,
    ): Promise<BeforePaymentCreationResult> =>
      isTwzrdAutoGateDisabled(payKitOpts) ? undefined : gated(context);
  }

  // ── x402 client ──────────────────────────────────────────────────────
  if (isX402ClientLike(target)) {
    const x402Opts = options as InstallAutoGateX402Options | undefined;
    // AUDIT FIX: this used to short-circuit on the FULL check, env included, so
    // a client installed while TWZRD_AUTO_GATE=0 registered nothing and could
    // never be re-armed by clearing the variable — a permanent fail-open in the
    // exact window an operator uses the switch. Only the install-time opt-out
    // short-circuits now; the wrapped registrar below re-reads the env per call,
    // so an env-off install is inert while the switch is set and gates once it
    // clears. Trade-off: a paymentControl misconfig now throws at install even
    // under the kill switch, i.e. fails fast instead of silently passing through.
    if (x402Opts?.disabled === true) {
      return target;
    }

    if (clientInstalls.has(target as object)) {
      console.warn(
        "[twzrd-x402-gate] installTwzrdAutoGate: client already gated; dual install may double-evaluate. Call uninstallTwzrdAutoGate first.",
      );
    }
    const state: ClientInstallState = { disabled: false };
    const states = clientInstalls.get(target as object);
    if (states) states.push(state);
    else clientInstalls.set(target as object, [state]);

    // Wrap the registrar ONLY for TWZRD's own registration below, then restore
    // it. AUDIT FIX: leaving the patch in place gated every hook the host
    // registered later behind TWZRD's kill switch / uninstall — "gate off"
    // silently became "all host policy off".
    const ownProp = Object.prototype.hasOwnProperty.call(target, "onBeforePaymentCreation");
    const originalProp = target.onBeforePaymentCreation;
    const originalRegister = originalProp.bind(target);
    const patched = ((hook) =>
      originalRegister(async (context) => {
        if (state.disabled || isTwzrdAutoGateDisabled()) {
          return undefined; // proceed unguarded
        }
        return hook(context);
      })) as X402ClientLike["onBeforePaymentCreation"];
    target.onBeforePaymentCreation = patched;

    try {
      installTwzrdX402ClientHook(target, x402Opts);
    } finally {
      if (ownProp) target.onBeforePaymentCreation = originalProp;
      else delete (target as Partial<X402ClientLike>).onBeforePaymentCreation;
      // If the registrar is an accessor pair on the prototype, the patch above
      // went through its SETTER, so no own property was ever created and the
      // `delete` was a no-op — the patched registrar would survive. Assigning
      // back drives the setter to the original.
      //
      // The test is `=== patched`, NOT `!== originalProp`. The looser form fired
      // on any shape whose reads do not round-trip — a Proxy with a dynamic get
      // trap can never satisfy it, so the assignment materialised an own
      // property that permanently shadowed the trap. It also masked the
      // `if (ownProp)` arm above by re-assigning whatever that arm failed to
      // restore, which made the arm untestable. Only ever undo OUR patch.
      if (target.onBeforePaymentCreation === patched) {
        target.onBeforePaymentCreation = originalProp;
      }
    }
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
    '[twzrd-x402-gate] installTwzrdAutoGate: expected a PayWrap function, an x402 client with onBeforePaymentCreation, or the string "mpp" / "x402-solana" / "pay-kit"',
  );
}

/**
 * Disable a prior installTwzrdAutoGate on an x402 client (soft uninstall).
 * Fetch compositions cannot be uninstalled — rebuild with disabled:true instead.
 * Process-wide kill: TWZRD_GATE_ENABLED=false or TWZRD_AUTO_GATE=0.
 */
export function uninstallTwzrdAutoGate(client: X402ClientLike): void {
  const states = clientInstalls.get(client as object);
  if (states?.length) {
    // Every install, not just the newest: each wrapped hook closes over its own
    // state, so missing one leaves that install still gating after uninstall.
    for (const state of states) state.disabled = true;
    return;
  }
  console.warn(
    "[twzrd-x402-gate] uninstallTwzrdAutoGate: no install state for this client (noop).",
  );
}
