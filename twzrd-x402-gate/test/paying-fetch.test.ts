import assert from "node:assert/strict";
import { DELIVERY_OBSERVATION_PATH } from "../src/delivery-capture.js";
import { createTwzrdPayingFetch, TwzrdWashAbortError } from "../src/paying-fetch.js";
import {
  rawInvoiceByResource, resourceBindLeafHash, stampResourceBind,
} from "../src/resource-bind.js";

const WASH = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const CLEAN = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const ORIGIN = "https://origin.example/paid";
const TOP = "https://outbid.sh/top";
const ROUTE = "https://outbid.sh/route";
const HOP = "https://fallback.example/";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invoice = (payTo: string) =>
  json({ accepts: [{ payTo, amount: "10000", network: "solana" }] }, 402);
const asFetch = (fn: typeof fetch) => fn as unknown as typeof fetch;
const card = (flag: boolean | "down") =>
  asFetch(async () =>
    flag === "down"
      ? Promise.reject(new Error("down"))
      : json({
          wash_flagged: flag,
          ...(typeof flag === "boolean" ? { wash_confidence: "full" } : {}),
        }),
  );

async function run() {
  const seen: string[] = [];
  let hopAuth: string | null = null;
  let hopRank: string | null = null;
  const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
    const u = String(input);
    seen.push(u);
    if (u === HOP) {
      const h = new Headers(init?.headers);
      hopAuth = h.get("authorization");
      hopRank = h.get("x-outbid-rank");
    }
    const r = await g(input, init);
    if (r.status !== 402) return r;
    return u.includes("/route")
      ? json({ url: HOP, forward_headers: { "X-Outbid-Rank": "1", Authorization: "nope" } })
      : new Response("paid", { status: 200 });
  };
  const mk = (raw: typeof fetch, intel: boolean | "down", extra?: object) =>
    createTwzrdPayingFetch({ fetch: card(intel), rawFetch: raw, wrapPay, ...extra });

  await assert.rejects(() => mk(asFetch(async () => invoice(WASH)), true)(ORIGIN), TwzrdWashAbortError);
  assert.equal(seen.some((u) => u.includes("/route")), false);

  seen.length = 0;
  await assert.rejects(
    () => mk(asFetch(async () => invoice(CLEAN)), "down")(ORIGIN),
    (err: unknown) =>
      err instanceof TwzrdWashAbortError &&
      /twzrd_card_unreachable_fail_closed/.test((err as Error).message),
  );
  assert.equal(seen.includes(ROUTE), false);

  seen.length = 0;
  assert.equal(
    (await mk(asFetch(async () => invoice(CLEAN)), "down", { failOpen: true })(ORIGIN)).status,
    200,
  );
  assert.equal(seen.includes(ROUTE), false);

  seen.length = 0;
  const peeks: string[] = [];
  const r = await mk(
    asFetch(async (input) => {
      const u = String(input);
      if (u.startsWith(ORIGIN)) throw new TypeError("fetch failed");
      return u === ROUTE ? invoice(CLEAN) : json({ ok: true });
    }),
    false,
    { peekFetch: asFetch(async (i) => { peeks.push(String(i)); return json({}); }) },
  )(ORIGIN, { headers: { Authorization: "secret" } });
  assert.equal(r.status, 200);
  assert.deepEqual(peeks, [TOP]);
  assert.ok(seen.includes(ROUTE) && seen.includes(HOP));
  assert.equal(hopAuth, null);
  assert.equal(hopRank, "1");

  seen.length = 0;
  assert.equal((await mk(asFetch(async () => new Response("gone", { status: 404 })), false)(ORIGIN)).status, 404);
  assert.equal(seen.includes(ROUTE), false);

  rawInvoiceByResource.clear();
  const v1acc = {
    scheme: "exact", payTo: CLEAN, amount: "10000", maxAmountRequired: "10000",
    network: "solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", resource: ORIGIN,
  };
  assert.equal((await mk(asFetch(async () => json({ x402Version: 1, accepts: [v1acc] }, 402)), false)(ORIGIN)).status, 200);
  assert.ok(rawInvoiceByResource.get(ORIGIN));
  const rawLeaf = resourceBindLeafHash({ ...v1acc, amount: "10000" });
  const stamped = stampResourceBind({
    payTo: CLEAN, amount: "10000", asset: v1acc.asset, scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", resource: ORIGIN,
  }, { x402Version: 2, accepts: [{ payTo: CLEAN, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] });
  assert.equal(stamped.leaf_hash, rawLeaf);

  const obsPosts: Array<{ url: string; method: string; body: unknown }> = [];
  const intelWithObs = (flag: boolean | "down", mode: "ok" | "throw" = "ok") =>
    asFetch(async (input, init) => {
      const u = String(input);
      if (u.includes(DELIVERY_OBSERVATION_PATH)) {
        if (mode === "throw") throw new Error("collector down");
        obsPosts.push({
          url: u,
          method: String(init?.method ?? "GET"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        });
        return json({ ok: true });
      }
      return card(flag)(input, init);
    });
  const mkObs = (raw: typeof fetch, intel: boolean | "down", extra?: object, mode: "ok" | "throw" = "ok") =>
    createTwzrdPayingFetch({ fetch: intelWithObs(intel, mode), rawFetch: raw, wrapPay, ...extra });

  obsPosts.length = 0;
  const paid = await mkObs(asFetch(async () => invoice(CLEAN)), false)(ORIGIN);
  assert.equal(paid.status, 200);
  assert.equal(obsPosts.length, 1);
  assert.equal(obsPosts[0]!.method, "POST");
  assert.ok(obsPosts[0]!.url.includes(DELIVERY_OBSERVATION_PATH));
  assert.equal((obsPosts[0]!.body as { merchant_wallet?: string }).merchant_wallet, CLEAN);
  assert.equal((obsPosts[0]!.body as { http_status?: number }).http_status, 200);
  assert.equal((obsPosts[0]!.body as { source?: string }).source, "gate_post_settle");

  obsPosts.length = 0;
  const stillPaid = await mkObs(asFetch(async () => invoice(CLEAN)), false, {}, "throw")(ORIGIN);
  assert.equal(stillPaid.status, 200);
  assert.equal(obsPosts.length, 0);

  obsPosts.length = 0;
  const skipped = await mkObs(asFetch(async () => invoice(CLEAN)), false, { deliveryCapture: false })(ORIGIN);
  assert.equal(skipped.status, 200);
  assert.equal(obsPosts.length, 0);

  obsPosts.length = 0;
  const prev = process.env.TWZRD_DELIVERY_CAPTURE;
  process.env.TWZRD_DELIVERY_CAPTURE = "0";
  try {
    const envOff = await mkObs(asFetch(async () => invoice(CLEAN)), false)(ORIGIN);
    assert.equal(envOff.status, 200);
    assert.equal(obsPosts.length, 0);
  } finally {
    if (prev === undefined) delete process.env.TWZRD_DELIVERY_CAPTURE;
    else process.env.TWZRD_DELIVERY_CAPTURE = prev;
  }

  {
    const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const headerBody = {
      x402Version: 2,
      accepts: [{ payTo: CLEAN, amount: "10000", network: "solana" }],
      extensions: { twzrd_attempt: { schema: "twzrd.attempt.v1", attempt_key: KEY } },
    };
    let seenSig: string | null = null;
    const raw = asFetch(async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const sig = req.headers.get("PAYMENT-SIGNATURE");
      if (sig) {
        seenSig = sig;
        return new Response("paid", { status: 200 });
      }
      return new Response("{}", {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(headerBody)).toString("base64"),
        },
      });
    });
    const wrapPay = (g: typeof fetch): typeof fetch => async (input, init) => {
      const r = await g(input, init);
      if (r.status !== 402) return r;
      return g(input, {
        headers: {
          "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64"),
        },
      });
    };
    assert.equal(
      (await createTwzrdPayingFetch({ fetch: card(false), rawFetch: raw, wrapPay })(ORIGIN)).status,
      200,
    );
    assert.ok(seenSig);
    const payload = JSON.parse(Buffer.from(seenSig, "base64").toString("utf8")) as {
      extensions: { twzrd_attempt: { attempt_key: string } };
    };
    assert.equal(payload.extensions.twzrd_attempt.attempt_key, KEY);
  }

  console.log("paying-fetch.test.ts: ok");
}

run().catch((e) => { console.error(e); process.exit(1); });
