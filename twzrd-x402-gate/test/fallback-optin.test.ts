/**
 * Fallback routing is opt-in and host-allowlisted (0.27.0).
 *
 * Through 0.26.0 any payment failure that was not a wash, policy, halt or
 * abort refusal peeked https://outbid.sh/top, paid https://outbid.sh/route and
 * then paid whatever `url` that route answered with, forwarding the route's
 * headers. On by default, with no allowlist: whoever held the board's top slot
 * chose where every client's failed fetch was paid again.
 *
 * Run: npx tsx --test test/fallback-optin.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTwzrdPayingFetch, type CreateTwzrdPayingFetchInput } from "../src/paying-fetch.js";

const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const ORIGIN = "https://origin.example/paid";
const TOP = "https://router.example/top";
const ROUTE = "https://router.example/route";
const HOP = "https://hop.example/item";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invoice = () => json({ accepts: [{ payTo: CLEAN, amount: "10000", network: "solana" }] }, 402);
const cleanCard = (async () => json({ wash_flagged: false, wash_confidence: "full" })) as unknown as typeof fetch;

type Harness = {
  pay: typeof fetch;
  seen: string[];
  peeks: string[];
  hopHeaders: Headers | undefined;
};

/**
 * The origin's fetch fails like a dead host. The route answers `routeBody`.
 * Every URL handed to the payer and to the peek is recorded.
 */
function harness(extra: Partial<CreateTwzrdPayingFetchInput>, routeBody: unknown = { url: HOP }): Harness {
  const h: Harness = { pay: undefined as unknown as typeof fetch, seen: [], peeks: [], hopHeaders: undefined };
  const rawFetch = (async (input: unknown) => {
    const u = String(input);
    if (u.startsWith(ORIGIN)) throw new TypeError("fetch failed");
    if (u.startsWith(ROUTE)) return invoice();
    return json({ ok: true, at: u });
  }) as unknown as typeof fetch;
  const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
    const u = String(input);
    h.seen.push(u);
    if (u === HOP || u.startsWith("https://hop.example")) h.hopHeaders = new Headers(init?.headers);
    const r = await g(input, init);
    if (r.status !== 402) return r;
    return u.startsWith(ROUTE) ? json(routeBody) : new Response("paid", { status: 200 });
  };
  const peekFetch = (async (input: unknown) => {
    h.peeks.push(String(input));
    return json({});
  }) as unknown as typeof fetch;
  h.pay = createTwzrdPayingFetch({
    fetch: cleanCard, rawFetch, wrapPay, peekFetch, deliveryCapture: false, ...extra,
  });
  return h;
}

const ENABLED = {
  fallbackEnabled: true,
  allowedFallbackHosts: ["router.example", "hop.example"],
  topUrl: TOP,
  routeUrl: ROUTE,
} as const;

test("default: a failed payment rethrows the original error and fetches no fallback", async () => {
  const h = harness({});
  await assert.rejects(h.pay(ORIGIN), (err: unknown) => err instanceof TypeError && (err as Error).message === "fetch failed");
  assert.deepEqual(h.seen, [ORIGIN]);
  assert.deepEqual(h.peeks, []);
  assert.equal(h.seen.some((u) => u.includes("/top") || u.includes("/route") || u.includes("outbid.sh")), false);
});

test("default ignores topUrl and routeUrl: they are not an opt-in", async () => {
  const h = harness({ topUrl: TOP, routeUrl: ROUTE, allowedFallbackHosts: ["router.example", "hop.example"] });
  await assert.rejects(h.pay(ORIGIN), /fetch failed/);
  assert.deepEqual(h.seen, [ORIGIN]);
  assert.deepEqual(h.peeks, []);
});

test("fallbackEnabled: false behaves like the default", async () => {
  const h = harness({ ...ENABLED, fallbackEnabled: false });
  await assert.rejects(h.pay(ORIGIN), /fetch failed/);
  assert.deepEqual(h.seen, [ORIGIN]);
  assert.deepEqual(h.peeks, []);
});

test("enabled without a usable allowlist throws at construction", () => {
  const bad: Array<Partial<CreateTwzrdPayingFetchInput>> = [
    { fallbackEnabled: true, routeUrl: ROUTE },
    { fallbackEnabled: true, routeUrl: ROUTE, allowedFallbackHosts: [] },
    { fallbackEnabled: true, routeUrl: ROUTE, allowedFallbackHosts: ["router.example", ""] },
    { fallbackEnabled: true, routeUrl: ROUTE, allowedFallbackHosts: ["  "] },
    { fallbackEnabled: true, routeUrl: ROUTE, allowedFallbackHosts: [42 as unknown as string] },
    { fallbackEnabled: true, routeUrl: ROUTE, allowedFallbackHosts: "router.example" as unknown as readonly string[] },
  ];
  for (const opts of bad) {
    assert.throws(() => harness(opts), (err: unknown) => err instanceof TypeError && /allowedFallbackHosts/.test((err as Error).message), JSON.stringify(opts));
  }
});

test("enabled with a bad routeUrl or topUrl throws at construction", () => {
  const hosts = ["router.example", "hop.example"];
  const cases: Array<[Partial<CreateTwzrdPayingFetchInput>, RegExp]> = [
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts }, /needs routeUrl/],
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts, routeUrl: "http://router.example/route" }, /routeUrl is not https/],
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts, routeUrl: "https://outbid.sh/route" }, /routeUrl host outbid\.sh is not in allowedFallbackHosts/],
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts, routeUrl: "not a url" }, /routeUrl does not parse/],
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts, routeUrl: "https://u:p@router.example/route" }, /routeUrl carries userinfo/],
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts, routeUrl: ROUTE, topUrl: "http://router.example/top" }, /topUrl is not https/],
    [{ fallbackEnabled: true, allowedFallbackHosts: hosts, routeUrl: ROUTE, topUrl: "https://outbid.sh/top" }, /topUrl host outbid\.sh/],
  ];
  for (const [opts, re] of cases) {
    assert.throws(() => harness(opts), (err: unknown) => err instanceof TypeError && re.test((err as Error).message), JSON.stringify(opts));
  }
});

test("enabled with an allowlist pays an allowlisted route url", async () => {
  const h = harness(ENABLED);
  const r = await h.pay(ORIGIN);
  assert.equal(r.status, 200);
  assert.deepEqual(h.peeks, [TOP]);
  assert.deepEqual(h.seen, [ORIGIN, ROUTE, HOP]);
});

test("host matching is case-insensitive and exact; topUrl is optional", async () => {
  const h = harness({ fallbackEnabled: true, allowedFallbackHosts: ["Router.Example", "HOP.example"], routeUrl: ROUTE }, { url: "https://HOP.EXAMPLE/item" });
  assert.equal((await h.pay(ORIGIN)).status, 200);
  assert.deepEqual(h.peeks, []);
  assert.equal(h.seen.length, 3);
  assert.equal(new URL(h.seen[2]!).hostname, "hop.example");

  const sub = harness(ENABLED, { url: "https://evil.hop.example/item" });
  await assert.rejects(sub.pay(ORIGIN), /fallback route url refused: host evil\.hop\.example/);
  assert.deepEqual(sub.seen, [ORIGIN, ROUTE]);
});

for (const [name, url, re] of [
  ["a host outside the allowlist", "https://attacker.example/drain", /host attacker\.example is not in allowedFallbackHosts/],
  ["an http: url", "http://hop.example/item", /is not https/],
  ["a url with userinfo", "https://user:pw@hop.example/item", /carries userinfo/],
  ["a url that does not parse", "::nope::", /does not parse/],
] as const) {
  test(`enabled refuses ${name} named by the route and never pays it`, async () => {
    const h = harness(ENABLED, { url });
    await assert.rejects(h.pay(ORIGIN), re);
    assert.deepEqual(h.seen, [ORIGIN, ROUTE]);
    assert.equal(h.hopHeaders, undefined);
  });
}

test("a route answer with no url is refused", async () => {
  const h = harness(ENABLED, { nope: true });
  await assert.rejects(h.pay(ORIGIN), /fallback route answer has no url/);
  assert.deepEqual(h.seen, [ORIGIN, ROUTE]);
});

test("sensitive headers never reach the fallback hop", async () => {
  const h = harness(ENABLED, {
    url: HOP,
    forward_headers: {
      "X-Outbid-Rank": "1",
      Authorization: "Bearer route",
      Cookie: "sid=route",
      "Proxy-Authorization": "Basic route",
      "X-Payment": "route",
      "Payment-Signature": "route",
      Payment: "route",
      Host: "attacker.example",
    },
  });
  const r = await h.pay(ORIGIN, {
    headers: {
      Authorization: "Bearer caller",
      Cookie: "sid=caller",
      "Proxy-Authorization": "Basic caller",
      "X-Payment": "caller",
      "Payment-Signature": "caller",
      Payment: "caller",
      "X-Caller-Trace": "keep-me",
    },
  });
  assert.equal(r.status, 200);
  const got = h.hopHeaders!;
  for (const name of ["authorization", "cookie", "proxy-authorization", "x-payment", "payment-signature", "payment", "host"]) {
    assert.equal(got.get(name), null, name);
  }
  assert.equal(got.get("x-outbid-rank"), "1");
  assert.equal(got.get("x-caller-trace"), "keep-me");
});
