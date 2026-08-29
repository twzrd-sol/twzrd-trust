/**
 * Consumer compile + runtime compatibility against the OFFICIAL x402 packages.
 *
 * Every other hook test exercises a local mock of X402ClientLike. This one
 * imports the real x402Client — the exact import AgentKit uses — and proves:
 *
 *   1. COMPILE: a real `new x402Client()` satisfies X402ClientLike, so
 *      installTwzrdX402ClientHook(client, ...) typechecks for a strict-TS
 *      consumer. This is the regression this file exists to catch: a sync
 *      return branch or an `{ abort: false }` variant in our structural hook
 *      type makes the real client unassignable under strictFunctionTypes,
 *      and nothing else in the suite compiles against the real packages.
 *   2. RUNTIME: the gate hook fires inside client.createPaymentPayload() —
 *      a block aborts BEFORE any scheme payload is built; an allow proceeds
 *      into the registered scheme.
 *   3. COMPOSITION: wrapFetchWithPayment(fetch, client) accepts the hooked
 *      client (the AgentKit call shape).
 *   4. MULTI-HOOK ORDER: official client runs beforePaymentCreation hooks in
 *      registration order; first abort short-circuits later hooks and the
 *      scheme (amount-cap-before-TWZRD dogfood composition is load-bearing).
 *   5. BINDING: selectedRequirements seen by the scheme match the selected
 *      challenge the hooks evaluated (no mutation / swap).
 *
 * Fully offline: the gate's fetch is stubbed and the scheme client is a
 * local fake that records the call and throws before touching a wallet.
 *
 * Run: npx tsx test/x402-official-compat.test.ts
 */
import assert from "node:assert/strict";

import { x402Version } from "@x402/core";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

import { installTwzrdX402ClientHook } from "../src/x402-client-hook.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// CAIP-2 mainnet id — satisfies the official `${string}:${string}` Network type uncast
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAX_AMOUNT_MICRO = 1000n;

function paymentRequired(amount = "1000"): PaymentRequired {
  return {
    x402Version,
    resource: { url: "https://merchant.example/paid" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: USDC,
        amount,
        payTo: SELLER,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
}

function gateFetch(card: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/** Fake scheme: records the call, then stops before any wallet interaction. */
function fakeScheme(
  onCall: (selected: { payTo?: string; amount?: string; network?: string }) => void,
): SchemeNetworkClient {
  return {
    scheme: "exact",
    async createPaymentPayload(_version: number, requirements: { payTo?: string; amount?: string; network?: string }) {
      onCall({
        payTo: requirements.payTo,
        amount: requirements.amount,
        network: requirements.network,
      });
      throw new Error("fake-scheme-stop");
    },
  };
}

async function main() {
  // 1. Block: gate abort surfaces through the REAL client before the scheme runs
  {
    const client = new x402Client();
    let schemeCalled = false;
    client.register(
      NETWORK,
      fakeScheme(() => {
        schemeCalled = true;
      }),
    );
    const returned = installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: gateFetch({
        decision: "warn",
        can_spend: false,
        trust_score: 56,
        seller_wallet: SELLER,
      }),
    });
    // install is chainable and hands back the same client
    assert.equal(returned, client);

    // Exact reason: distinguishes a genuine can_spend block from the
    // fail-closed abort a broken gate fetch would also produce.
    await assert.rejects(
      client.createPaymentPayload(paymentRequired()),
      /Payment creation aborted: \[twzrd\] twzrd_can_spend_false/,
    );
    assert.equal(schemeCalled, false, "abort must precede payload construction");
  }

  // 2. Allow: hook runs, does not abort, real client proceeds into the scheme
  {
    const client = new x402Client();
    let schemeCalled = false;
    let schemeSaw: { payTo?: string; amount?: string; network?: string } | undefined;
    client.register(
      NETWORK,
      fakeScheme((sel) => {
        schemeCalled = true;
        schemeSaw = sel;
      }),
    );
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: gateFetch({
        decision: "allow",
        can_spend: true,
        trust_score: 90,
        seller_wallet: SELLER,
      }),
    });

    await assert.rejects(client.createPaymentPayload(paymentRequired()), /fake-scheme-stop/);
    assert.equal(schemeCalled, true, "allow must reach the scheme client");
    assert.equal(schemeSaw?.payTo, SELLER);
    assert.equal(schemeSaw?.amount, "1000");
    assert.equal(schemeSaw?.network, NETWORK);
  }

  // 3. Composition: the hooked client still satisfies wrapFetchWithPayment
  {
    const client = new x402Client();
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      fetch: gateFetch({ decision: "allow", can_spend: true, seller_wallet: SELLER }),
    });
    const paidFetch = wrapFetchWithPayment(fetch, client);
    assert.equal(typeof paidFetch, "function");
  }

  // 4. MULTI-HOOK: registration order, every hook runs on allow, abort short-circuits
  {
    const order: string[] = [];
    const client = new x402Client();
    let schemeCalled = false;
    client.register(
      NETWORK,
      fakeScheme(() => {
        schemeCalled = true;
        order.push("scheme");
      }),
    );

    // Same composition as official-x402-dogfood: amount cap first, then TWZRD
    client.onBeforePaymentCreation(async (context) => {
      order.push("amount_cap");
      const req = context.selectedRequirements ?? {};
      const amount = BigInt(String(req.amount ?? "0"));
      if (amount > MAX_AMOUNT_MICRO) {
        return {
          abort: true,
          reason: `dogfood hard cap: amount ${amount} > ${MAX_AMOUNT_MICRO}`,
        };
      }
    });

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: gateFetch({
        decision: "allow",
        can_spend: true,
        trust_score: 90,
        seller_wallet: SELLER,
      }),
      onDecision: () => {
        order.push("twzrd");
      },
    });

    // 4a. Allow under cap: both hooks run (registration order), then scheme
    await assert.rejects(client.createPaymentPayload(paymentRequired("1000")), /fake-scheme-stop/);
    assert.deepEqual(order, ["amount_cap", "twzrd", "scheme"]);
    assert.equal(schemeCalled, true);
  }

  {
    // 4b. Over cap: amount-cap aborts; TWZRD and scheme must NOT run
    const order: string[] = [];
    const client = new x402Client();
    let schemeCalled = false;
    let twzrdFetchCalled = false;
    client.register(
      NETWORK,
      fakeScheme(() => {
        schemeCalled = true;
        order.push("scheme");
      }),
    );

    client.onBeforePaymentCreation(async (context) => {
      order.push("amount_cap");
      const req = context.selectedRequirements ?? {};
      const amount = BigInt(String(req.amount ?? "0"));
      if (amount > MAX_AMOUNT_MICRO) {
        return {
          abort: true,
          reason: `dogfood hard cap: amount ${amount} > ${MAX_AMOUNT_MICRO}`,
        };
      }
    });

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: (async () => {
        twzrdFetchCalled = true;
        return new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              can_spend: true,
              trust_score: 90,
              seller_wallet: SELLER,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
      onDecision: () => {
        order.push("twzrd");
      },
    });

    await assert.rejects(
      client.createPaymentPayload(paymentRequired("500000")),
      /Payment creation aborted: dogfood hard cap/,
    );
    assert.deepEqual(order, ["amount_cap"]);
    assert.equal(schemeCalled, false, "scheme must not run after abort");
    assert.equal(twzrdFetchCalled, false, "later hooks must not run after abort");
  }

  {
    // 4c. Under cap but TWZRD blocks: amount_cap runs, twzrd runs, scheme does not
    const order: string[] = [];
    const client = new x402Client();
    let schemeCalled = false;
    client.register(
      NETWORK,
      fakeScheme(() => {
        schemeCalled = true;
        order.push("scheme");
      }),
    );

    client.onBeforePaymentCreation(async () => {
      order.push("amount_cap");
    });

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: gateFetch({
        decision: "warn",
        can_spend: false,
        trust_score: 56,
        seller_wallet: SELLER,
      }),
      onDecision: () => {
        order.push("twzrd");
      },
    });

    await assert.rejects(
      client.createPaymentPayload(paymentRequired("1000")),
      /Payment creation aborted: \[twzrd\] twzrd_can_spend_false/,
    );
    assert.deepEqual(order, ["amount_cap", "twzrd"]);
    assert.equal(schemeCalled, false);
  }

  console.log("x402-official-compat: OK (client ^" + String(x402Version) + ")");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
