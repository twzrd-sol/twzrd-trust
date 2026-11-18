const PUBLIC_CLUSTER_HOSTS = new Set([
    'api.mainnet-beta.solana.com',
    'api.devnet.solana.com',
    'api.testnet.solana.com',
]);
const BASE = 36, T_MIN = 1, T_MAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;
function adapt(delta, numPoints, first) {
    delta = first ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > ((BASE - T_MIN) * T_MAX) >> 1) {
        delta = Math.floor(delta / (BASE - T_MIN));
        k += BASE;
    }
    return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}
function digitValue(c) {
    if (c >= 0x30 && c <= 0x39)
        return c - 22;
    if (c >= 0x41 && c <= 0x5a)
        return c - 0x41;
    if (c >= 0x61 && c <= 0x7a)
        return c - 0x61;
    return -1;
}
function punycodeDecode(input) {
    const output = [];
    const basicEnd = input.lastIndexOf('-');
    for (let j = 0; j < Math.max(basicEnd, 0); j++) {
        const c = input.charCodeAt(j);
        if (c >= 0x80)
            return null;
        output.push(c);
    }
    let n = INITIAL_N, i = 0, bias = INITIAL_BIAS;
    for (let idx = basicEnd > 0 ? basicEnd + 1 : 0; idx < input.length;) {
        const oldi = i;
        for (let w = 1, k = BASE;; k += BASE) {
            if (idx >= input.length)
                return null;
            const digit = digitValue(input.charCodeAt(idx++));
            if (digit < 0 || digit > Math.floor((0x7fffffff - i) / w))
                return null;
            i += digit * w;
            const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
            if (digit < t)
                break;
            if (w > Math.floor(0x7fffffff / (BASE - t)))
                return null;
            w *= BASE - t;
        }
        bias = adapt(i - oldi, output.length + 1, oldi === 0);
        if (Math.floor(i / (output.length + 1)) > 0x7fffffff - n)
            return null;
        n += Math.floor(i / (output.length + 1));
        i %= output.length + 1;
        if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
            return null;
        output.splice(i++, 0, n);
    }
    return output;
}
function encodeDigit(d) {
    return String.fromCharCode(d < 26 ? d + 0x61 : d + 22);
}
function punycodeEncode(input) {
    let out = '';
    for (const c of input)
        if (c < 0x80)
            out += String.fromCharCode(c);
    const basic = out.length;
    let handled = basic;
    if (basic > 0)
        out += '-';
    let n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;
    while (handled < input.length) {
        let m = 0x7fffffff;
        for (const c of input)
            if (c >= n && c < m)
                m = c;
        delta += (m - n) * (handled + 1);
        n = m;
        for (const c of input) {
            if (c < n)
                delta++;
            if (c === n) {
                let q = delta;
                for (let k = BASE;; k += BASE) {
                    const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
                    if (q < t)
                        break;
                    out += encodeDigit(t + ((q - t) % (BASE - t)));
                    q = Math.floor((q - t) / (BASE - t));
                }
                out += encodeDigit(q);
                bias = adapt(delta, handled + 1, handled === basic);
                delta = 0;
                handled++;
            }
        }
        delta++;
        n++;
    }
    return out;
}
function validPunycodeHost(hostname) {
    for (const label of hostname.split('.')) {
        if (!/^xn--/i.test(label))
            continue;
        const lower = label.toLowerCase();
        const decoded = punycodeDecode(lower.slice(4));
        if (!decoded || !decoded.some((c) => c >= 0x80) || punycodeEncode(decoded) !== lower.slice(4))
            return false;
        const text = String.fromCodePoint(...decoded);
        if (text !== text.normalize('NFC') || text !== text.toLowerCase() || !/^[\p{L}\p{M}\p{N}-]+$/u.test(text))
            return false;
    }
    return true;
}
export function privateRpcUrl(value) {
    const candidate = value?.trim();
    if (!candidate)
        return '';
    try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol))
            return '';
        if (PUBLIC_CLUSTER_HOSTS.has(url.hostname.replace(/\.+$/, '')))
            return '';
        if (!validPunycodeHost(url.hostname))
            return '';
        if (decodeURIComponent(url.pathname).toLowerCase().split('/').includes('public'))
            return '';
        return candidate;
    }
    catch {
        return '';
    }
}
