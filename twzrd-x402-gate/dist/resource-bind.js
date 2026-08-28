/**
 * x402 resource-binding v1. Canonical JSON leaf (not the earlier binary sketch).
 * Fields: schema_version, pay_to, asset, amount_raw, network, resource_url,
 * body_hash=0, requirements_hash (named projection: payTo/amount/asset/network/
 * resource/scheme — not the verbatim accepts[] blob; mimeType/timeout/extra-only
 * diffs collide). Omitted on purpose: payer (unknown here), tx_signature/slot
 * (a leaf cannot contain its own tx), salt (v1 has none; adding one is v2).
 * Bind is a local decision (leaf_hash on ResourceBindDecision). This seat
 * never mutates seller extra: ExactSvm/Otto compare extra to the advertised
 * 402 extra. extra.memo and extra.twzrd_resource_bind are not written.
 * resourceBindMemo() is for a local Memo IX after settle, not the 402 extra.
 * Hard bind: evaluateResourceBind({ tx_memo }) — UTF-8 of settled Memo IX —
 * or { tx_contains_hash: true }. Transfer legs are NOT verified here.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./intent.js";
export const RESOURCE_BIND_DOMAIN = "twzrd:x402-resource-binding:v1";
export const RESOURCE_BIND_EXTRA_KEY = "twzrd_resource_bind";
export const RESOURCE_BIND_MEMO_PREFIX = "rb1:";
/** Memo program CU ≈ 1320 + 358*bytes. 48 B ≈ 18.5k < ExactSvm 20k budget. */
export const RESOURCE_BIND_MEMO_MAX = 48;
export const ZERO_BODY_HASH = "0".repeat(64);
/** v1 402 JSON body keyed by request URL and accepts[].resource. Header is CAIP. */
export const rawInvoiceByResource = new Map();
export function rememberRawInvoice(body, requestUrl) {
    if (!body || typeof body !== "object")
        return;
    const b = body;
    if (b.x402Version !== 1 || !Array.isArray(b.accepts))
        return;
    if (requestUrl)
        rawInvoiceByResource.set(requestUrl, body);
    for (const a of b.accepts) {
        if (a && typeof a === "object" && typeof a.resource === "string") {
            rawInvoiceByResource.set(a.resource, body);
        }
    }
    while (rawInvoiceByResource.size > 256) {
        rawInvoiceByResource.delete(rawInvoiceByResource.keys().next().value);
    }
}
export function wrapFetchRememberInvoice(inner) {
    return async (input, init) => {
        const res = await inner(input, init);
        if (res.status !== 402)
            return res;
        try {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            rememberRawInvoice(await res.clone().json(), url);
        }
        catch { /* not JSON */ }
        return res;
    };
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const refuse = (reason, leaf_hash = null) => ({
    strength: "refuse", evidence_level: "unbound", fact_type: "resource_bound",
    leaf_hash, extra_stamped: false, reason,
});
export function canonicalResourceUrl(url) {
    const u = new URL(url);
    u.hash = "";
    const pairs = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = "";
    for (const [k, v] of pairs)
        u.searchParams.append(k, v);
    return u.toString();
}
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** Match only. Hash still uses the raw 402 string. */
export function networksEquivalent(a, b) {
    const n = (s) => {
        const x = (s ?? "").toLowerCase();
        if (x === "solana" || x === SOLANA_MAINNET.toLowerCase())
            return "solana-mainnet";
        if (x === "solana-devnet" || x === "solana:etwtrabzayq6imfeykouru166vu2xqa1")
            return "solana-devnet";
        if (x === "base" || x === "eip155:8453")
            return "base";
        return x;
    };
    const A = n(a), B = n(b);
    return A !== "" && A === B;
}
function envelopeResource(pr) {
    const r = pr.resource;
    if (typeof r === "string" && r.length > 0)
        return r;
    if (r && typeof r === "object" && typeof r.url === "string") {
        return r.url;
    }
    return undefined;
}
/** Raw accepts[] entry matching selected (payTo/amount/asset, tolerant network). */
export function rawReqFromPaymentRequired(paymentRequired, selected) {
    if (!paymentRequired || typeof paymentRequired !== "object")
        return null;
    const pr = paymentRequired;
    const accepts = Array.isArray(pr.accepts) ? pr.accepts : [];
    const selPay = selected.payTo ?? selected.pay_to;
    const selAmt = selected.amount ?? selected.maxAmountRequired;
    const selAsset = selected.asset;
    for (const a of accepts) {
        if (!a || typeof a !== "object")
            continue;
        const acc = a;
        const pay = acc.payTo ?? acc.pay_to;
        const amt = acc.amount ?? acc.maxAmountRequired;
        if (pay !== selPay)
            continue;
        if (selAmt != null && amt != null && String(amt) !== String(selAmt))
            continue;
        if (selAsset && acc.asset && acc.asset !== selAsset)
            continue;
        if (selected.network && acc.network && !networksEquivalent(acc.network, selected.network))
            continue;
        const resource = acc.resource || envelopeResource(pr) || selected.resource;
        return { ...acc, resource };
    }
    return null;
}
export function resourceBindLeafHash(req) {
    const amount = req.amount ?? req.maxAmountRequired ?? "";
    const payTo = req.payTo ?? req.pay_to ?? "";
    const raw = req.resource ?? "";
    const leaf = {
        amount_raw: amount, asset: req.asset ?? "", body_hash: ZERO_BODY_HASH,
        network: req.network ?? "", pay_to: payTo,
        requirements_hash: sha256(canonicalJson({
            amount, asset: req.asset ?? "", network: req.network ?? "",
            payTo, resource: req.resource ?? "", scheme: req.scheme ?? "",
        })),
        resource_url: raw ? canonicalResourceUrl(raw) : "", schema_version: 1,
    };
    return sha256(`${RESOURCE_BIND_DOMAIN}\n${canonicalJson(leaf)}`);
}
export function resourceBindMemo(leaf_hash) {
    const bytes = Buffer.from(leaf_hash, "hex");
    if (bytes.length !== 32)
        throw new Error("leaf_hash must be 32-byte hex");
    return `${RESOURCE_BIND_MEMO_PREFIX}${bytes.toString("base64url")}`;
}
export function memoContainsResourceBind(memo, leaf_hash) {
    return memo === resourceBindMemo(leaf_hash);
}
export function stampResourceBind(req, paymentRequired) {
    const cached = (req.resource && rawInvoiceByResource.get(req.resource))
        || rawInvoiceByResource.get(String(req.resource || ""));
    const hashSrc = rawReqFromPaymentRequired(cached ?? paymentRequired, req) ?? req;
    if (!hashSrc.resource && req.resource)
        hashSrc.resource = req.resource;
    if (!(hashSrc.payTo ?? hashSrc.pay_to) || !(hashSrc.amount ?? hashSrc.maxAmountRequired) || !hashSrc.resource) {
        return refuse("missing payTo/amount/resource");
    }
    let leaf_hash;
    try {
        leaf_hash = resourceBindLeafHash(hashSrc);
    }
    catch {
        return refuse("uncanonical resource URL");
    }
    return {
        strength: "soft", evidence_level: "client_stamped", fact_type: "resource_bound",
        leaf_hash, extra_stamped: false,
        reason: "bind hash local; seller extra not mutated (ExactSvm interop)",
    };
}
export function evaluateResourceBind(obs) {
    if (obs.body_hash && obs.body_hash !== ZERO_BODY_HASH) {
        return refuse("v1 forbids nonzero body_hash", obs.leaf_hash);
    }
    const hard = !!obs.tx_contains_hash ||
        (!!obs.tx_memo && memoContainsResourceBind(obs.tx_memo, obs.leaf_hash));
    return {
        strength: hard ? "hard" : "soft",
        evidence_level: hard ? "tx_included" : "client_stamped",
        fact_type: "resource_bound", leaf_hash: obs.leaf_hash,
        extra_stamped: !!obs.extra_stamped,
        reason: hard
            ? "memo inclusion only; transfer legs NOT verified at this seat"
            : "client stamped; tx not verified",
    };
}
//# sourceMappingURL=resource-bind.js.map