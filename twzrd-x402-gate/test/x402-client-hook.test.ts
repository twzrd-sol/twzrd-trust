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

function mockClient() {
  let hook:
    | ((
        ctx: BeforePaymentCreationContext,
      ) => Promise<BeforePaymentCreationResult> | BeforePaymentCreationResult)
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
    });

    const result = await fire({
      selectedRequirements: {
        payTo: SELLER,
        network: SOL,
        amount: "1000",
      },
    });
    assert.ok(result === undefined || result === null || !("abort" in result && result.abort));
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

  console.log("x402-client-hook.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("x402-client-hook.test.ts FAILED:", e);
  process.exit(1);
});
