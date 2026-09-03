/**
 * PayKit onBeforeX402PaymentCreation seat — wash refuse, signer never called.
 *
 * Proves createTwzrdPayKitBeforePaymentHook / installTwzrdAutoGate("pay-kit")
 * return the official @x402/core BeforePaymentCreationHook (context-shaped)
 * that PayKit #303 registers via createPayKitClient({
 *   onBeforeX402PaymentCreation,
 * }). Abort → { abort: true, reason }; signer_invocation_count = 0.
 *
 * No hard dependency on unpublished @solana/pay-kit — the fake client only
 * proves option passthrough + abort-before-sign, matching PR #303.
 *
 * Run: npx tsx test/pay-kit-before-payment.test.ts
 */
import assert from "node:assert/strict";

import {
  createTwzrdPayKitBeforePaymentHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
} from "../src/x402-client-hook.js";
import { installTwzrdAutoGate } from "../src/auto-gate.js";

const WASH_SELLER = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const RESOURCE = "https://merchant.example/wash-paid";

function routedFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/merchant_card/")) {
      return new Response(
        JSON.stringify({
          wash_flagged: true,
          provider_reputation_tier: "tier_tail",
          in_corpus: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        readiness_card: {
          decision: "warn",
          trust_score: 45,
          can_spend: true,
          recommended_cap_usdc: 0.05,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

type BeforePaymentCreationHook = (
  context: BeforePaymentCreationContext,
) => Promise<BeforePaymentCreationResult>;

/**
 * Minimal fake of PayKit #303: createPayKitClient stores
 * onBeforeX402PaymentCreation and fires it after 402 selection, before
 * signTransactions. Abort throws; proceed signs. No @solana/pay-kit import.
 */
function createPayKitClient(options: {
  onBeforeX402PaymentCreation?: BeforePaymentCreationHook;
  signTransactions: () => Promise<void>;
}): {
  onBeforeX402PaymentCreation?: BeforePaymentCreationHook;
  fetch: (url: string) => Promise<{ status: number }>;
} {
  const hook = options.onBeforeX402PaymentCreation;
  return {
    onBeforeX402PaymentCreation: hook,
    async fetch(url: string) {
      const context: BeforePaymentCreationContext = {
        selectedRequirements: {
          payTo: WASH_SELLER,
          network: "solana",
          amount: "50000",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          resource: url,
          scheme: "exact",
        },
        paymentRequired: { resource: { url } },
      };
      const decision = hook ? await hook(context) : undefined;
      if (decision && decision.abort === true) {
        throw new Error(`Payment creation aborted: ${decision.reason}`);
      }
      await options.signTransactions();
      return { status: 200 };
    },
  };
}

const GATE_OPTS = {
  refuseWashFlagged: true,
  gateOnCanSpend: false,
  preflightMinScore: 0,
  failOpen: true,
  fetch: routedFetch(),
} as const;

async function run() {
  // --- factory: wash → abort object, signer never called ---
  {
    let signerInvocations = 0;
    const hook = createTwzrdPayKitBeforePaymentHook(GATE_OPTS);
    const client = createPayKitClient({
      onBeforeX402PaymentCreation: hook,
      signTransactions: async () => {
        signerInvocations += 1;
      },
    });

    assert.equal(
      client.onBeforeX402PaymentCreation,
      hook,
      "PayKit option must receive the TWZRD hook by reference",
    );

    await assert.rejects(
      () => client.fetch(RESOURCE),
      /Payment creation aborted:.*(?:twzrd_wash_flagged|wash)/i,
    );
    assert.equal(signerInvocations, 0, "abort must not invoke signTransactions");
  }

  // --- installTwzrdAutoGate("pay-kit") is the same official-context seat ---
  {
    let signerInvocations = 0;
    const hook = installTwzrdAutoGate("pay-kit", GATE_OPTS);
    const client = createPayKitClient({
      onBeforeX402PaymentCreation: hook,
      signTransactions: async () => {
        signerInvocations += 1;
      },
    });

    await assert.rejects(() => client.fetch(RESOURCE), /Payment creation aborted:/);
    assert.equal(signerInvocations, 0);
  }

  // --- disabled seat proceeds (signer would run) ---
  {
    let signerInvocations = 0;
    const hook = installTwzrdAutoGate("pay-kit", { ...GATE_OPTS, disabled: true });
    const client = createPayKitClient({
      onBeforeX402PaymentCreation: hook,
      signTransactions: async () => {
        signerInvocations += 1;
      },
    });
    const resp = await client.fetch(RESOURCE);
    assert.equal(resp.status, 200);
    assert.equal(signerInvocations, 1, "disabled seat must not gate");
  }

  // --- clean allow must proceed ---
  {
    const cleanFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/intel/merchant_card/")) {
        return new Response(
          JSON.stringify({ wash_flagged: false, in_corpus: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          readiness_card: {
            decision: "allow",
            trust_score: 80,
            can_spend: true,
            recommended_cap_usdc: 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    let signerInvocations = 0;
    const hook = createTwzrdPayKitBeforePaymentHook({
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: cleanFetch,
    });
    const client = createPayKitClient({
      onBeforeX402PaymentCreation: hook,
      signTransactions: async () => {
        signerInvocations += 1;
      },
    });
    const resp = await client.fetch("https://merchant.example/clean");
    assert.equal(resp.status, 200);
    assert.equal(signerInvocations, 1);
  }

  // --- env kill switch is re-read per call (same as x402-solana / MPP) ---
  {
    const hook = installTwzrdAutoGate("pay-kit", GATE_OPTS);
    const ctx: BeforePaymentCreationContext = {
      selectedRequirements: {
        payTo: WASH_SELLER,
        network: "solana",
        amount: "50000",
        resource: RESOURCE,
      },
    };
    const before = await hook(ctx);
    assert.ok(before && before.abort === true, "precondition: seat gates wash");

    process.env.TWZRD_AUTO_GATE = "0";
    try {
      assert.equal(
        await hook(ctx),
        undefined,
        "pay-kit seat must honour TWZRD_AUTO_GATE per call",
      );
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
    const after = await hook(ctx);
    assert.ok(after && after.abort === true, "clearing the switch re-arms the seat");
  }

  console.log("pay-kit-before-payment.test.ts: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
