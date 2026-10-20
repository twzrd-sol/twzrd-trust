import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";
import { tempDir } from "./helpers/tmpdir.js";
import {
  buildFulfillmentRecord,
  createFileFulfillmentLog,
  FULFILLMENT_MAX_BODY_BYTES,
  FULFILLMENT_RECORD_SCHEMA,
  modelMatches,
  wrapFetchRecordFulfillment,
  type FulfillmentRecord,
} from "../src/fulfillment-record.js";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";

const BASE = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x00000000000000000000000000000000000000a1";
const TX = "0x" + "ab".repeat(32);
const RESOURCE = "https://gpu.example/api/public/x402/exec?token=secret-query";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const requirement = { scheme: "exact", network: BASE, asset: USDC_BASE, amount: "40000", payTo: SELLER, maxTimeoutSeconds: 600, extra: {} };
const v2Payment = b64({ x402Version: 2, accepted: requirement, payload: { signature: "0xsig" } });
const settledOk = b64({ success: true, transaction: TX, network: BASE, payer: "0x00000000000000000000000000000000000000b2" });

/** Kilawatt Cloud's documented paid response: the job is accepted, not yet ready. */
const gpuJob = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  job_id: "job-1",
  provider: "Node US-East-04",
  workload_type: "agent_exec",
  failover_hops: 1,
  billed_usd: 0.04,
  status: "provisioning",
  ready: false,
  health_status: "pending",
  payment: { transaction_hash: TX, network: "base", amount_usd: 0.04, payer: "0x00000000000000000000000000000000000000b2" },
  api_key: "kw_live_must_never_be_logged",
  ...overrides,
});

const paid = (responseBody: unknown, extra: Partial<Parameters<typeof buildFulfillmentRecord>[0]> = {}) =>
  buildFulfillmentRecord({
    resource: RESOURCE,
    httpStatus: 200,
    paymentHeader: v2Payment,
    paymentResponseHeader: settledOk,
    responseBody,
    atUnixMs: 1,
    ...extra,
  });

function nextRecord(): { onRecord: (r: FulfillmentRecord) => void; record: Promise<FulfillmentRecord> } {
  let onRecord!: (r: FulfillmentRecord) => void;
  const record = new Promise<FulfillmentRecord>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no fulfillment record within 2s")), 2000);
    onRecord = (r) => { clearTimeout(timer); resolve(r); };
  });
  return { onRecord, record };
}

async function main() {
  // Accepted GPU job: who was paid, the tx, the seller's node label, pending readiness.
  {
    const row = paid(gpuJob());
    assert.equal(row.schema, FULFILLMENT_RECORD_SCHEMA);
    assert.equal(row.paid_to, SELLER);
    assert.equal(row.network, BASE);
    assert.equal(row.amount_atomic, "40000");
    assert.equal(row.tx, TX);
    assert.equal(row.settled, true);
    assert.equal(row.served_by, "Node US-East-04");
    assert.equal(row.served_by_field, "provider");
    assert.equal(row.failover_hops, 1);
    assert.equal(row.ready, false);
    assert.equal(row.job_status, "provisioning");
    assert.equal(row.job_id, "job-1");
    assert.equal(row.verdict, "pending", "ready:false while provisioning is not a failure");
    assert.deepEqual(row.reasons, []);
    assert.equal(row.resource_origin, "https://gpu.example");
    const text = JSON.stringify(row);
    assert.equal(text.includes("kw_live"), false, "seller secrets are never copied");
    assert.equal(text.includes("secret-query"), false, "paths and query strings are never kept");
  }

  // Readiness: a later job body with ready:true matches; a terminal status without ready is a mismatch.
  assert.equal(paid(gpuJob({ ready: true, status: "running" })).verdict, "match");
  {
    const row = paid(gpuJob({ status: "failed" }));
    assert.equal(row.verdict, "mismatch");
    assert.deepEqual(row.reasons, ["not_ready"]);
  }
  assert.equal(paid(gpuJob({ status: "Refunded" })).reasons.includes("not_ready"), true);

  // The seller's tx must be the facilitator's tx; EVM hashes compare case-insensitively.
  assert.deepEqual(paid(gpuJob({ payment: { transaction_hash: TX.toUpperCase().replace("0X", "0x") } })).reasons, []);
  {
    const row = paid(gpuJob({ ready: true, payment: { transaction_hash: "0x" + "cd".repeat(32) } }));
    assert.equal(row.tx, TX, "PAYMENT-RESPONSE is the tx of record");
    assert.deepEqual(row.reasons, ["tx_disagrees"]);
    assert.equal(row.verdict, "mismatch");
  }

  // Settlement problems.
  assert.deepEqual(paid(gpuJob(), { paymentResponseHeader: b64({ success: false, errorReason: "x" }) }).reasons, ["settle_failed"]);
  assert.deepEqual(paid({ error: "boom" }, { httpStatus: 500 }).reasons, ["paid_http_error"]);
  assert.deepEqual(paid({ error: "boom" }, { httpStatus: 500, paymentResponseHeader: null }).reasons, [], "no settle header, no settled claim");

  // OpenAI-compatible responses: the served model against the requested one.
  {
    const ok = paid({ object: "chat.completion", model: "gpt-4o-2024-08-06" }, { requestBody: { model: "openai/gpt-4o" } });
    assert.equal(ok.served_by, "gpt-4o-2024-08-06");
    assert.equal(ok.served_by_field, "model");
    assert.equal(ok.requested_model, "openai/gpt-4o");
    assert.equal(ok.verdict, "match");
    const swapped = paid({ object: "chat.completion", model: "gpt-4o-mini" }, { requestBody: { model: "gpt-4o" } });
    assert.equal(swapped.verdict, "mismatch");
    assert.deepEqual(swapped.reasons, ["model_substituted"]);
    const routed = paid({ model: "some-vendor/small-model" }, { requestBody: { model: "router/auto" } });
    assert.equal(routed.verdict, "not_reported", "a router profile names no model to compare");
    assert.deepEqual(routed.reasons, []);
    assert.equal(routed.served_by, "some-vendor/small-model");
  }
  assert.equal(modelMatches("claude-sonnet-4", "claude-sonnet-4-20250514"), true);
  assert.equal(modelMatches("gpt-4", "gpt-4-0613"), true);
  assert.equal(modelMatches("gpt-4", "gpt-4o"), false);
  assert.equal(modelMatches("gpt-4o", "gpt-4o-mini"), false);
  assert.equal(modelMatches("vendor/", "anything"), null);
  assert.equal(modelMatches("AUTO", "x"), null);

  // Nothing reported, older failover_from shape, and a v1 EVM X-PAYMENT header.
  {
    const row = paid({ data: [1, 2, 3] });
    assert.equal(row.verdict, "not_reported");
    assert.equal(row.served_by, null);
    assert.equal(paid(gpuJob({ failover_hops: undefined, failover_from: ["a", "b"] })).failover_hops, 2);
    const v1 = buildFulfillmentRecord({
      httpStatus: 200,
      paymentHeader: b64({ x402Version: 1, scheme: "exact", network: "base", payload: { authorization: { to: SELLER, value: "10000" } } }),
      responseBody: null,
    });
    assert.equal(v1.paid_to, SELLER);
    assert.equal(v1.amount_atomic, "10000");
    assert.equal(v1.network, "base");
    assert.equal(v1.resource_origin, null);
    assert.equal(buildFulfillmentRecord({ httpStatus: 200, paymentHeader: "not base64 json" }).paid_to, null);
  }

  // Wrapper: records paid calls only, returns the response untouched, swallows sink errors.
  {
    const { onRecord, record } = nextRecord();
    let records = 0;
    const inner: typeof fetch = async () =>
      new Response(JSON.stringify({ model: "gpt-4o-2024-08-06" }), {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk },
      });
    const wrapped = wrapFetchRecordFulfillment(inner, (r) => { records++; onRecord(r); });
    const request = new Request("https://llm.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": v2Payment },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    const resp = await wrapped(request);
    assert.deepEqual(await resp.json(), { model: "gpt-4o-2024-08-06" }, "caller still reads the body");
    const row = await record;
    assert.equal(row.verdict, "match");
    assert.equal(row.requested_model, "gpt-4o");
    assert.equal(row.tx, TX);
    assert.equal(row.resource_origin, "https://llm.example");

    const unpaid = await wrapped("https://llm.example/free", { headers: { "content-type": "application/json" } });
    assert.equal(unpaid.status, 200);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(records, 1, "requests without a payment header are not recorded");

    const throwing = wrapFetchRecordFulfillment(inner, () => { throw new Error("sink down"); });
    const ok = await throwing("https://llm.example/x", { headers: { "X-PAYMENT": v2Payment } });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 10));
  }

  // Event streams and oversized bodies record header fields only.
  {
    const { onRecord, record } = nextRecord();
    const sse = wrapFetchRecordFulfillment(
      async () => new Response("data: {\"model\":\"x\"}\n\n", { headers: { "content-type": "text/event-stream", "PAYMENT-RESPONSE": settledOk } }),
      onRecord,
    );
    const resp = await sse("https://llm.example/stream", { headers: { "PAYMENT-SIGNATURE": v2Payment } });
    assert.match(await resp.text(), /data:/);
    const row = await record;
    assert.equal(row.served_by, null);
    assert.equal(row.tx, TX);

    const big = nextRecord();
    const huge = JSON.stringify({ model: "m", pad: "x".repeat(FULFILLMENT_MAX_BODY_BYTES) });
    const large = wrapFetchRecordFulfillment(
      async () => new Response(huge, { headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk } }),
      big.onRecord,
    );
    const bigResp = await large("https://llm.example/big", { headers: { "PAYMENT-SIGNATURE": v2Payment } });
    assert.equal((await bigResp.text()).length, huge.length, "the caller's body is complete");
    assert.equal((await big.record).served_by, null);
  }

  // End to end through createGuardedX402Fetch with a real x402 client and a fake Base signer.
  {
    const challenge = { x402Version: 2, resource: { url: RESOURCE }, accepts: [requirement] };
    const transport: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (!req.headers.get("PAYMENT-SIGNATURE")) {
        return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(challenge) } });
      }
      return new Response(JSON.stringify(gpuJob()), {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settledOk },
      });
    };
    const client = x402Client.fromConfig({ schemes: [], spendControls: false as const });
    const scheme: SchemeNetworkClient = {
      scheme: "exact",
      async createPaymentPayload(x402Version) {
        return { x402Version, payload: { signature: "0xfake", authorization: { to: SELLER, value: "40000" } } };
      },
    };
    client.register(BASE, scheme);
    const { onRecord, record } = nextRecord();
    const guarded = createGuardedX402Fetch({ client, fetch: transport, twzrd: { disabled: true }, onFulfillment: onRecord });
    const resp = await guarded(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gpu_type: "nvidia-a10" }),
    });
    assert.equal(resp.status, 200);
    assert.equal(((await resp.json()) as { job_id: string }).job_id, "job-1");
    const row = await record;
    assert.equal(row.paid_to, SELLER);
    assert.equal(row.tx, TX);
    assert.equal(row.served_by, "Node US-East-04");
    assert.equal(row.verdict, "pending");
    assert.equal(JSON.stringify(row).includes("kw_live"), false);
  }

  // JSONL sink.
  {
    const path = join(tempDir("twzrd-fulfillment-"), "fulfillment.jsonl");
    const log = createFileFulfillmentLog(path);
    const a = paid(gpuJob());
    const b = paid(gpuJob({ ready: true }));
    log.record(a);
    log.record(b);
    await log.flush();
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines, [a, b]);
  }

  console.log("fulfillment-record: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
