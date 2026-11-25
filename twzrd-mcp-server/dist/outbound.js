import { resolvePublicAddresses } from "./ssrf.js";
export class OutboundBlockedError extends Error {
    reason;
    name = "OutboundBlockedError";
    constructor(reason, detail) {
        super(`[twzrd] ${reason} ${detail}`);
        this.reason = reason;
    }
}
function urlOf(input) {
    if (typeof input === "string")
        return input;
    if (input instanceof URL)
        return input.href;
    return input.url;
}
export function createGuardedFetch(options = {}) {
    return (async (input, init) => {
        const raw = urlOf(input);
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            throw new OutboundBlockedError("twzrd_outbound_bad_url", JSON.stringify(String(raw).slice(0, 200)));
        }
        if (url.protocol !== "https:") {
            throw new OutboundBlockedError("twzrd_outbound_not_https", `${url.protocol}//${url.host}`);
        }
        const addresses = await resolvePublicAddresses(url.href, options.resolve);
        if (!addresses)
            throw new OutboundBlockedError("twzrd_ssrf_blocked", `host=${url.hostname}`);
        const transport = options.fetch ?? globalThis.fetch;
        return transport(input, { ...init, redirect: "error" });
    });
}
