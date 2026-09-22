/**
 * Private-network / DNS-rebinding guard for URLs this process did not choose —
 * directory-listed hop candidates, in particular. Ranges and weird-hostname
 * detection are ported from the canonical `assertPublicHttpUrl` in
 * x402-render/x402-reader's src/ssrf.js (AGENTS.md: copied verbatim across
 * those sibling repos). Do not weaken the ranges here without updating there.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type ResolvedAddress = { address: string; family: number };
export type HostResolver = (
  hostname: string,
  options: { all: true },
) => Promise<ResolvedAddress[]>;

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
] as const) {
  BLOCKLIST.addSubnet(net, prefix, type);
}

const BAD_HOSTNAME = /^(localhost|metadata\.google\.internal)$|\.(local|localhost|internal|lan)$/i;

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

export function isBlockedIpAddress(addr: string): boolean {
  const a = stripBrackets(addr.toLowerCase());
  const unwrapped = a.startsWith("::ffff:") ? a.slice(7) : a;
  const version = isIP(unwrapped);
  if (!version) return true;
  return BLOCKLIST.check(unwrapped, version === 4 ? "ipv4" : "ipv6");
}

/** Decimal/hex/octal IP encodings and bare metadata-style names, without a DNS lookup. */
function isWeirdHostEncoding(host: string): boolean {
  if (BAD_HOSTNAME.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^\d+$/.test(host)) return Number(host) <= 0xffffffff;
  return /^[\d.]+$/.test(host) && !isIP(host);
}

/**
 * True when `url`'s host is a private/loopback/link-local literal, a weird
 * encoding of one, or resolves (via DNS) to one. Fails closed: an unparsable
 * URL or a failed lookup is treated as forbidden, never as allowed.
 */
export async function hasForbiddenResolution(
  url: string,
  resolve: HostResolver = dnsLookup,
): Promise<boolean> {
  let host: string;
  try {
    host = stripBrackets(new URL(url).hostname);
  } catch {
    return true;
  }
  if (isWeirdHostEncoding(host)) return true;
  if (isIP(host)) return isBlockedIpAddress(host);
  let records: ResolvedAddress[];
  try {
    records = await resolve(host, { all: true });
  } catch {
    return true;
  }
  return records.length === 0 || records.some((r) => isBlockedIpAddress(r.address));
}
