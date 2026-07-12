import { installTwzrdAutoGate as buildAutoGate, } from 'twzrd-x402-gate';
let modulePayingFetch = null;
/** Host supplies an x402-capable fetch (agentcash, twzrd-x402-gate, etc.) before runtime creation. */
export function setPayingFetch(f) {
    modulePayingFetch = f;
}
/**
 * Default-on replacement for `setPayingFetch(payWrap(rawFetch))`: guards the raw fetch
 * with the free TWZRD preflight BEFORE handing it to your x402 client's `payWrap`, so a
 * blocked seller is refused before your client ever signs — then registers the result as
 * the module paying fetch (same slot `setPayingFetch` writes to).
 *
 * Opt out with `TWZRD_AUTO_GATE=0` (env) or `{ disabled: true }`.
 *
 * @example
 *   import { installTwzrdAutoGate } from '@wzrd_sol/eliza-plugin';
 *   import { wrapFetchWithPayment } from '@x402/svm';
 *
 *   installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));
 *   const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
 */
export function installTwzrdAutoGate(payWrap, options) {
    setPayingFetch(buildAutoGate(payWrap, options));
}
export function clearPayingFetch() {
    modulePayingFetch = null;
}
function serviceFetch(runtime) {
    for (const name of ['x402', 'payingFetch', 'agentcash']) {
        const svc = runtime.getService(name);
        if (svc?.fetch && typeof svc.fetch === 'function')
            return svc.fetch;
    }
    return null;
}
/** Resolve paying fetch: module setter > runtime service > runtime.fetch > global fetch. */
export function resolvePayingFetch(runtime) {
    if (modulePayingFetch)
        return modulePayingFetch;
    const fromSvc = serviceFetch(runtime);
    if (fromSvc)
        return fromSvc;
    if (runtime.fetch && typeof runtime.fetch === 'function')
        return runtime.fetch;
    return globalThis.fetch;
}
