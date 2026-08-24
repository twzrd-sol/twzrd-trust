/**
 * Official x402Client onBeforePaymentCreation adapter.
 * Run: npx tsx test/x402-client-hook.test.ts
 */
import assert from "node:assert/strict";

import {
  installTwzrdX402ClientHook,
  twzrdBeforePaymentCreation,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import { CLIENT_VERSION } from "../src/version.js";

function mockClient() {
  let hook:
    | ((
        ctx: BeforePaymentCreationContext,
      ) => Promise<BeforePaymentCreationResult>)
    | undefined;
  const client: X402ClientLike = {
    onBeforePaymentCreation(h) {
      hook = h;
      return client;
    },
  };
  return {
    client,
    async fire(ctx: BeforePaymentCreationContext) {
      if (!hook) throw new Error("hook not installed");
      return hook(ctx);
    },
  };
}

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";

async function run() {
  // 1. Block: can_spend false — abort before payload
  {
    const { client, fire } = mockClient();
    let decisions = 0;
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            readiness_card: {
              decision: "warn",
              can_spend: false,
              trust_score: 56,
              seller_wallet: SELLER,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      onDecision: () => {
        decisions += 1;
      },
    });

    const result = await fire({
      selectedRequirements: {
        payTo: SELLER,
        network: SOL,
        amount: "1000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        resource: "https://merchant.example/paid",
      },
    });
    assert.ok(result && "abort" in result && result.abort === true);
    assert.match(String((result as { reason: string }).reason), /can_spend|twzrd/);
    assert.equal(decisions, 1);
  }

  // 2. Allow: void / no abort — same selectedRequirements proceed to sign
  {
    const { client, fire } = mockClient();
    const req = {
      payTo: SELLER,
      network: SOL,
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      resource: "https://merchant.example/paid?b=2&a=1#x",
    };
    let bind: { strength?: string; extra_stamped?: boolean } | undefined;
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              can_spend: true,
              trust_score: 90,
              seller_wallet: SELLER,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      onDecision: (d) => {
        bind = d.resourceBind;
      },
    });
    const result = await fire({ selectedRequirements: req });
    assert.ok(result === undefined || result === null || !("abort" in result && result.abort));
    assert.equal(bind?.strength, "soft");
    assert.equal(bind?.extra_stamped, true);
    assert.equal(typeof (req as { extra?: { twzrd_resource_bind?: string } }).extra?.twzrd_resource_bind, "string");
  }

  // 2b. x402 v2: no resource on accepts[], URL on envelope resource.url
  {
    const { client, fire } = mockClient();
    const req: Record<string, unknown> = {
      payTo: SELLER,
      network: SOL,
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const url = "https://intel.twzrd.xyz/v1/intel/quick/35ramn32ufUApgbcgopVe5muHqNftHN1L3BfBNsDzGsx";
    let bind: { strength?: string; extra_stamped?: boolean; leaf_hash?: string | null } | undefined;
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              can_spend: true,
              trust_score: 90,
              seller_wallet: SELLER,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      onDecision: (d) => {
        bind = d.resourceBind;
      },
    });
    const result = await fire({
      selectedRequirements: req,
      paymentRequired: { x402Version: 2, resource: { url }, accepts: [req] },
    });
    assert.ok(result === undefined || result === null || !("abort" in result && result.abort));
    assert.equal(req.resource, url);
    assert.equal(bind?.strength, "soft");
    assert.equal(bind?.extra_stamped, true);
    assert.equal(typeof req.extra, "object");
    assert.equal(typeof (req.extra as { twzrd_resource_bind?: string })?.twzrd_resource_bind, "string");
    assert.ok(String((req.extra as { memo?: string }).memo ?? "").startsWith("rb1:"));
  }

  // 3. Base unscored strict — abort without Solana preflight score
  {
    const result = await twzrdBeforePaymentCreation(
      {
        payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
        network: "eip155:8453",
        amount: "1000",
      },
      {
        unsupportedNetworkMode: "strict",
        fetch: (async () => {
          throw new Error("preflight must not run");
        }) as typeof fetch,
      },
    );
    assert.ok(result && "abort" in result && result.abort === true);
    assert.match(String((result as { reason: string }).reason), /network_not_scored/);
  }

  // 3b. Standalone parity: twzrdBeforePaymentCreation fires onDecision (same as install)
  {
    let decisions = 0;
    let lastReason = "";
    const result = await twzrdBeforePaymentCreation(
      {
        payTo: SELLER,
        network: SOL,
        amount: "1000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      {
        gateOnCanSpend: true,
        refuseWashFlagged: false,
        fetch: (async () =>
          new Response(
            JSON.stringify({
              readiness_card: {
                decision: "warn",
                can_spend: false,
                trust_score: 56,
                seller_wallet: SELLER,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
        onDecision: (d) => {
          decisions += 1;
          lastReason = d.reason;
        },
      },
    );
    assert.ok(result && "abort" in result && result.abort === true);
    assert.equal(decisions, 1, "standalone must surface onDecision");
    assert.match(lastReason, /can_spend|twzrd/);
  }

  // 4. Challenge identity: hook receives exact selectedRequirements (binding surface)
  {
    const { client, fire } = mockClient();
    let seenPayTo = "";
    let seenAmount = "";
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: (async (_input, init) => {
        const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
        seenPayTo = body.seller_wallet ?? "";
        // price_usdc from 500000 micro = 0.5
        return new Response(
          JSON.stringify({
            readiness_card: {
              decision: "block",
              can_spend: false,
              trust_score: 1,
              seller_wallet: body.seller_wallet,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    const selected = {
      payTo: "UNSAFE_SELLER_XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      network: SOL,
      amount: "500000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const result = await fire({ selectedRequirements: selected });
    assert.ok(result && "abort" in result && result.abort);
    // The requirement evaluated is the same object fields the client selected
    assert.equal(seenPayTo, selected.payTo);
    assert.equal(selected.amount, "500000");
    void seenAmount;
  }

  // 5. caller_id gap fix: Path A receipt fetch (GET /v1/intel/trust/{payTo}) now
  //    carries the same seat-identity pair preflight always stamps. This is the
  //    call that previously landed in x402_challenge_events with caller_id=NULL.
  {
    const { client, fire } = mockClient();
    let receiptHeaders: Headers | undefined;
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      requireReceipt: true, // onWarn default true -> receiptRequired on decision=warn
      fetch: (async () =>
        new Response(
          JSON.stringify({
            readiness_card: { decision: "warn", can_spend: true, trust_score: 50, seller_wallet: SELLER },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      x402Fetch: (async (_input, init) => {
        receiptHeaders = new Headers((init as { headers?: RequestInit["headers"] })?.headers);
        return new Response(JSON.stringify({ charged: true, tx: "TX_E2E", twzrd_receipt: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await fire({
      selectedRequirements: {
        payTo: SELLER,
        network: SOL,
        amount: "1000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        resource: "https://merchant.example/paid",
      },
    });

    assert.ok(receiptHeaders, "Path A receipt fetch fired");
    assert.equal(
      receiptHeaders!.get("x-twzrd-client"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "paid receipt fetch must stamp X-TWZRD-Client (previously unstamped)",
    );
    assert.equal(
      receiptHeaders!.get("x-twzrd-caller"),
      `twzrd-x402-gate/${CLIENT_VERSION}`,
      "paid receipt fetch must stamp X-Twzrd-Caller (previously unstamped)",
    );
  }

  console.log("x402-client-hook.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("x402-client-hook.test.ts FAILED:", e);
  process.exit(1);
});
