/**
 * Attribution contract test: when autoReceipt fires the paid /v1/intel/trust call,
 * it MUST echo the preflight's `preflight_id` as the `x-twzrd-preflight-id` header so
 * the server can record the verify->act funnel join (otherwise the paid call lands in
 * x402_payment_receipts with a NULL preflight_request_id and the demand funnel is blind).
 * Run: npx tsx test/attribution.test.ts
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import { CLIENT_VERSION } from "../src/version.js";

const PREFLIGHT_ID = 219886;

// config.fetch: free preflight returns a readiness_card + the top-level preflight_id sibling.
const preflightFetch: typeof fetch = (async () =>
  new Response(
    JSON.stringify({
      readiness_card: { decision: "warn", trust_score: 45, seller_wallet: "SELLER" },
      preflight_id: PREFLIGHT_ID,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

async function run() {
  // 1. autoReceipt paid call carries the attribution header
  {
    let paidUrl: string | undefined;
    let paidHeaders: Headers | undefined;
    const x402Fetch: typeof fetch = (async (url: unknown, init?: { headers?: RequestInit["headers"] }) => {
      paidUrl = String(url);
      paidHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ charged: true, tx: "TX123", twzrd_receipt: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await evaluate_x402_resource(
      "https://merchant/paid",
      { payTo: "SELLER", maxAmountRequired: "50000", resource: "https://merchant/paid", network: "solana" },
      { autoReceipt: true, x402Fetch, fetch: preflightFetch, preflightMinScore: 0 },
    );

    assert.ok(paidUrl?.includes("/v1/intel/trust/SELLER"), "paid trust call fires on warn");
    assert.equal(
      paidHeaders?.get("x-twzrd-preflight-id"),
      String(PREFLIGHT_ID),
      "paid call must echo preflight_id as x-twzrd-preflight-id (verify->act attribution)",
    );
    // caller_id gap fix: this call previously sent no identity headers at all,
    // so every autoReceipt challenge event landed in x402_challenge_events with
    // caller_id=NULL (the measured 0/264 gap).
    assert.equal(
      paidHeaders?.get("x-twzrd-client"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "paid call must stamp X-TWZRD-Client (previously unstamped)",
    );
    assert.equal(
      paidHeaders?.get("x-twzrd-caller"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "paid call must stamp X-Twzrd-Caller (previously unstamped)",
    );
    assert.equal(result.receiptFeeCaptured, true, "receipt fee captured");
  }

  // 1b. attribution configured -> paid call narrows X-Twzrd-Caller to <integration>@<version>,
  //     same behavior as the free preflight (policy.ts twzrdPreflight).
  {
    let paidHeaders: Headers | undefined;
    const x402Fetch: typeof fetch = (async (_url: unknown, init?: { headers?: RequestInit["headers"] }) => {
      paidHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ charged: true, tx: "TX124", twzrd_receipt: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await evaluate_x402_resource(
      "https://merchant/paid",
      { payTo: "SELLER", maxAmountRequired: "50000", resource: "https://merchant/paid", network: "solana" },
      {
        autoReceipt: true,
        x402Fetch,
        fetch: preflightFetch,
        preflightMinScore: 0,
        attribution: { integration: "payai-x402-solana-pr38", runId: "run-attr-1" },
      },
    );

    assert.equal(
      paidHeaders?.get("x-twzrd-caller"),
      `payai-x402-solana-pr38@${CLIENT_VERSION}`,
      "paid call narrows X-Twzrd-Caller when attribution is configured",
    );
    assert.equal(
      paidHeaders?.get("x-twzrd-client"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "X-TWZRD-Client stays the package tag regardless of attribution",
    );
    // Integration/Run-Id stay preflight-only; the paid receipt fetch does not carry them.
    assert.equal(paidHeaders?.get("x-twzrd-integration"), null, "paid call does not carry X-TWZRD-Integration");
    assert.equal(paidHeaders?.get("x-twzrd-run-id"), null, "paid call does not carry X-TWZRD-Run-Id");
  }

  // 2. no preflight_id in the response -> header is simply absent (no crash, backward compatible)
  {
    const noIdPreflight: typeof fetch = (async () =>
      new Response(JSON.stringify({ readiness_card: { decision: "warn", trust_score: 45, seller_wallet: "S2" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    let paidHeaders: Headers | undefined;
    const x402Fetch: typeof fetch = (async (_url: unknown, init?: { headers?: RequestInit["headers"] }) => {
      paidHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ charged: true, tx: "TX2", twzrd_receipt: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await evaluate_x402_resource(
      "https://merchant/paid",
      { payTo: "S2", maxAmountRequired: "50000", resource: "https://merchant/paid", network: "solana" },
      { autoReceipt: true, x402Fetch, fetch: noIdPreflight, preflightMinScore: 0 },
    );
    assert.equal(paidHeaders?.get("x-twzrd-preflight-id"), null, "no preflight_id -> header omitted, no crash");
  }

  console.log("attribution.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("attribution.test.ts FAILED:", e);
  process.exit(1);
});
