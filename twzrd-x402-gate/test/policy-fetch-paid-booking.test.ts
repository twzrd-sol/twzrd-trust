/**
 * createTwzrdPolicyFetch and createTwzrdPayingFetch: what is read, and what
 * is booked.
 *
 *  - A 402 whose PAYMENT-REQUIRED header the gate cannot read is not handed
 *    to the payer.
 *  - A payment is booked when the request carrying it is sent, whatever the
 *    seller answers.
 *  - The booking names the recipient the payment pays.
 *  - A payment that names an offer the gate did not clear is not sent.
 *  - A payment the ledger cannot record is not sent.
 *
 * Run: npx tsx --test test/policy-fetch-paid-booking.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import { createTwzrdPayingFetch, TwzrdWashAbortError } from "../src/paying-fetch.js";
import { createTwzrdPolicyFetch, TwzrdPolicyAbortError } from "../src/policy-fetch.js";
import { createMemorySpendLedger, type Mandate, type SpendLedger, type SpendPolicy } from "../src/policy-runtime.js";

const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const UNLISTED = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DAY = 24 * 3_600_000;
const URL_PAID = "https://origin.example/paid";

type Offer = { scheme: string; network: string; payTo: string; amount: string; asset: string };
const offer = (payTo: string, amount: string): Offer => ({ scheme: "exact", network: SOLANA, payTo, amount, asset: USDC });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const asFetch = (f: (input: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
  ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    f(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const cleanCard = asFetch(async () => json({ wash_flagged: false, wash_confidence: "full" }));

type Seller = {
  /** The accepts[] of the 402. */
  offers: () => Offer[];
  /** How the 402 carries them: in the body, in a canonical header, or in a header a strict reader refuses. */
  carry?: "body" | "header" | "header-unpadded" | "garbage";
  /** What the seller answers a request that carries a payment. */
  afterPay?: () => Response | Promise<Response>;
};

function world(seller: Seller, opts: {
  policy?: SpendPolicy;
  mandate?: Mandate;
  ledger?: SpendLedger;
  /** What the payer puts in the payment header for the offer it picked. */
  header?: (picked: Offer) => Record<string, string>;
  /** Which offer the payer pays. Default: the first, as the x402 client does. */
  pick?: (offers: Offer[]) => Offer;
} = {}) {
  const state = { signs: 0, delivered: [] as string[], unpaid: 0 };
  const ledger = opts.ledger ?? createMemorySpendLedger();
  const rawFetch = asFetch(async (_url, init) => {
    const h = new Headers(init?.headers);
    const paid = h.get("payment-signature") ?? h.get("x-payment");
    if (paid !== null) {
      state.delivered.push(paid);
      return seller.afterPay ? seller.afterPay() : json({ ok: true });
    }
    state.unpaid += 1;
    const body = { x402Version: 2, accepts: seller.offers() };
    if (seller.carry === "garbage") return new Response("not json", { status: 402 });
    if (seller.carry === "header" || seller.carry === "header-unpadded") {
      // Pad the JSON so its base64 ends in "=" and stripping it changes the text.
      let text = JSON.stringify(body);
      while (!Buffer.from(text, "utf8").toString("base64").endsWith("=")) text += " ";
      const canonical = Buffer.from(text, "utf8").toString("base64");
      const value = seller.carry === "header" ? canonical : canonical.replace(/=+$/, "");
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": value } });
    }
    return json(body, 402);
  });
  // A payer shaped like the x402 fetch client: it reads the 402 leniently
  // (atob takes unpadded base64), signs one offer, and retries once.
  const wrapPay = (guarded: typeof fetch): typeof fetch => (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const r = await guarded(input, init);
    if (r.status !== 402) return r;
    const hdr = r.headers.get("PAYMENT-REQUIRED");
    const parsed = hdr !== null ? JSON.parse(atob(hdr)) : await r.clone().json();
    const picked = (opts.pick ?? ((o: Offer[]) => o[0]))(parsed.accepts as Offer[]);
    state.signs += 1;
    const headers = opts.header?.(picked) ?? { "payment-signature": b64({ x402Version: 2, accepted: picked, payload: { sig: state.signs } }) };
    return guarded(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined ?? {}), ...headers } });
  }) as typeof fetch;
  const common = {
    fetch: cleanCard, rawFetch, wrapPay,
    // Fallback is opt-in since 0.27.0; on here, so "no fallback route" cases stay meaningful.
    fallbackEnabled: true, allowedFallbackHosts: ["origin.example"],
    topUrl: "https://origin.example/free", routeUrl: "https://origin.example/free",
    deliveryCapture: false,
  };
  const policyFetch = createTwzrdPolicyFetch({
    ...common, signer: createLocalDecisionSigner({ keyId: "paid-booking-test" }),
    ledger, policy: opts.policy, mandate: opts.mandate,
  });
  const payingFetch = createTwzrdPayingFetch(common);
  const spent = (scope: string) => ledger.spentMicro(scope, DAY, Date.now());
  return { policyFetch, payingFetch, state, spent, ledger };
}

/** Run `n` calls one after another and tally how each ended. */
async function run(f: typeof fetch, n: number): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    let key: string;
    try { key = String((await f(URL_PAID)).status); }
    catch (err) { key = err instanceof TwzrdPolicyAbortError ? err.decision.reasonCodes.join(",") : (err as Error).message; }
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

/* ---------- a 402 the gate cannot read ---------- */

test("policy fetch: a PAYMENT-REQUIRED header the gate cannot read is not handed to the payer", async () => {
  const w = world({ offers: () => [offer(SELLER, "900000")], carry: "header-unpadded" }, { policy: { maxAmountUsd: "0.01", dailyCeilingUsd: "0.05" } });
  await assert.rejects(() => w.policyFetch(URL_PAID), (err: unknown) => err instanceof TwzrdWashAbortError && /twzrd_payment_required_unreadable/.test(err.message));
  assert.equal(w.state.signs, 0, "nothing is signed for a challenge that was not checked");
  assert.equal(w.state.delivered.length, 0);
});

test("paying fetch: a PAYMENT-REQUIRED header the gate cannot read is not handed to the payer", async () => {
  const w = world({ offers: () => [offer(SELLER, "900000")], carry: "header-unpadded" });
  await assert.rejects(() => w.payingFetch(URL_PAID), (err: unknown) => err instanceof TwzrdWashAbortError && /twzrd_payment_required_unreadable/.test(err.message));
  assert.equal(w.state.signs, 0);
  assert.equal(w.state.delivered.length, 0);
});

// 0.26.0: a 402 with no header and a body that is not JSON was handed to the
// payer, which threw a plain error, and the paying fetch then treated the origin
// as dead and paid its fallback route (stress finding paying-unreadable-body-skips).
for (const seat of ["policyFetch", "payingFetch"] as const) {
  test(`${seat}: a 402 body that is not JSON refuses and does not go to the fallback route`, async () => {
    const w = world({ offers: () => [offer(SELLER, "10000")], carry: "garbage" }, { policy: { maxAmountUsd: "0.01", dailyCeilingUsd: "0.05" } });
    await assert.rejects(() => w[seat](URL_PAID), (err: unknown) => err instanceof TwzrdWashAbortError && /twzrd_payment_required_unreadable/.test(err.message));
    assert.equal(w.state.signs, 0);
    assert.equal(w.state.unpaid, 1, "only the first request was sent: no fallback route");
  });
}

test("control: the same challenge in a canonical header is checked and paid within the policy", async () => {
  const w = world({ offers: () => [offer(SELLER, "10000")], carry: "header" }, { policy: { maxAmountUsd: "0.01", dailyCeilingUsd: "0.05" } });
  assert.equal((await w.policyFetch(URL_PAID)).status, 200);
  assert.equal(w.state.signs, 1);
  assert.equal(w.spent("policy:global"), 10_000n);
});

/* ---------- booked when sent ---------- */

const CAPS = {
  policy: { maxAmountUsd: "0.01", dailyCeilingUsd: "0.03", newCounterpartyCap: { capUsd: "0.03", windowHours: 24 } } as SpendPolicy,
  mandate: { mandateId: "m1", monthlyCeilingUsd: "0.03" } as unknown as Mandate,
};

for (const [name, afterPay] of [
  ["answers 500", () => json({ error: "upstream" }, 500)],
  ["answers 402 again", () => json({ x402Version: 2, accepts: [offer(SELLER, "10000")] }, 402)],
  ["drops the connection", () => { throw new TypeError("fetch failed"); }],
] as Array<[string, () => Response]>) {
  test(`a seller that takes the payment and ${name} is still counted against every ceiling`, async () => {
    const w = world({ offers: () => [offer(SELLER, "10000")], afterPay }, CAPS);
    await run(w.policyFetch, 10);
    assert.equal(w.state.delivered.length, 3, "three 0.01 payments fit under 0.03; the fourth must not be signed");
    assert.equal(w.state.signs, 3);
    assert.equal(w.spent("policy:global"), 30_000n);
    assert.equal(w.spent("mandate:m1"), 30_000n);
    assert.equal(w.spent(`counterparty:${SELLER}`), 30_000n);
  });
}

test("a 402 that is never paid books nothing and holds nothing", async () => {
  // The payer declines: it returns the 402 without sending a payment.
  const ledger = createMemorySpendLedger();
  const declining = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner({ keyId: "paid-booking-test" }),
    fetch: cleanCard,
    rawFetch: asFetch(async () => json({ x402Version: 2, accepts: [offer(SELLER, "10000")] }, 402)),
    wrapPay: (guarded) => guarded,
    ledger, policy: { dailyCeilingUsd: "0.01" },
    topUrl: "https://origin.example/free", routeUrl: "https://origin.example/free", deliveryCapture: false,
  });
  for (let i = 0; i < 3; i += 1) assert.equal((await declining(URL_PAID)).status, 402);
  assert.equal(ledger.spentMicro("policy:global", DAY, Date.now()), 0n);
});

/* ---------- the booking names the recipient that was paid ---------- */

test("with two offers, the recipient the payment names is the one booked", async () => {
  let n = 0;
  const decoy = () => [OTHER, UNLISTED][n++ % 2];
  const w = world(
    { offers: () => [offer(SELLER, "10000"), offer(decoy(), "10001")] },
    { policy: { maxAmountUsd: "0.02", newCounterpartyCap: { capUsd: "0.03", windowHours: 24 } } },
  );
  const tally = await run(w.policyFetch, 8);
  assert.equal(w.state.delivered.length, 3, `the seller is paid three times, not ${w.state.delivered.length}: ${JSON.stringify(tally)}`);
  assert.equal(w.spent(`counterparty:${SELLER}`), 30_000n);
  assert.equal(w.spent(`counterparty:${OTHER}`), 0n, "an offer that was not paid is not booked");
});

test("a payment header the gate cannot read is booked against every recipient that was offered", async () => {
  const w = world(
    { offers: () => [offer(SELLER, "10000"), offer(OTHER, "10001")] },
    { policy: { maxAmountUsd: "0.02", dailyCeilingUsd: "1.00" }, header: () => ({ "x-payment": "opaque" }) },
  );
  assert.equal((await w.policyFetch(URL_PAID)).status, 200);
  assert.equal(w.spent("policy:global"), 10_001n, "the costliest offer, once");
  assert.equal(w.spent(`counterparty:${SELLER}`), 10_000n);
  assert.equal(w.spent(`counterparty:${OTHER}`), 10_001n);
});

test("a payment that names an offer the gate did not clear is not sent", async () => {
  const w = world(
    { offers: () => [offer(SELLER, "10000")] },
    { policy: { maxAmountUsd: "0.02", dailyCeilingUsd: "1.00" }, pick: () => offer(UNLISTED, "10000") },
  );
  await assert.rejects(() => w.policyFetch(URL_PAID), (err: unknown) => err instanceof TwzrdWashAbortError && /payment_differs_from_approval/.test(err.message));
  assert.equal(w.state.delivered.length, 0, "the request carrying the payment never leaves");
  assert.equal(w.spent("policy:global"), 0n);
});

/* ---------- a payment the ledger cannot record ---------- */

test("when the ledger cannot record a payment, the payment is not sent", async () => {
  const inner = createMemorySpendLedger();
  let broken = false;
  const ledger: SpendLedger = {
    ...inner,
    spentMicro: (s, w, n) => inner.spentMicro(s, w, n),
    firstSeen: (s) => inner.firstSeen(s),
    record: (s, m, a) => { if (broken) throw new Error("EACCES: ledger not writable"); inner.record(s, m, a); },
  };
  const w = world({ offers: () => [offer(SELLER, "10000")] }, { policy: { dailyCeilingUsd: "0.03" }, ledger });
  assert.equal((await w.policyFetch(URL_PAID)).status, 200);
  broken = true;
  const tally = await run(w.policyFetch, 5);
  assert.deepEqual(tally, { spend_ledger_unavailable: 5 }, "an abort, not a dead origin to route around");
  assert.equal(w.state.delivered.length, 1, "no payment leaves while the ledger cannot count it");
});
