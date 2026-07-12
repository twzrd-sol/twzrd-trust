/**
 * safeFetch unit tests (no real AgentCash pay).
 * Run: npx tsx test/safe-fetch.test.ts
 */
import assert from "node:assert/strict";

import { safeFetch } from "../src/safe-fetch.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PLATFORM = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";

function merchant402(payTo = PLATFORM, network = SOL): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        accepts: [
          { network: "eip155:8453", payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b", amount: "1000" },
          { network, payTo, amount: "1000" },
        ],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function preflight(card: unknown): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.includes("/preflight")) {
      return new Response(JSON.stringify({ readiness_card: card }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // merchant 402 path uses separate raw fetch in tests
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
}

async function run() {
  // 1. Blocked: can_spend false — never invokes payer
  {
    let payerCalls = 0;
    const raw = merchant402();
    const r = await safeFetch({
      url: "https://merchant.example/paid",
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: (async (input, init) => {
        const u = String(input);
        if (u.includes("/preflight")) {
          return preflight({
            decision: "warn",
            can_spend: false,
            trust_score: 56,
            seller_wallet: PLATFORM,
          })(input, init);
        }
        return raw(input, init);
      }) as typeof fetch,
      runPayer: async () => {
        payerCalls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(r.phase, "blocked");
    assert.equal(r.ok, false);
    assert.equal(payerCalls, 0);
    assert.equal(r.requirementScoredMatchesRequirementSigned, false);
    assert.equal(r.cliSecurityClassification, "advisory_precheck");
    assert.equal(r.targetRequestCount, 1);
    assert.ok(r.eventOrder.indexOf("twzrd_preflight_result") < r.eventOrder.indexOf("payment_blocked") || r.eventOrder.includes("payment_blocked"));
    assert.ok(r.eventOrder.includes("initial_402_receipt"));
    assert.ok(
      r.eventOrder.indexOf("initial_402_receipt") <
        r.eventOrder.indexOf("twzrd_preflight_start"),
    );
  }

  // 2. Dry-run allow — preflight passes, no payer
  {
    let payerCalls = 0;
    const raw = merchant402();
    const r = await safeFetch({
      url: "https://merchant.example/paid",
      dryRun: true,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: (async (input, init) => {
        if (String(input).includes("/preflight")) {
          return preflight({
            decision: "allow",
            can_spend: true,
            trust_score: 90,
            seller_wallet: PLATFORM,
          })(input, init);
        }
        return raw(input, init);
      }) as typeof fetch,
      runPayer: async () => {
        payerCalls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(r.phase, "dry_run_allowed");
    assert.equal(r.ok, true);
    assert.equal(payerCalls, 0);
    assert.ok(r.eventOrder.includes("dry_run_stop_before_pay"));
  }

  // 3. Allowed pay — payer once after preflight
  {
    let payerCalls = 0;
    const order: string[] = [];
    const raw = merchant402();
    const r = await safeFetch({
      url: "https://merchant.example/paid",
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: (async (input, init) => {
        if (String(input).includes("/preflight")) {
          return preflight({
            decision: "allow",
            can_spend: true,
            trust_score: 90,
            seller_wallet: PLATFORM,
          })(input, init);
        }
        return raw(input, init);
      }) as typeof fetch,
      runPayer: async () => {
        payerCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ paid: true, ok: true }),
          stderr: "",
        };
      },
      onEvent: (e) => order.push(e),
    });
    assert.equal(r.phase, "paid");
    assert.equal(payerCalls, 1);
    assert.ok(order.indexOf("twzrd_preflight_result") < order.indexOf("payer_invoke_start"));
    assert.equal(r.requirementScoredMatchesRequirementSigned, false);
    assert.equal(r.targetRequestCount, 2);
    assert.equal(r.cliSecurityClassification, "advisory_precheck");
  }

  // 4. Base-only strict — block without payer
  {
    let payerCalls = 0;
    const r = await safeFetch({
      url: "https://merchant.example/base",
      unsupportedNetworkMode: "strict",
      refuseWashFlagged: false,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            accepts: [
              {
                network: "eip155:8453",
                payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
                amount: "1000",
              },
            ],
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      runPayer: async () => {
        payerCalls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(r.phase, "blocked");
    assert.equal(r.approval?.verdict, "unknown");
    assert.equal(payerCalls, 0);
  }

  // 5. Non-402 passthrough
  {
    let payerCalls = 0;
    const r = await safeFetch({
      url: "https://example.com/free",
      fetch: (async () =>
        new Response(JSON.stringify({ hello: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      runPayer: async () => {
        payerCalls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(r.phase, "passthrough");
    assert.equal(payerCalls, 0);
  }

  console.log("safe-fetch.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("safe-fetch.test.ts FAILED:", e);
  process.exit(1);
});
