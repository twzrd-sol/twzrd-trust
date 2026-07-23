/**
 * installTwzrdAutoGate — canonical default trust checkpoint entry point.
 *
 * Design: docs/strategy/install-autogate-design.md (#1586).
 *
 * One name across three adapters:
 *   1. Fetch / payWrap  — guard raw fetch, then hand to x402 payer
 *   2. x402 client      — onBeforePaymentCreation (official Path E)
 *   3. MPP              — onChallenge via createTwzrdMppOnChallenge
 *
 * Default ON. Kill switch (any):
 *   TWZRD_AUTO_GATE=0|false
 *   TWZRD_GATE_ENABLED=0|false
 *   options.disabled: true
 */
import { type TwzrdGuardOptions } from "./with-guard.js";
import { type InstallX402ClientHookOptions, type X402ClientLike } from "./x402-client-hook.js";
import { type MppOnChallengeHelpers, type MppOnChallengeOptions, type MppChallenge } from "./mpp-hook.js";
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
export type InstallAutoGateFetchOptions = TwzrdGuardOptions & TwzrdAutoGateCommonOptions & {
    /**
     * RAW (non-paying) fetch that still surfaces HTTP 402.
     * Default: globalThis.fetch.
     */
    rawFetch?: typeof fetch;
};
/** @deprecated Prefer InstallAutoGateFetchOptions — same type (fetch adapter). */
export type InstallAutoGateOptions = InstallAutoGateFetchOptions;
export type InstallAutoGateX402Options = InstallX402ClientHookOptions & TwzrdAutoGateCommonOptions;
export type InstallAutoGateMppOptions = MppOnChallengeOptions & TwzrdAutoGateCommonOptions;
/** True when env or options ask to skip the gate entirely. */
export declare function isTwzrdAutoGateDisabled(options?: {
    disabled?: boolean;
}): boolean;
/**
 * Fetch adapter — guard RAW fetch, then hand to payWrap.
 *
 * @example
 *   const payingFetch = installTwzrdAutoGate((g) => wrapFetchWithPayment(g, wallet));
 */
export declare function installTwzrdAutoGate(payWrap: PayWrap, options?: InstallAutoGateFetchOptions): typeof fetch;
/**
 * x402 client adapter — install at onBeforePaymentCreation (before sign).
 *
 * @example
 *   installTwzrdAutoGate(client, { refuseWashFlagged: true });
 */
export declare function installTwzrdAutoGate(client: X402ClientLike, options?: InstallAutoGateX402Options): X402ClientLike;
/**
 * MPP adapter — returns onChallenge for Mppx.create({ onChallenge }).
 *
 * @example
 *   onChallenge: installTwzrdAutoGate("mpp", { signer, policy: { maxAmountUsd: "1.00" } })
 */
export declare function installTwzrdAutoGate(adapter: "mpp", options: InstallAutoGateMppOptions): (challenge: MppChallenge, helpers: MppOnChallengeHelpers) => Promise<string | undefined>;
/**
 * Disable a prior installTwzrdAutoGate on an x402 client (soft uninstall).
 * Fetch compositions cannot be uninstalled — rebuild with disabled:true instead.
 * Process-wide kill: TWZRD_GATE_ENABLED=false or TWZRD_AUTO_GATE=0.
 */
export declare function uninstallTwzrdAutoGate(client: X402ClientLike): void;
//# sourceMappingURL=auto-gate.d.ts.map