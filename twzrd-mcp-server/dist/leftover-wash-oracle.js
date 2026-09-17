export const LEFTOVER_DEFAULT_UNIT_PRICE_USDC = 0.05;
export const PRICE_KIND_EXACT = "exact";
export const PRICE_KIND_UPTO_CAP = "upto_cap";
export const PRICE_KIND_UNKNOWN = "unknown";
export const WASH_REFUSE_REASON = "twzrd_wash_flagged";
const UPTO_CAP_CAVEAT = /upto\s+\$?[0-9].*cap/i;
export function asFiniteNumber(value) {
    if (typeof value === "boolean")
        return null;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return null;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function collectText(source) {
    const bits = [];
    for (const key of ["caveats", "evidence"]) {
        const val = source[key];
        if (Array.isArray(val))
            bits.push(...val.map((x) => String(x)));
        else if (typeof val === "string")
            bits.push(val);
    }
    return bits.join(" ");
}
function formatUsdc(n) {
    return String(n);
}
export function isUnlabeledLeftoverUnitPrice(price, opts) {
    const n = asFiniteNumber(price);
    if (n === null)
        return false;
    const kind = typeof opts?.price_kind === "string" ? opts.price_kind.trim().toLowerCase() : "";
    const scheme = typeof opts?.scheme === "string" ? opts.scheme.trim().toLowerCase() : "";
    if (kind === PRICE_KIND_EXACT || scheme === "exact")
        return false;
    if (Math.abs(n) <= 1e-12)
        return true;
    if (opts?.caller_supplied)
        return false;
    return Math.abs(n - LEFTOVER_DEFAULT_UNIT_PRICE_USDC) <= 1e-12;
}
export function isUptoCap(source) {
    const data = asRecord(source);
    const catalog = asRecord(data.service_catalog);
    const readiness = asRecord(data.readiness_card);
    for (const row of [data, catalog, readiness, asRecord(readiness.service_catalog)]) {
        const kind = String(row.price_kind ?? "").trim().toLowerCase();
        const scheme = String(row.scheme ?? "").trim().toLowerCase();
        if (kind === PRICE_KIND_UPTO_CAP || scheme === "upto")
            return true;
        if (UPTO_CAP_CAVEAT.test(collectText(row)))
            return true;
    }
    return false;
}
export function quotedUnitPriceFromOracle(source, caller) {
    const hasCaller = !!caller &&
        typeof caller === "object" &&
        Object.prototype.hasOwnProperty.call(caller, "price_usdc");
    if (hasCaller) {
        const fromCaller = asFiniteNumber(caller.price_usdc);
        if (fromCaller !== null &&
            !isUnlabeledLeftoverUnitPrice(fromCaller, { caller_supplied: true })) {
            return fromCaller;
        }
    }
    const data = asRecord(source);
    const readiness = asRecord(data.readiness_card);
    const catalog = {
        ...asRecord(readiness.service_catalog),
        ...asRecord(data.service_catalog),
    };
    const merged = { ...catalog, ...readiness, ...data };
    if (isUptoCap(merged))
        return null;
    const raw = merged.price_usdc;
    if (isUnlabeledLeftoverUnitPrice(raw, {
        price_kind: merged.price_kind,
        scheme: merged.scheme,
    })) {
        return null;
    }
    return asFiniteNumber(raw);
}
export function washRefuseVerdict(input) {
    const refuseWash = input.refuseWashFlagged !== false;
    if (!refuseWash)
        return { refuse: false, wash_capped: false, reason: null };
    if (input.wash_flagged !== true)
        return { refuse: false, wash_capped: false, reason: null };
    const cap = typeof input.washMaxUsdc === "number" && Number.isFinite(input.washMaxUsdc)
        ? input.washMaxUsdc
        : null;
    const price = typeof input.unit_price_usdc === "number" && Number.isFinite(input.unit_price_usdc)
        ? input.unit_price_usdc
        : null;
    if (cap != null && price != null && price <= cap) {
        return {
            refuse: false,
            wash_capped: true,
            reason: `twzrd_wash_capped_${formatUsdc(price)}_le_${formatUsdc(cap)}`,
        };
    }
    if (cap != null) {
        return {
            refuse: true,
            wash_capped: false,
            reason: price == null
                ? `twzrd_wash_flagged_above_cap_unknown_price_max_${formatUsdc(cap)}`
                : `twzrd_wash_flagged_above_cap_${formatUsdc(price)}_gt_${formatUsdc(cap)}`,
        };
    }
    return { refuse: true, wash_capped: false, reason: WASH_REFUSE_REASON };
}
export function leftoverWashOracle(input = {}) {
    const caller = input.caller_price_usdc !== undefined ? { price_usdc: input.caller_price_usdc } : null;
    const unit = quotedUnitPriceFromOracle(input, caller);
    const leftover = isUnlabeledLeftoverUnitPrice(input.price_usdc, {
        price_kind: input.price_kind,
        scheme: input.scheme,
    });
    const wash = washRefuseVerdict({
        wash_flagged: input.wash_flagged,
        unit_price_usdc: unit,
        washMaxUsdc: input.washMaxUsdc,
        refuseWashFlagged: input.refuseWashFlagged,
    });
    return {
        unit_price_usdc: unit,
        leftover,
        wash_refuse: wash.refuse,
        wash_capped: wash.wash_capped,
        reason: wash.reason,
    };
}
