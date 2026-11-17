/**
 * createTwzrdPolicyFetch under concurrent calls through ONE instance.
 * Each paid call must be booked on the ledger with its own amount, and a
 * cumulative ceiling must count payments that are still in flight.
 * Run: npx tsx --test test/policy-fetch-concurrent.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import { createTwzrdPolicyFetch, TwzrdPolicyAbortError } from "../src/policy-fetch.js";
import { createMemorySpendLedger } from "../src/policy-runtime.js";

const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DAY = 24 * 3_600_000;
const asFetch = (f: (input: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
  ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    f(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A seller whose price is the number in the path (`/paid/10000`), plus a free
 * `/free`. Unpaid requests wait until `barrier` of them have arrived, so every
 * concurrent call holds its 402 before any of them pays. `failPaid` makes a
 * paid request answer 500.
 */
function harness(opts: {
  barrier: number;
  policy: Record<string, string>;
  failPaid?: (url: string) => boolean;
  /** A paid request waits for this before the seller answers. */
  holdPaid?: Promise<void>;
}) {
  const state = { signs: 0, paid: [] as string[] };
  let waiting: Array<() => void> = [];
  let arrived = 0;
  const gate = () =>
    new Promise<void>((resolve) => {
      arrived += 1;
      waiting.push(resolve);
      if (arrived >= opts.barrier) {
        for (const go of waiting) go();
        waiting = [];
      }
    });
  const rawFetch = asFetch(async (url, init) => {
    if (url.endsWith("/free")) return json({ free: true });
    const amount = url.split("/").at(-1)!;
    if (new Headers(init?.headers).has("x-payment")) {
      await opts.holdPaid;
      if (opts.failPaid?.(url)) return json({ error: "upstream" }, 500);
      state.paid.push(amount);
      return json({ ok: true });
    }
    if (arrived < opts.barrier) await gate();
    return json({ accepts: [{ payTo: SELLER, amount, network: "solana", asset: USDC }] }, 402);
  });
  const ledger = createMemorySpendLedger();
  const pf = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner({ keyId: "concurrent-test" }),
    fetch: asFetch(async () => json({ wash_flagged: false, wash_confidence: "full" })),
    rawFetch,
    wrapPay: (guarded) => async (input, init) => {
      const r = await guarded(input, init);
      if (r.status !== 402) return r;
      state.signs += 1;
      return guarded(input, { ...init, headers: { ...(init?.headers ?? {}), "x-payment": "stub" } });
    },
    ledger,
    policy: opts.policy,
    topUrl: "https://origin.example/free",
    routeUrl: "https://origin.example/free",
    deliveryCapture: false,
  });
  const spent = (scope: string) => ledger.spentMicro(scope, DAY, Date.now());
  return { pf, state, spent };
}

test("two concurrent paid calls through one instance are both booked", async () => {
  const h = harness({ barrier: 2, policy: { dailyCeilingUsd: "1.00" } });
  const [a, b] = await Promise.all([h.pf("https://origin.example/paid/10000"), h.pf("https://origin.example/paid/10000")]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(h.state.paid.length, 2);
  assert.equal(h.spent("policy:global"), 20_000n, "both payments must count toward the daily ceiling");
  assert.equal(h.spent(`counterparty:${SELLER}`), 20_000n);
});

test("concurrent calls with different prices are each booked at their own amount", async () => {
  const h = harness({ barrier: 2, policy: { dailyCeilingUsd: "1.00" } });
  await Promise.all([h.pf("https://origin.example/paid/10000"), h.pf("https://origin.example/paid/40000")]);
  assert.equal(h.spent("policy:global"), 50_000n);
});

test("an unpaid request finishing in between does not drop a payment that is in flight", async () => {
  let release!: () => void;
  const holdPaid = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ barrier: 1, policy: { dailyCeilingUsd: "1.00" }, holdPaid });
  const paidCall = h.pf("https://origin.example/paid/10000");
  while (h.state.signs === 0) await new Promise((resolve) => setImmediate(resolve));
  // The payment is signed and waiting on the seller; a free request runs to completion meanwhile.
  assert.equal((await h.pf("https://origin.example/free")).status, 200);
  release();
  assert.equal((await paidCall).status, 200);
  assert.equal(h.spent("policy:global"), 10_000n);
});

test("a payer that calls the gated fetch outside the call's context is still booked", async () => {
  // The payer defers through a timer queue it created earlier, which loses the per-call context.
  const queue: Array<() => void> = [];
  const drain = setInterval(() => queue.splice(0).forEach((job) => job()), 1);
  const ledger = createMemorySpendLedger();
  const pf = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner({ keyId: "detached-test" }),
    fetch: asFetch(async () => json({ wash_flagged: false, wash_confidence: "full" })),
    rawFetch: asFetch(async (_url, init) =>
      new Headers(init?.headers).has("x-payment")
        ? json({ ok: true })
        : json({ accepts: [{ payTo: SELLER, amount: "10000", network: "solana", asset: USDC }] }, 402)),
    wrapPay: (guarded) => (input, init) =>
      new Promise<Response>((resolve, reject) => {
        queue.push(() => {
          guarded(input, init)
            .then((r) => (r.status === 402 ? guarded(input, { ...init, headers: { "x-payment": "stub" } }) : r))
            .then(resolve, reject);
        });
      }),
    ledger,
    policy: { dailyCeilingUsd: "0.015" },
    deliveryCapture: false,
  });
  try {
    assert.equal((await pf("https://origin.example/paid")).status, 200);
    assert.equal(ledger.spentMicro("policy:global", DAY, Date.now()), 10_000n);
    await assert.rejects(() => pf("https://origin.example/paid"), TwzrdPolicyAbortError);
  } finally {
    clearInterval(drain);
  }
});

test("a daily ceiling counts a payment that is still in flight", async () => {
  const h = harness({ barrier: 2, policy: { dailyCeilingUsd: "0.015" } });
  const results = await Promise.allSettled([
    h.pf("https://origin.example/paid/10000"),
    h.pf("https://origin.example/paid/10000"),
  ]);
  const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(refused.length, 1, "only one 0.01 payment fits under a 0.015 ceiling");
  assert.ok(refused[0].reason instanceof TwzrdPolicyAbortError);
  assert.ok(refused[0].reason.decision.reasonCodes.includes("POLICY_DAILY_CEILING"));
  assert.equal(h.state.signs, 1, "the second payment must not reach the signer");
  assert.equal(h.state.paid.length, 1);
  assert.equal(h.spent("policy:global"), 10_000n);
});

test("a payment that was sent stays booked when the seller answers an error", async () => {
  // The seller has the signed payment and can settle it whatever it answers,
  // so the amount counts against the ceiling and the next call is refused.
  const h = harness({ barrier: 1, policy: { dailyCeilingUsd: "0.015" }, failPaid: () => true });
  await assert.rejects(async () => {
    const r = await h.pf("https://origin.example/paid/10000");
    if (!r.ok) throw new Error(`status ${r.status}`);
  });
  assert.equal(h.spent("policy:global"), 10_000n, "a payment that left is booked");
  await assert.rejects(() => h.pf("https://origin.example/paid/10000"), TwzrdPolicyAbortError);
  assert.equal(h.state.signs, 1, "the second payment must not reach the signer");
});
