#!/usr/bin/env -S npx tsx
/**
 * PayKit seat proof: onBeforeX402PaymentCreation abort → signer never called.
 *
 * Mirrors Foundation pay-kit #303 (`createPayKitClient({
 *   onBeforeX402PaymentCreation })`) without a hard dependency on unpublished
 * `@solana/pay-kit`. The fake client only proves option passthrough:
 *   402 select → hook({ selectedRequirements }) → { abort: true, reason }
 *   → throw "Payment creation aborted: …" → signTransactions never runs.
 *
 * If `@solana/pay-kit` is installed AND exports the option, the same hook
 * is the value you pass. TWZRD stays in the caller — no branding in pay-kit.
 *
 *   npm run pay-kit-before-payment
 *
 * Env:
 *   TWZRD_INTEL_BASE   unused here (injected wash card, no network)
 */
import {
  createTwzrdPayKitBeforePaymentHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
} from "../src/x402-client-hook.js";

const WASH_SELLER = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const RESOURCE = "https://merchant.example/wash-paid";

type BeforePaymentCreationHook = (
  context: BeforePaymentCreationContext,
) => Promise<BeforePaymentCreationResult>;

/**
 * Minimal fake of createPayKitClient after #303. Real callers swap this for
 * `import { createPayKitClient } from "@solana/pay-kit"` once the option ships.
 */
function createPayKitClient(options: {
  accept?: readonly string[];
  onBeforeX402PaymentCreation?: BeforePaymentCreationHook;
  signTransactions: () => Promise<void>;
}): {
  fetch: (url: string) => Promise<Response>;
} {
  const hook = options.onBeforeX402PaymentCreation;
  return {
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
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
}

function washIntelFetch(): typeof fetch {
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

async function main() {
  let signerInvocations = 0;
  // Same seat: installTwzrdAutoGate("pay-kit", { refuseWashFlagged: true })
  const onBeforeX402PaymentCreation = createTwzrdPayKitBeforePaymentHook({
    refuseWashFlagged: true,
    gateOnCanSpend: false,
    preflightMinScore: 0,
    failOpen: true,
    fetch: washIntelFetch(),
  });

  const client = createPayKitClient({
    accept: ["x402"],
    onBeforeX402PaymentCreation,
    signTransactions: async () => {
      signerInvocations += 1;
    },
  });

  let aborted = false;
  let reason: string | null = null;
  try {
    await client.fetch(RESOURCE);
  } catch (err) {
    aborted = true;
    reason = err instanceof Error ? err.message : String(err);
  }

  const proof = {
    seat: "pay-kit",
    wire: "createPayKitClient({ onBeforeX402PaymentCreation: createTwzrdPayKitBeforePaymentHook(...) })",
    aborted,
    reason,
    signer_invocation_count: signerInvocations,
    usdc_spent: 0,
  };
  console.log(JSON.stringify(proof, null, 2));

  if (!aborted || signerInvocations !== 0) {
    console.error("pay-kit-before-payment: expected abort with zero signer calls");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
