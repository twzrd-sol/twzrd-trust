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
import { withTwzrdGuard } from "./with-guard.js";
import { installTwzrdX402ClientHook, } from "./x402-client-hook.js";
import { createTwzrdMppOnChallenge, } from "./mpp-hook.js";
const clientInstalls = new WeakMap();
/** True when env or options ask to skip the gate entirely. */
export function isTwzrdAutoGateDisabled(options) {
    if (options?.disabled === true)
        return true;
    const auto = process.env.TWZRD_AUTO_GATE;
    if (auto === "0" || auto === "false")
        return true;
    const gate = process.env.TWZRD_GATE_ENABLED;
    if (gate === "0" || gate === "false")
        return true;
    return false;
}
function isPayWrap(x) {
    return typeof x === "function";
}
function isX402ClientLike(x) {
    return (!!x &&
        typeof x === "object" &&
        typeof x.onBeforePaymentCreation === "function");
}
export function installTwzrdAutoGate(target, options) {
    // ── MPP ──────────────────────────────────────────────────────────────
    if (target === "mpp") {
        const mppOpts = options;
        if (isTwzrdAutoGateDisabled(mppOpts)) {
            return async (_challenge, helpers) => helpers.createCredential();
        }
        return createTwzrdMppOnChallenge(mppOpts);
    }
    // ── x402 client ──────────────────────────────────────────────────────
    if (isX402ClientLike(target)) {
        const x402Opts = options;
        if (isTwzrdAutoGateDisabled(x402Opts)) {
            return target;
        }
        if (clientInstalls.has(target)) {
            console.warn("[twzrd-x402-gate] installTwzrdAutoGate: client already gated; dual install may double-evaluate. Call uninstallTwzrdAutoGate first.");
        }
        const state = { disabled: false };
        clientInstalls.set(target, state);
        // Wrap the registrar so every installed before-payment hook honors uninstall + env kill.
        const originalRegister = target.onBeforePaymentCreation.bind(target);
        target.onBeforePaymentCreation = ((hook) => originalRegister(async (context) => {
            if (state.disabled || isTwzrdAutoGateDisabled()) {
                return undefined; // proceed unguarded
            }
            return hook(context);
        }));
        installTwzrdX402ClientHook(target, x402Opts);
        return target;
    }
    // ── Fetch / payWrap ──────────────────────────────────────────────────
    if (isPayWrap(target)) {
        const fetchOpts = options;
        const raw = fetchOpts?.rawFetch ?? globalThis.fetch;
        if (isTwzrdAutoGateDisabled(fetchOpts)) {
            return target(raw);
        }
        return target(withTwzrdGuard(raw, fetchOpts));
    }
    throw new TypeError('[twzrd-x402-gate] installTwzrdAutoGate: expected a PayWrap function, an x402 client with onBeforePaymentCreation, or the string "mpp"');
}
/**
 * Disable a prior installTwzrdAutoGate on an x402 client (soft uninstall).
 * Fetch compositions cannot be uninstalled — rebuild with disabled:true instead.
 * Process-wide kill: TWZRD_GATE_ENABLED=false or TWZRD_AUTO_GATE=0.
 */
export function uninstallTwzrdAutoGate(client) {
    const state = clientInstalls.get(client);
    if (state) {
        state.disabled = true;
        return;
    }
    console.warn("[twzrd-x402-gate] uninstallTwzrdAutoGate: no install state for this client (noop).");
}
//# sourceMappingURL=auto-gate.js.map