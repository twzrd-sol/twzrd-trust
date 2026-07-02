let modulePayingFetch = null;
/** Host supplies an x402-capable fetch (agentcash, twzrd-x402-gate, etc.) before runtime creation. */
export function setPayingFetch(f) {
    modulePayingFetch = f;
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
