import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
const BLOCKLIST = new BlockList();
for (const [net, prefix, type] of [
    ["0.0.0.0", 8, "ipv4"],
    ["10.0.0.0", 8, "ipv4"],
    ["127.0.0.0", 8, "ipv4"],
    ["169.254.0.0", 16, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["100.64.0.0", 10, "ipv4"],
    ["::1", 128, "ipv6"],
    ["::", 128, "ipv6"],
    ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"],
]) {
    BLOCKLIST.addSubnet(net, prefix, type);
}
const BAD_HOSTNAME = /^(localhost|metadata\.google\.internal)$|\.(local|localhost|internal|lan)$/i;
function stripBrackets(host) {
    return host.replace(/^\[/, "").replace(/\]$/, "");
}
export function isBlockedIpAddress(addr) {
    const a = stripBrackets(addr.toLowerCase());
    const unwrapped = a.startsWith("::ffff:") ? a.slice(7) : a;
    const version = isIP(unwrapped);
    if (!version)
        return true;
    return BLOCKLIST.check(unwrapped, version === 4 ? "ipv4" : "ipv6");
}
function isWeirdHostEncoding(host) {
    if (BAD_HOSTNAME.test(host) || /^0x[0-9a-f]+$/i.test(host))
        return true;
    if (/^\d+$/.test(host))
        return Number(host) <= 0xffffffff;
    return /^[\d.]+$/.test(host) && !isIP(host);
}
export async function resolvePublicAddresses(url, resolve = dnsLookup) {
    let host;
    try {
        host = stripBrackets(new URL(url).hostname);
    }
    catch {
        return null;
    }
    if (isWeirdHostEncoding(host))
        return null;
    const literal = isIP(host);
    if (literal)
        return isBlockedIpAddress(host) ? null : [{ address: host, family: literal }];
    let records;
    try {
        records = await resolve(host, { all: true });
    }
    catch {
        return null;
    }
    if (records.length === 0 || records.some((r) => isBlockedIpAddress(r.address)))
        return null;
    return records.map((r) => ({ address: r.address, family: isIP(r.address) }));
}
export async function hasForbiddenResolution(url, resolve = dnsLookup) {
    return (await resolvePublicAddresses(url, resolve)) === null;
}
