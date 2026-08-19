/**
 * Buyer Path A defaults — install surfaces only, refuse-only stays free.
 * Run: npx tsx test/buyer-defaults.test.ts
 */
import assert from "node:assert/strict";

import {
  DEFAULT_BUYER_MATERIAL_USDC,
  resolveBuyerPathADefaults,
} from "../src/buyer-defaults.js";
import {
  resolveRequireReceiptPolicy,
  shouldRequirePathAReceipt,
} from "../src/receipt-policy.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { evaluateBeforePaymentCreation } from "../src/x402-client-hook.js";
import { installTwzrdAutoGate } from "../src/auto-gate.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";

function preflight(decision: "allow" | "warn" | "block", score = 45): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        readiness_card: { decision, trust_score: score, can_spend: decision !== "block" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function payingMock(pathHint: string) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes("/v1/intel/quick/")) {
      return new Response(
        JSON.stringify({ pubkey: SELLER, tier: "Silver", score: 82, paid: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        tx: "TX_PATH_A",
        twzrd_receipt: { version: 6, preimage: { settlement_tx: "TX_PATH_A" } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch & { calls: string[] };
  (fn as { calls: string[] }).calls = calls;
  void pathHint;
  return fn as typeof fetch & { calls: string[] };
}

function reqs(micro: string) {
  return {
    payTo: SELLER,
    maxAmountRequired: micro,
    amount: micro,
    resource: "https://seller.example/paid",
    network: "solana",
  };
}

async function run() {
  assert.equal(DEFAULT_BUYER_MATERIAL_USDC, 2.5);

  // No x402Fetch → no defaults (refuse-only).
  {
    const d = resolveBuyerPathADefaults({});
    assert.equal(d.requireReceipt, undefined);
    assert.equal(d.escalateOnWarn, undefined);
  }

  // x402Fetch present → both flags default on.
  {
    const x402 = payingMock("defaults");
    const d = resolveBuyerPathADefaults({ x402Fetch: x402 });
    assert.ok(d.requireReceipt && typeof d.requireReceipt === "object");
    const receipt = d.requireReceipt;
    assert.equal(receipt.materialWarnOnly, true);
    assert.equal(receipt.minSpendUsdc, 2.5);
    assert.equal(typeof d.escalateOnWarn, "object");
  }

  // Explicit false is an opt-out.
  {
    const x402 = payingMock("optout");
    const d = resolveBuyerPathADefaults({
      x402Fetch: x402,
      requireReceipt: false,
      escalateOnWarn: false,
    });
    assert.equal(d.requireReceipt, false);
    assert.equal(d.escalateOnWarn, false);
  }

  // materialWarnOnly: warn at $0.05 does not require Path A; warn at $3 does.
  {
    const policy = resolveRequireReceiptPolicy({
      minSpendUsdc: 2.5,
      onWarn: true,
      hard: true,
      materialWarnOnly: true,
    })!;
    assert.equal(
      shouldRequirePathAReceipt({ policy, decision: "warn", priceUsdc: 0.05 }),
      false,
    );
    assert.equal(
      shouldRequirePathAReceipt({ policy, decision: "warn", priceUsdc: 3 }),
      true,
    );
    assert.equal(
      shouldRequirePathAReceipt({ policy, decision: "allow", priceUsdc: 3 }),
      true,
    );
    assert.equal(
      shouldRequirePathAReceipt({ policy, decision: "block", priceUsdc: 100 }),
      false,
    );
  }

  // evaluate: both flags set — material warn hits $0.05 trust, not $0.001 quick.
  {
    const x402 = payingMock("material");
    const r = await evaluate_x402_resource("https://seller.example/paid", reqs("3000000"), {
      fetch: preflight("warn"),
      requireReceipt: {
        minSpendUsdc: 2.5,
        onWarn: true,
        hard: true,
        materialWarnOnly: true,
      },
      escalateOnWarn: { minSpendUsdc: 0 },
      x402Fetch: x402,
      refuseWashFlagged: false,
      preflightMinScore: 0,
    });
    assert.equal(x402.calls.length, 1);
    assert.match(x402.calls[0], /\/v1\/intel\/trust\//);
    assert.equal(r.receiptRequired, true);
    assert.equal(r.escalated, undefined);
    assert.equal(r.approved, true);
  }

  // evaluate: both flags set — sub-material warn hits $0.001 quick, not trust.
  {
    const x402 = payingMock("sub");
    const r = await evaluate_x402_resource("https://seller.example/paid", reqs("50000"), {
      fetch: preflight("warn"),
      requireReceipt: {
        minSpendUsdc: 2.5,
        onWarn: true,
        hard: true,
        materialWarnOnly: true,
      },
      escalateOnWarn: { minSpendUsdc: 0 },
      x402Fetch: x402,
      refuseWashFlagged: false,
      preflightMinScore: 0,
    });
    assert.equal(x402.calls.length, 1);
    assert.match(x402.calls[0], /\/v1\/intel\/quick\//);
    assert.equal(r.escalated, true);
    assert.equal(r.receiptRequired, undefined);
    assert.equal(r.approved, true);
  }

  // evaluate stays opt-in: x402Fetch without flags still spends nothing.
  {
    const x402 = payingMock("evaluate-optin");
    const r = await evaluate_x402_resource("https://seller.example/paid", reqs("3000000"), {
      fetch: preflight("warn"),
      x402Fetch: x402,
      refuseWashFlagged: false,
      preflightMinScore: 0,
    });
    assert.equal(x402.calls.length, 0);
    assert.equal(r.approved, true);
  }

  // withTwzrdGuard: x402Fetch present → defaults fire $0.001 on $0.05 warn.
  {
    const x402 = payingMock("guard");
    const resourceFetch = (async () =>
      new Response(
        JSON.stringify({
          accepts: [
            {
              payTo: SELLER,
              maxAmountRequired: "50000",
              network: "solana",
              resource: "https://seller.example/paid",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const guarded = withTwzrdGuard(resourceFetch, {
      fetch: preflight("warn"),
      x402Fetch: x402,
      refuseWashFlagged: false,
      preflightMinScore: 0,
    });
    const resp = await guarded("https://seller.example/paid");
    assert.equal(resp.status, 402);
    assert.equal(x402.calls.length, 1);
    assert.match(x402.calls[0], /\/v1\/intel\/quick\//);
  }

  // installTwzrdAutoGate(payWrap) auto-wires x402Fetch from payWrap(raw).
  {
    const payCalls: string[] = [];
    const payWrap = (inner: typeof fetch) => {
      return (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/v1/intel/")) {
          payCalls.push(u);
          return new Response(
            JSON.stringify({ pubkey: SELLER, score: 82, paid: true }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return inner(url, init);
      }) as unknown as typeof fetch;
    };
    const resourceFetch = (async () =>
      new Response(
        JSON.stringify({
          accepts: [
            {
              payTo: SELLER,
              maxAmountRequired: "50000",
              network: "solana",
              resource: "https://seller.example/paid",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const paying = installTwzrdAutoGate(payWrap, {
      rawFetch: resourceFetch,
      fetch: preflight("warn"),
      refuseWashFlagged: false,
      preflightMinScore: 0,
    });
    const resp = await paying("https://seller.example/paid");
    assert.equal(resp.status, 402);
    assert.ok(
      payCalls.some((u) => u.includes("/v1/intel/quick/")),
      `payWrap should have settled Path A/quick, got ${JSON.stringify(payCalls)}`,
    );
  }

  // Hook: no x402Fetch → refuse-only, warn proceeds.
  {
    const result = await evaluateBeforePaymentCreation(
      {
        payTo: SELLER,
        network: "solana",
        amount: "3000000",
        resource: "https://seller.example/paid",
      },
      {
        fetch: preflight("warn"),
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(result, undefined);
  }

  // Hook: x402Fetch + material warn → $0.05 trust.
  {
    const x402 = payingMock("hook");
    const result = await evaluateBeforePaymentCreation(
      {
        payTo: SELLER,
        network: "solana",
        amount: "3000000",
        resource: "https://seller.example/paid",
      },
      {
        fetch: preflight("warn"),
        x402Fetch: x402,
        refuseWashFlagged: false,
        preflightMinScore: 0,
      },
    );
    assert.equal(result, undefined);
    assert.equal(x402.calls.length, 1);
    assert.match(x402.calls[0], /\/v1\/intel\/trust\//);
  }

  console.log("buyer-defaults.test.ts: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
