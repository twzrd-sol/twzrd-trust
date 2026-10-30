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
import { MAX_APPROVAL_TTL_MS, MIN_APPROVAL_TTL_MS, X402_PAID_RESPONSE_RULE_V1, x402AttemptIntentHash } from "../src/outcome-ledger-x402.js";

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

function harness(paidLeg: PaidLeg, reqOverride: Partial<typeof requirement> = {}) {
  let signs = 0;
  const body = { ...challenge, accepts: [{ ...requirement, ...reqOverride }] };
  const transport: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.headers.get("PAYMENT-SIGNATURE")) {
      return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(body) } });
    }
    return paidLeg(req);
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
  return { client, transport, signs: () => signs };
}

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
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: ledger });
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
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: ledger });
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
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, maxPricePerCall: "0.01", outcomeLedger: ledger });
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
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, outcomeLedger: ledger });
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
  const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, hourlyBudgetCap: "1", now, outcomeLedger: ledger });
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
    const guarded = createGuardedX402Fetch({ client: h.client, fetch: h.transport, twzrd: { disabled: true }, now: () => t0, outcomeLedger: ledger });
    assert.equal((await guarded(RESOURCE, POST)).status, 200);
    const rec = ledger.get(x402AttemptIntentHash({ ...TERMS, maxTimeoutSeconds: timeout }, { url: RESOURCE, method: "POST", bodyHash: sha(POST.body) }));
    assert.equal(rec?.state, "completed");
    assert.equal(Date.parse(rec!.approval.expiresAt) - t0, expectMs, `timeout ${timeout}`);
  }
});
