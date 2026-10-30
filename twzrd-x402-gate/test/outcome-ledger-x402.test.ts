import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";
import { tempDir } from "./helpers/tmpdir.js";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";
import { createFileOutcomeLedger, createMemoryOutcomeLedger } from "../src/outcome-ledger.js";
import { MAX_APPROVAL_TTL_MS, MERCHANT_REPORTED_SETTLEMENT, MIN_APPROVAL_TTL_MS, UNRESOLVED_OPERATION_REASON, X402_PAID_RESPONSE_RULE_V1, createOutcomeLedgerX402Binding, operationKeyOf, x402AttemptIntentHash } from "../src/outcome-ledger-x402.js";

const BASE = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x00000000000000000000000000000000000000a1";
const TX = "0x" + "ab".repeat(32);
const RESOURCE = "https://data.example/v1/dataset?id=7";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const requirement = { scheme: "exact", network: BASE, asset: USDC_BASE, amount: "40000", payTo: SELLER, maxTimeoutSeconds: 600, extra: {} };
const challenge = { x402Version: 2, resource: { url: RESOURCE }, accepts: [requirement] };
const settledOk = b64({ success: true, transaction: TX, network: BASE, payer: "0x00000000000000000000000000000000000000b2" });

type PaidLeg = (req: Request) => Promise<Response> | Response;
type HarnessOptions = {
  /** What the seller puts in `paymentRequired.resource.url` for a request URL (default: the request URL). */
  declared?: (requestUrl: string) => string;
  /** Runs on the unpaid leg; a Response short-circuits the 402 (a free endpoint). */
  unpaid?: (req: Request) => Promise<Response | void> | Response | void;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const abortable = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
  signal.aborted
    ? Promise.reject(new DOMException("aborted", "AbortError"))
    : new Promise<T>((res, rej) => {
        const onAbort = () => rej(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        p.then((v) => { signal.removeEventListener("abort", onAbort); res(v); }, (e) => { signal.removeEventListener("abort", onAbort); rej(e); });
      });

function harness(paidLeg: PaidLeg, reqOverride: Partial<typeof requirement> = {}, opts: HarnessOptions = {}) {
  let signs = 0;
  const counter = { inflight: 0, max: 0 };
  const transport: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    counter.inflight += 1;
    counter.max = Math.max(counter.max, counter.inflight);
    try {
      const run = async (): Promise<Response> => {
        if (!req.headers.get("PAYMENT-SIGNATURE")) {
          const custom = opts.unpaid ? await opts.unpaid(req) : undefined;
          if (custom) return custom;
          const body = { ...challenge, resource: { url: opts.declared ? opts.declared(req.url) : req.url }, accepts: [{ ...requirement, ...reqOverride }] };
          return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(body) } });
        }
        return paidLeg(req);
      };
      // Honour the caller's signal like a real transport would, so abort tests are not vacuous.
      return await abortable(run(), req.signal);
    } finally {
      counter.inflight -= 1;
    }
  };
  const client = x402Client.fromConfig({ schemes: [], spendControls: false as const });
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(x402Version) {
      signs += 1;
      return { x402Version, payload: { signature: "0xfake", authorization: { to: SELLER, value: "40000" } } };
    },
  };
  client.register(BASE, scheme);
  return { client, transport, signs: () => signs, counter };
}

/** Independent settlement evidence stub: what an RPC/indexer check would answer. Without it nothing completes. */
const CONFIRMED = () => ({ confirmed: true });
const POST = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "all" }) };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TERMS = { payTo: SELLER, network: BASE, asset: USDC_BASE, amountAtomic: "40000", maxTimeoutSeconds: 600 };
/** The key the binding derives for a POST of {q} to RESOURCE. */
const keyFor = (q: string) => x402AttemptIntentHash(TERMS, { url: RESOURCE, method: "POST", bodyHash: sha(JSON.stringify({ q })) });

test("completed: signing row before the signer, complete() after PAYMENT-RESPONSE, keyed on url+method+body+terms", async () => {
  const path = join(tempDir("twzrd-outcome-x402-"), "outcomes.jsonl");
  const ledger = createFileOutcomeLedger(path);
  const states: string[] = [];
  const h = harness(async () => {
    // By the time the paid leg runs, the signing row is already on disk.
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).state as string);
    states.push(...lines);
    return new Response(JSON.stringify({ rows: [1, 2, 3] }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk } });
  });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const resp = await guarded(RESOURCE, POST);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { rows: [1, 2, 3] }, "the caller's body is untouched");
  assert.deepEqual(states, ["approved", "signing"]);
  assert.equal(h.signs(), 1);

  assert.deepEqual(ledger.unresolved(), []);
  const bodyHash = sha(POST.body);
  const done = ledger.get(keyFor("all"));
  assert.ok(done, "record is keyed on the intent hash of terms + request");
  assert.equal(done.state, "completed");
  assert.equal(done.settlement?.settlementTx, TX);
  assert.equal(done.settlement?.withinCap, true);
  assert.equal(done.validation?.ruleVersion, X402_PAID_RESPONSE_RULE_V1);
  assert.equal(done.approval.request.method, "POST");
  assert.equal(done.approval.request.bodyHash, bodyHash);
  assert.equal(done.approval.request.url, "https://data.example/v1/dataset", "origin + path only");
  assert.equal(done.approval.request.queryHash, sha("id=7"));
  assert.equal(readFileSync(path, "utf8").includes("id=7"), false, "query strings never reach the file");
  assert.deepEqual(done.history.map((x) => x.state), ["approved", "signing", "completed"]);
});

test("unknown: paid leg throws after signing -> record unknown; the next call for the same intent aborts before the signer", async () => {
  const ledger = createMemoryOutcomeLedger();
  let fail = true;
  const h = harness(async () => {
    if (fail) throw Object.assign(new Error("socket hang up after send"), { name: "ECONNRESET" });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk } });
  });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  await assert.rejects(guarded(RESOURCE, POST), /socket hang up/);
  assert.equal(h.signs(), 1);
  const [u] = ledger.unresolved();
  assert.equal(u?.state, "unknown");
  assert.match(u!.unknownCause!, /ECONNRESET/);

  // Transport would succeed now, but the ledger refuses: payment may already have happened.
  fail = false;
  await assert.rejects(guarded(RESOURCE, POST), /unresolved_attempt:tiv1:/);
  assert.equal(h.signs(), 1, "the signer was not invoked a second time");

  // A different request (different body) is a different intent and proceeds.
  const other = await guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "some" }) });
  assert.equal(other.status, 200);
  assert.equal(h.signs(), 2);
  assert.equal(ledger.unresolved().length, 1, "the unknown one is still unresolved");

  // Operator reconciles against the chain: nothing settled. The intent is open again.
  ledger.markNotSettled(u!.intentHash, { reasonCodes: ["chain_lookup_no_tx"] });
  const retry = await guarded(RESOURCE, POST);
  assert.equal(retry.status, 200);
  assert.equal(h.signs(), 3);
  assert.equal(ledger.get(u!.intentHash)?.state, "completed");
});

test("refused: a local cap abort is recorded as refused and the signer never ran", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(() => new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": settledOk } }));
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, maxPricePerCall: "0.01", outcomeLedger: { ledger, settlement: CONFIRMED } });
  await assert.rejects(guarded(RESOURCE, POST), /price_cap_exceeded/);
  assert.equal(h.signs(), 0);
  assert.deepEqual(ledger.unresolved(), [], "refused is terminal");
  assert.equal(ledger.get(keyFor("all"))?.state, "refused");
  assert.match(ledger.get(keyFor("all"))!.reasonCodes[0]!, /price_cap_exceeded/);
});

test("relayed success:false is unknown (not not_settled); paid_incomplete: validator fails or 5xx with a settled tx", async () => {
  const ledger = createMemoryOutcomeLedger();
  let mode: "settle_failed" | "bad_body" | "http500" = "settle_failed";
  const h = harness(() => {
    if (mode === "settle_failed") return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds" }) } });
    if (mode === "http500") return new Response("oops", { status: 500, headers: { "PAYMENT-RESPONSE": settledOk } });
    return new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk } });
  });
  const guarded = createGuardedX402Fetch({
    client: h.client,
    fetch: h.transport,
    twzrd: { disabled: true },
    outcomeLedger: {
      ledger,
      settlement: CONFIRMED,
      ruleVersion: "dataset-rows.v1",
      schemaId: "dataset.v3",
      validate: async ({ response }) => {
        if (response.status >= 500) return { ok: false, ruleVersion: "dataset-rows.v1", reasonCodes: [`http_${response.status}`] };
        const body = (await response.json()) as { rows?: unknown };
        return Array.isArray(body.rows) ? { ok: true, ruleVersion: "dataset-rows.v1" } : { ok: false, ruleVersion: "dataset-rows.v1", reasonCodes: ["schema_mismatch:rows"] };
      },
    },
  });
  const key = keyFor;
  const r1 = await guarded(RESOURCE, POST);
  assert.equal(r1.status, 402);
  const ns = ledger.get(key("all"));
  assert.equal(ns?.state, "unknown", "the seller relayed the failure; only the chain can say not settled");
  assert.equal(ns?.unknownCause, "settle_failed:insufficient_funds");
  assert.equal(ns?.approval.validation.schemaId, "dataset.v3");
  // Same intent again: blocked until an operator reconciles, even though the seller said it failed.
  await assert.rejects(guarded(RESOURCE, POST), /unresolved_attempt/);

  mode = "bad_body";
  const r2 = await guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "b" }) });
  assert.deepEqual(await r2.json(), { unexpected: true }, "validator read a clone; caller still gets the body");
  const pi = ledger.get(key("b"));
  assert.equal(pi?.state, "paid_incomplete");
  assert.deepEqual(pi?.reasonCodes, ["schema_mismatch:rows"]);
  assert.equal(pi?.settlement?.settlementTx, TX);

  mode = "http500";
  const r3 = await guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "c" }) });
  assert.equal(r3.status, 500);
  const p5 = ledger.get(key("c"));
  assert.equal(p5?.state, "paid_incomplete");
  assert.deepEqual(p5?.reasonCodes, ["http_500"]);
  assert.equal(h.signs(), 3, "the blocked retry never reached the signer");
  assert.equal(ledger.unresolved().length, 1);
});

test("unknown: a paid 200 without any PAYMENT-RESPONSE header is not a completion", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(() => new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const resp = await guarded(RESOURCE, POST);
  assert.equal(resp.status, 200);
  const [u] = ledger.unresolved();
  assert.equal(u?.state, "unknown");
  assert.equal(u?.unknownCause, "no_payment_response_header:http_200");
});

test("a throwing pre-sign hook leaves the intent refused, not stranded in approved", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(() => new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": settledOk } }));
  // The guarded hook reads the clock once in open() and once inside the local checks. Failing the
  // second read is a deterministic way to make the inner hook throw after begin() and before signing.
  let calls = 0;
  const now = () => {
    calls += 1;
    if (calls === 2) throw new RangeError("clock unavailable");
    return 1_760_000_000_000 + calls;
  };
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, hourlyBudgetCap: "1", now, outcomeLedger: { ledger, settlement: CONFIRMED } });
  await assert.rejects(guarded(RESOURCE, POST), /clock unavailable/);
  assert.equal(h.signs(), 0);
  const rec = ledger.get(keyFor("all"));
  assert.equal(rec?.state, "refused");
  assert.deepEqual(rec?.reasonCodes, ["hook_threw:RangeError"]);
  assert.deepEqual(ledger.unresolved(), []);
});

test("merchant maxTimeoutSeconds is clamped before it becomes the approval expiry", async () => {
  for (const [timeout, expectMs] of [[1e12, MAX_APPROVAL_TTL_MS], [-5, MIN_APPROVAL_TTL_MS], [120, 120_000]] as const) {
    const ledger = createMemoryOutcomeLedger();
    const h = harness(() => new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": settledOk } }), { maxTimeoutSeconds: timeout });
    const t0 = 1_760_000_000_000;
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, now: () => t0, outcomeLedger: { ledger, settlement: CONFIRMED } });
    assert.equal((await guarded(RESOURCE, POST)).status, 200);
    const rec = ledger.get(x402AttemptIntentHash({ ...TERMS, maxTimeoutSeconds: timeout }, { url: RESOURCE, method: "POST", bodyHash: sha(POST.body) }));
    assert.equal(rec?.state, "completed");
    assert.equal(Date.parse(rec!.approval.expiresAt) - t0, expectMs, `timeout ${timeout}`);
  }
});

const settled = (p: Promise<Response>) => p.then((r) => ({ ok: true as const, status: r.status }), (e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
const okPaid = () => new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": settledOk } });
const bodyHashesOf = (ledger: { unresolved(): unknown[]; get(h: string): { approval: { request: { bodyHash: string } } } | null | undefined }, keys: string[]) =>
  keys.map((k) => ledger.get(k)?.approval.request.bodyHash);

test("concurrent requests to one URL with different bodies each get their own correct record", async () => {
  const ledger = createMemoryOutcomeLedger();
  const seen: string[] = [];
  const h = harness(async (req) => {
    seen.push(await req.text());
    await sleep(5);
    return new Response(JSON.stringify({ rows: [1] }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk } });
  });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const qs = ["a", "b", "c"];
  const bodies = qs.map((q) => JSON.stringify({ q }));
  // allSettled: a refusal must not hide the wrong-body evidence below.
  const results = await Promise.all(bodies.map((body) => settled(guarded(RESOURCE, { ...POST, body }))));
  // Direct wrong-body assertion first: every paid body has a record under ITS OWN key naming ITS OWN hash.
  assert.deepEqual(bodyHashesOf(ledger, qs.map(keyFor)), bodies.map(sha), "each record is keyed on and names its own body");
  assert.deepEqual(results, qs.map(() => ({ ok: true, status: 200 })));
  assert.equal(h.signs(), 3);
  assert.deepEqual(seen.sort(), [...bodies].sort(), "every body reached the paid leg");
  for (const q of qs) assert.equal(ledger.get(keyFor(q))?.state, "completed", `record for body ${q}`);
  assert.deepEqual(ledger.unresolved(), []);
});

test("F1: an identical in-flight request is refused with unresolved_attempt and the signer runs once", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(async () => { await sleep(40); return okPaid(); });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const results = await Promise.all([settled(guarded(RESOURCE, POST)), settled(guarded(RESOURCE, POST))]);
  assert.equal(h.signs(), 1, "one signature for one intent");
  const ok = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  assert.equal(ok.length, 1);
  assert.equal(refused.length, 1);
  assert.match((refused[0] as { error: string }).error, /unresolved_attempt:tiv1:/);
  assert.equal(ledger.get(keyFor("all"))?.state, "completed");
  assert.deepEqual(ledger.unresolved(), []);
  // After completion the same intent may be bought again (sequential repeats are two attempts).
  assert.equal((await guarded(RESOURCE, POST)).status, 200);
  assert.equal(h.signs(), 2);
});

test("F2a: seller declares resource.url without the query while ?id=7 and ?id=8 run concurrently", async () => {
  const path = join(tempDir("twzrd-outcome-x402-"), "outcomes.jsonl");
  const ledger = createFileOutcomeLedger(path);
  const h = harness(okPaid, {}, { declared: () => "https://data.example/v1/dataset", unpaid: () => sleep(10) });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const A = "https://data.example/v1/dataset?id=7", B = "https://data.example/v1/dataset?id=8";
  const bodyA = JSON.stringify({ q: "a" }), bodyB = JSON.stringify({ q: "b" });
  const results = await Promise.all([settled(guarded(A, { ...POST, body: bodyA })), settled(guarded(B, { ...POST, body: bodyB }))]);
  assert.deepEqual(results, [{ ok: true, status: 200 }, { ok: true, status: 200 }]);
  assert.equal(h.signs(), 2);
  const keyA = x402AttemptIntentHash(TERMS, { url: A, method: "POST", bodyHash: sha(bodyA) });
  const keyB = x402AttemptIntentHash(TERMS, { url: B, method: "POST", bodyHash: sha(bodyB) });
  assert.deepEqual(bodyHashesOf(ledger, [keyA, keyB]), [sha(bodyA), sha(bodyB)], "each record carries its own body hash");
  assert.equal(ledger.get(keyA)?.state, "completed");
  assert.equal(ledger.get(keyB)?.state, "completed");
  assert.deepEqual(ledger.unresolved(), [], "no record stranded in signing");
  const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { approval?: { request?: { method: string } } });
  assert.ok(rows.every((r) => !r.approval || r.approval.request?.method === "POST"), "no UNKNOWN method on disk");
});

test("F2b: a request to /a (seller declares /b) races a direct request to /b; each record names its own request", async () => {
  const ledger = createMemoryOutcomeLedger();
  const a = "https://data.example/v1/a", b = "https://data.example/v1/b";
  const h = harness(okPaid, {}, { declared: (u) => (u === a ? b : u), unpaid: () => sleep(10) });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const bodyA = JSON.stringify({ q: "A" }), bodyB = JSON.stringify({ q: "B" });
  const results = await Promise.all([settled(guarded(a, { ...POST, body: bodyA })), settled(guarded(b, { ...POST, body: bodyB }))]);
  assert.deepEqual(results, [{ ok: true, status: 200 }, { ok: true, status: 200 }]);
  const keyA = x402AttemptIntentHash(TERMS, { url: a, method: "POST", bodyHash: sha(bodyA) });
  const keyB = x402AttemptIntentHash(TERMS, { url: b, method: "POST", bodyHash: sha(bodyB) });
  assert.deepEqual(bodyHashesOf(ledger, [keyA, keyB]), [sha(bodyA), sha(bodyB)]);
  assert.equal(ledger.get(keyA)?.approval.request.url, a, "the record for /a names /a, not the seller's /b");
  assert.equal(ledger.get(keyB)?.approval.request.url, b);
  assert.deepEqual(ledger.unresolved(), [], "no record stranded in signing under the wrong request");
});

test("F3: free (never-402) calls to one URL are not serialized: 5 concurrent calls reach 5 in flight", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(okPaid, {}, { unpaid: async () => { await sleep(50); return new Response("free", { status: 200 }); } });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const t0 = Date.now();
  const res = await Promise.all([1, 2, 3, 4, 5].map(() => guarded(RESOURCE)));
  const ms = Date.now() - t0;
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(h.counter.max, 5, `max in flight ${h.counter.max}; 5 x 50 ms took ${ms} ms`);
  assert.ok(ms < 200, `5 concurrent 50 ms free calls took ${ms} ms`);
  assert.equal(h.signs(), 0);
});

test("F4: an aborted call rejects promptly while another call to the same URL is in flight", async () => {
  const ledger = createMemoryOutcomeLedger();
  // Every unpaid leg is slow, so the second call can only settle early by honouring its own signal.
  const h = harness(okPaid, {}, { unpaid: () => sleep(600) });
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  const slow = settled(guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "slow" }) }));
  await sleep(10);
  const t0 = Date.now();
  const r = await settled(guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "queued" }), signal: AbortSignal.timeout(50) }));
  const ms = Date.now() - t0;
  assert.equal(r.ok, false, "the aborted call rejects");
  assert.match((r as { error: string }).error, /abort/i);
  assert.ok(ms < 200, `call with a 50 ms signal rejected after ${ms} ms`);
  assert.equal((await slow).ok, true);
  assert.deepEqual(ledger.unresolved(), []);
});

test("F5: a validator that re-enters the guarded fetch for the same URL resolves", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(okPaid);
  let guarded!: typeof fetch;
  guarded = createGuardedX402Fetch({
    client: h.client,
    fetch: h.transport,
    twzrd: { disabled: true },
    outcomeLedger: {
      ledger,
      settlement: CONFIRMED,
      validate: async ({ approval }) => {
        if (approval.request.bodyHash === sha(JSON.stringify({ q: "outer" }))) {
          const inner = await guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "inner" }) });
          assert.equal(inner.status, 200);
        }
        return { ok: true, ruleVersion: X402_PAID_RESPONSE_RULE_V1, reasonCodes: [] };
      },
    },
  });
  const r = await Promise.race([guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "outer" }) }), sleep(800).then(() => "timeout" as const)]);
  assert.notEqual(r, "timeout", "outer call must not hang on itself");
  assert.equal((r as Response).status, 200);
  assert.equal(h.signs(), 2);
  assert.equal(ledger.get(keyFor("outer"))?.state, "completed");
  assert.equal(ledger.get(keyFor("inner"))?.state, "completed");
  assert.deepEqual(ledger.unresolved(), []);
});

test("lifecycle: after a failing first call, a second call to the same URL proceeds and nothing hangs", async () => {
  const cases: Array<[string, PaidLeg, Partial<HarnessOptions>]> = [
    ["signer-side unpaid transport rejects once", okPaid, { unpaid: (() => { let c = 0; return () => { if (c++ === 0) throw new Error("net down"); }; })() }],
    ["paid leg throws once", (() => { let c = 0; return () => { if (c++ === 0) throw new Error("net down paid"); return okPaid(); }; })(), {}],
    ["paid leg 500 without PAYMENT-RESPONSE once", (() => { let c = 0; return () => (c++ === 0 ? new Response("x", { status: 500 }) : okPaid()); })(), {}],
  ];
  for (const [name, paid, opts] of cases) {
    const ledger = createMemoryOutcomeLedger();
    const h = harness(paid, {}, opts);
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
    const first = settled(guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "first" }) }));
    const second = await Promise.race([settled(guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "second" }) })), sleep(800).then(() => "timeout" as const)]);
    assert.notEqual(second, "timeout", `${name}: second same-URL call must not hang`);
    assert.deepEqual(second, { ok: true, status: 200 }, name);
    await first;
  }
});

test("unbound: the hook refuses a direct createPaymentPayload() instead of stranding a signing record", async () => {
  const ledger = createMemoryOutcomeLedger();
  const h = harness(okPaid);
  createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: CONFIRMED } });
  await assert.rejects(h.client.createPaymentPayload(challenge as never), /unbound_request/);
  assert.equal(h.signs(), 0);
  assert.deepEqual(ledger.unresolved(), [], "nothing recorded under an unknown request");
});

// --- G2: completion needs evidence the seller did not relay ---------------------------------

test("G2 result-validation: relayed success+tx with no settlement check is unknown (merchant-reported), never completed", async () => {
  const h = harness(() => new Response("not the requested structured result", { status: 200, headers: { "PAYMENT-RESPONSE": settledOk } }));
  const ledger = createMemoryOutcomeLedger();
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: ledger });
  const res = await guarded(RESOURCE, POST);
  assert.equal(res.status, 200);
  assert.equal(h.signs(), 1);
  const rec = ledger.get(keyFor("all"))!;
  assert.equal(rec.state, "unknown");
  assert.equal(rec.unknownCause, `${MERCHANT_REPORTED_SETTLEMENT}:${TX}`);
  assert.equal(ledger.unresolved().length, 1);
  // and a retry of the same intent is blocked until reconciled
  await assert.rejects(guarded(RESOURCE, POST), /unresolved_attempt/);
  assert.equal(h.signs(), 1);
});

test("G2 result-validation: confirmed settlement + bound validator decides completed vs paid_incomplete; unconfirmed or throwing check stays unknown", async () => {
  const paid = () => new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk } });
  // confirmed + validator ok -> completed
  {
    const h = harness(paid); const ledger = createMemoryOutcomeLedger();
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: () => ({ confirmed: true, feesAtomic: "0" }) } });
    await guarded(RESOURCE, POST);
    assert.equal(ledger.get(keyFor("all"))!.state, "completed");
  }
  // confirmed + bound validator rejects the body -> paid_incomplete
  {
    const h = harness(paid); const ledger = createMemoryOutcomeLedger();
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: {
      ledger, settlement: CONFIRMED, ruleVersion: "rows.v1",
      validate: async ({ response }) => { const j = await response.json() as { rows: unknown[] }; return { ok: j.rows.length > 0, ruleVersion: "rows.v1", reasonCodes: j.rows.length ? [] : ["empty_rows"] }; },
    } });
    await guarded(RESOURCE, POST);
    const rec = ledger.get(keyFor("all"))!;
    assert.equal(rec.state, "paid_incomplete");
    assert.deepEqual(rec.reasonCodes, ["empty_rows"]);
    assert.equal(rec.settlement?.settlementTx, TX);
  }
  // check says unconfirmed -> unknown (not not_settled), tx kept in the cause
  {
    const h = harness(paid); const ledger = createMemoryOutcomeLedger();
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: () => ({ confirmed: false, reasonCodes: ["tx_not_found"] }) } });
    await guarded(RESOURCE, POST);
    const rec = ledger.get(keyFor("all"))!;
    assert.equal(rec.state, "unknown");
    assert.equal(rec.unknownCause, `settlement_unconfirmed:tx_not_found:${TX}`);
  }
  // check throws -> unknown
  {
    const h = harness(paid); const ledger = createMemoryOutcomeLedger();
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, settlement: () => { throw new Error("rpc down"); } } });
    await guarded(RESOURCE, POST);
    const rec = ledger.get(keyFor("all"))!;
    assert.equal(rec.state, "unknown");
    assert.match(rec.unknownCause ?? "", /^settlement_check_threw:rpc down:/);
  }
});

// --- G1: one unresolved attempt per operation, whatever the terms ---------------------------

test("G1 changed-terms: a re-quoted price on an operation whose first payment is unknown aborts with unresolved_operation; the signer does not run again", async () => {
  let amount = "40000";
  const h = harness(() => { throw new Error("response lost after payment signature"); }, {}, { declared: (u) => u });
  // re-quote by mutating the challenge the harness emits
  const transport: typeof fetch = (input, init) => h.transport(input, init);
  const ledger = createMemoryOutcomeLedger();
  const client = h.client;
  const guarded = createGuardedX402Fetch({ client, fetch: async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.headers.get("PAYMENT-SIGNATURE")) return transport(input, init);
    const body = { ...challenge, resource: { url: req.url }, accepts: [{ ...requirement, amount }] };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(body) } });
  }, twzrd: { disabled: true }, outcomeLedger: ledger });
  await assert.rejects(guarded(RESOURCE, POST), /response lost/);
  assert.equal(h.signs(), 1);
  const first = ledger.get(keyFor("all"))!;
  assert.equal(first.state, "unknown");
  amount = "80000";
  await assert.rejects(guarded(RESOURCE, POST), new RegExp(`${UNRESOLVED_OPERATION_REASON}:.*prior=${first.intentHash}`));
  assert.equal(h.signs(), 1, "changed terms must reconcile the operation before signing");
  assert.equal(ledger.unresolved().length, 1, "the refused re-quote opens no second record");
  // a different request (other body) is a different operation and proceeds to the signer
  await assert.rejects(guarded(RESOURCE, { ...POST, body: JSON.stringify({ q: "other" }) }), /response lost/);
  assert.equal(h.signs(), 2);
});

test("G1 operation id: intentional repeats named by the buyer are separate operations; the derived key ignores terms", async () => {
  const h = harness(() => { throw new Error("response lost after payment signature"); });
  const ledger = createMemoryOutcomeLedger();
  let job = "job-1";
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: { ledger, operationId: () => job } });
  await assert.rejects(guarded(RESOURCE, POST), /response lost/);
  assert.equal(h.signs(), 1);
  // same request, same terms, same job: blocked (same intent, unresolved)
  await assert.rejects(guarded(RESOURCE, POST), /unresolved_attempt/);
  assert.equal(h.signs(), 1);
  // same request, different job: a second approved operation; the signer runs
  job = "job-2";
  await assert.rejects(guarded(RESOURCE, POST), /response lost/);
  assert.equal(h.signs(), 2);
  const [a, b] = ledger.unresolved();
  assert.equal(a.approval.operationId, "job-1");
  assert.equal(b.approval.operationId, "job-2");
  assert.notEqual(operationKeyOf(a.approval), operationKeyOf(b.approval));
  // derived key: terms excluded, request included
  const base = { payTo: SELLER, network: BASE, asset: USDC_BASE, amountAtomic: "1", expiresAt: new Date().toISOString(), validation: { ruleVersion: "x" }, request: { method: "GET", url: "https://a.example/p", bodyHash: "", queryHash: "q" } };
  assert.equal(operationKeyOf(base), operationKeyOf({ ...base, amountAtomic: "999", payTo: "0x" + "1".repeat(40) }));
  assert.notEqual(operationKeyOf(base), operationKeyOf({ ...base, request: { ...base.request, queryHash: "r" } }));
});

test("G1 restart: an unknown record left by a previous process blocks a changed-price retry in a fresh binding over the same file", async () => {
  const dir = tempDir("outcome-restart-");
  const file = join(dir, "outcomes.jsonl");
  let amount = "40000";
  const mk = () => {
    const h = harness(() => { throw new Error("response lost after payment signature"); });
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.headers.get("PAYMENT-SIGNATURE")) return h.transport(input, init);
      const body = { ...challenge, resource: { url: req.url }, accepts: [{ ...requirement, amount }] };
      return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(body) } });
    }, twzrd: { disabled: true }, outcomeLedger: createFileOutcomeLedger(file) });
    return { h, guarded };
  };
  const p1 = mk();
  await assert.rejects(p1.guarded(RESOURCE, POST), /response lost/);
  assert.equal(p1.h.signs(), 1);
  // "restart": new ledger instance over the same file, seller now quotes a new price
  amount = "80000";
  const p2 = mk();
  await assert.rejects(p2.guarded(RESOURCE, POST), /unresolved_operation/);
  assert.equal(p2.h.signs(), 0, "nothing signs after a restart while the operation is unresolved");
  assert.equal(createFileOutcomeLedger(file).unresolved().length, 1);
});

// --- review P2 (mission-revalidation 2026-10-30): expired never-signed approvals must not block changed terms ---

const ctxAt = (amount: string, maxTimeoutSeconds = 5) => ({
  selectedRequirements: { scheme: "exact", network: BASE, asset: USDC_BASE, payTo: SELLER, amount, maxTimeoutSeconds },
});
const URL_OP = "https://offline.example/data";

test("P2: a never-signed expired approval does not indefinitely block re-quoted terms (reviewer's test)", async () => {
  const ledger = createMemoryOutcomeLedger(); let clock = 100000;
  const binding = createOutcomeLedgerX402Binding({ ledger, now: () => clock });
  let firstHash = "";
  await binding.bindCall(URL_OP, undefined, async () => { const first = binding.open(ctxAt("1000")); assert.ok(first && "intentHash" in first); firstHash = first.intentHash; });
  clock += 6000;
  await binding.bindCall(URL_OP, undefined, async () => {
    const next = binding.open(ctxAt("2000"));
    assert.ok(next && "intentHash" in next, "expired, never-signed approvals must lapse for changed terms too");
  });
  assert.equal(ledger.get(firstHash)!.state, "expired", "the lapse is recorded, not silently skipped");
  assert.deepEqual(ledger.unresolved().map((r) => r.state), ["approved"]);
});

test("P2 controls: same price after expiry lapses via begin(); before expiry same and changed price are both blocked", async () => {
  const ledger = createMemoryOutcomeLedger(); let clock = 100000;
  const binding = createOutcomeLedgerX402Binding({ ledger, now: () => clock });
  await binding.bindCall(URL_OP, undefined, async () => assert.ok("intentHash" in binding.open(ctxAt("1000"))!));
  // still live: both the same intent and a re-quote are refused, nothing lapses
  clock += 1000;
  await binding.bindCall(URL_OP, undefined, async () => {
    assert.match(String((binding.open(ctxAt("1000")) as { abort: string }).abort), /^unresolved_attempt/);
    assert.match(String((binding.open(ctxAt("2000")) as { abort: string }).abort), /^unresolved_operation/);
  });
  assert.equal(ledger.unresolved().length, 1);
  // past expiry, same price: begin() records expired and opens anew
  clock += 6000;
  await binding.bindCall(URL_OP, undefined, async () => assert.ok("intentHash" in binding.open(ctxAt("1000"))!));
  assert.deepEqual(ledger.unresolved().map((r) => r.state), ["approved"]);
});

test("P2 controls: signing and unknown rows never lapse on time, same or changed price", async () => {
  for (const settle of ["signing", "unknown"] as const) {
    const ledger = createMemoryOutcomeLedger(); let clock = 100000;
    const binding = createOutcomeLedgerX402Binding({ ledger, now: () => clock });
    let hash = "";
    await binding.bindCall(URL_OP, undefined, async () => {
      const r = binding.open(ctxAt("1000")); assert.ok(r && "intentHash" in r); hash = r.intentHash;
      binding.close(hash, undefined as unknown as Parameters<typeof binding.close>[1]); // -> signing
    });
    if (settle === "unknown") ledger.markUnknown(hash, { cause: "response lost", now: clock });
    assert.equal(ledger.get(hash)!.state, settle);
    clock += 60 * 60 * 1000; // an hour, far past the 5 s approval
    await binding.bindCall(URL_OP, undefined, async () => {
      assert.match(String((binding.open(ctxAt("1000")) as { abort: string }).abort), /^unresolved_attempt/);
      assert.match(String((binding.open(ctxAt("2000")) as { abort: string }).abort), /^unresolved_operation/);
    });
    assert.equal(ledger.get(hash)!.state, settle, `${settle} must survive the clock`);
    assert.equal(ledger.unresolved().length, 1);
  }
});

test("P2 restart: an expired never-signed approval left on disk lapses for a changed price in a fresh binding; an unknown row on disk still blocks", async () => {
  const dir = tempDir("outcome-p2-restart-");
  const file = join(dir, "outcomes.jsonl");
  let clock = 100000;
  // process 1: approved, then "crash" before markSigning
  {
    const binding = createOutcomeLedgerX402Binding({ ledger: createFileOutcomeLedger(file), now: () => clock });
    await binding.bindCall(URL_OP, undefined, async () => assert.ok("intentHash" in binding.open(ctxAt("1000"))!));
  }
  clock += 6000;
  // process 2: changed price is evaluated, the old row is recorded expired
  {
    const ledger = createFileOutcomeLedger(file);
    const binding = createOutcomeLedgerX402Binding({ ledger, now: () => clock });
    let h2 = "";
    await binding.bindCall(URL_OP, undefined, async () => { const r = binding.open(ctxAt("2000")); assert.ok(r && "intentHash" in r); h2 = r.intentHash; binding.close(h2, undefined as unknown as Parameters<typeof binding.close>[1]); });
    ledger.markUnknown(h2, { cause: "response lost", now: clock });
    const states = createFileOutcomeLedger(file).unresolved().map((r) => r.state);
    assert.deepEqual(states, ["unknown"]);
  }
  clock += 6000;
  // process 3: the unknown row blocks a third price indefinitely
  {
    const binding = createOutcomeLedgerX402Binding({ ledger: createFileOutcomeLedger(file), now: () => clock });
    await binding.bindCall(URL_OP, undefined, async () => assert.match(String((binding.open(ctxAt("3000")) as { abort: string }).abort), /^unresolved_operation/));
  }
});
