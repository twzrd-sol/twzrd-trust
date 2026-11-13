/**
 * Private-network / DNS-rebinding guard for URLs this process did not choose —
 * directory-listed hop candidates, in particular. Ranges and weird-hostname
 * detection are ported from the canonical `assertPublicHttpUrl` in
 * x402-render/x402-reader's src/ssrf.js (AGENTS.md: copied verbatim across
 * those sibling repos). Do not weaken the ranges here without updating there.
 */
import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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
 * The addresses `url`'s host may be reached at, or null when it must not be
 * reached: a private/loopback/link-local literal, a weird encoding of one, or
 * a name with any such address among its DNS answers. Fails closed: an
 * unparsable URL or a failed lookup is null, never an allowed address.
 *
 * A public IP literal comes back as itself. The caller connects to what this
 * returns (createPinnedFetch) and to nothing else: checking a name and then
 * handing it to an ordinary fetch resolves it a second time, and the second
 * answer is not the one that was checked.
 */
export async function resolvePublicAddresses(
  url: string,
  resolve: HostResolver = dnsLookup,
): Promise<ResolvedAddress[] | null> {
  let host: string;
  try {
    host = stripBrackets(new URL(url).hostname);
  } catch {
    return null;
  }
  if (isWeirdHostEncoding(host)) return null;
  const literal = isIP(host);
  if (literal) return isBlockedIpAddress(host) ? null : [{ address: host, family: literal }];
  let records: ResolvedAddress[];
  try {
    records = await resolve(host, { all: true });
  } catch {
    return null;
  }
  if (records.length === 0 || records.some((r) => isBlockedIpAddress(r.address))) return null;
  return records.map((r) => ({ address: r.address, family: isIP(r.address) }));
}

/**
 * True when `url`'s host is a private/loopback/link-local literal, a weird
 * encoding of one, or resolves (via DNS) to one. Fails closed: an unparsable
 * URL or a failed lookup is treated as forbidden, never as allowed.
 *
 * This is a check only. To fetch the URL afterwards use resolvePublicAddresses
 * with createPinnedFetch, so the connection goes to the addresses checked.
 */
export async function hasForbiddenResolution(
  url: string,
  resolve: HostResolver = dnsLookup,
): Promise<boolean> {
  return (await resolvePublicAddresses(url, resolve)) === null;
}

/**
 * A `lookup` for a net/tls connection that answers only from `addresses`. DNS
 * is not asked, so the connection cannot be sent anywhere else, whatever the
 * name resolves to by the time the socket opens.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    const family = options.family === 4 || options.family === "IPv4" ? 4
      : options.family === 6 || options.family === "IPv6" ? 6
      : 0;
    const usable = addresses.filter((a) => family === 0 || a.family === family);
    // Asynchronous like dns.lookup: net attaches its listeners after the call.
    process.nextTick(() => {
      if (usable.length === 0) {
        const error = Object.assign(new Error(`no checked address for ${hostname}`), {
          code: "ENOTFOUND",
          hostname,
        });
        callback(error, options.all ? [] : "", undefined);
        return;
      }
      if (options.all) {
        callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        return;
      }
      callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

/** A probe answer is a 402 body or an error page; anything larger is refused. */
const PINNED_MAX_BODY_BYTES = 1024 * 1024;

/**
 * A fetch for one GET to a third-party URL whose host was checked with
 * resolvePublicAddresses: the connection is opened to `addresses` and nowhere
 * else. The URL keeps its hostname, so the Host header, TLS SNI and
 * certificate check are the ordinary ones.
 *
 * Narrow on purpose: GET or HEAD, no request body, no redirect is ever
 * followed (a 3xx comes back as the 3xx), no connection reuse, and a response
 * body over 1 MiB is an error. `init.headers` and `init.signal` are honoured.
 */
export function createPinnedFetch(addresses: readonly ResolvedAddress[]): typeof fetch {
  const lookup = pinnedLookup(addresses);
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if ((method !== "GET" && method !== "HEAD") || (init?.body !== undefined && init.body !== null)) {
        reject(new TypeError("pinned fetch sends GET or HEAD with no body"));
        return;
      }
      let url: URL;
      try {
        url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      } catch (error) {
        reject(error);
        return;
      }
      const request = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : undefined;
      if (!request) {
        reject(new TypeError(`pinned fetch does not speak ${url.protocol}`));
        return;
      }
      // The body is read as sent: ask for no content coding.
      const headers: Record<string, string> = { "accept-encoding": "identity" };
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const req = request(
        url,
        { method, headers, lookup, agent: false, ...(init?.signal ? { signal: init.signal } : {}) },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > PINNED_MAX_BODY_BYTES) {
              req.destroy(new Error("response body over the pinned fetch limit"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            // Status line and headers are the remote's: a value Response will
            // not take is a failed fetch, not an exception in this handler.
            try {
              const status = res.statusCode ?? 0;
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(res.headers)) {
                if (Array.isArray(value)) for (const v of value) responseHeaders.append(name, v);
                else if (typeof value === "string") responseHeaders.set(name, value);
              }
              const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
              resolve(new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), {
                status,
                headers: responseHeaders,
              }));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    })) as typeof fetch;
}
