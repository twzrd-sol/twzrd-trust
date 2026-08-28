/**
 * S1: PayAI x402-solana beforePayment seat — wash refuse, signer never called.
 *
 * Proves createTwzrdBeforePaymentHook / installTwzrdAutoGate("x402-solana")
 * map requirements → shared evaluator and abort before any wallet sign.
 *
 * Run: npx tsx test/x402-solana-before-payment.test.ts
 */
import assert from "node:assert/strict";

import {
  createTwzrdBeforePaymentHook,
  flattenDeclaredResource,
  mapX402SolanaRequirements,
} from "../src/x402-client-hook.js";
import { installTwzrdAutoGate } from "../src/auto-gate.js";
import {
  buildAutogateBlockProof,
  AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1,
} from "../src/block-proof.js";
import { TWZRD_TRUST_GATE_BLOCK_WASH } from "../src/trust-gate-reason.js";

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

/**
 * Stock-client-shaped simulator: after 402 select → beforePayment → maybe sign.
 * Mirrors x402-solana@2.1.0 (string declaredResource) and @3.0.0 ({ url })
 * without a hard package dependency.
 */
async function stockClientPay(opts: {
  beforePayment: (
    requirements: Record<string, unknown>,
    context: {
      requestUrl: string;
      declaredResource?: string | { url?: string };
      protocolVersion: 1 | 2;
    },
  ) => Promise<void | { abort: true; reason?: string } | { abort?: false }>;
  requirements: Record<string, unknown>;
  requestUrl: string;
  declaredResource?: string | { url?: string };
  signTransaction: () => Promise<void>;
}): Promise<{ signed: boolean; abortReason?: string }> {
  const decision = await opts.beforePayment(opts.requirements, {
    requestUrl: opts.requestUrl,
    declaredResource: opts.declaredResource ?? opts.requestUrl,
    protocolVersion: 2,
  });
  if (decision && decision.abort === true) {
    return { signed: false, abortReason: decision.reason };
  }
  await opts.signTransaction();
  return { signed: true };
}

async function run() {
  // --- flatten: 2.1.0 string + 3.0.0 ResourceInfo ---
  {
    assert.equal(flattenDeclaredResource("https://s.example/r"), "https://s.example/r");
    assert.equal(
      flattenDeclaredResource({ url: "https://o.example/r", description: "paid" } as {
        url?: string;
      }),
      "https://o.example/r",
    );
    assert.equal(flattenDeclaredResource({ url: "" }), undefined);
    assert.equal(flattenDeclaredResource({}), undefined);
    assert.equal(flattenDeclaredResource(undefined), undefined);
  }

  // --- map: amount + resource fallbacks (2.1.0 string) ---
  {
    const mapped = mapX402SolanaRequirements(
      {
        payTo: WASH_SELLER,
        maxAmountRequired: "50000",
        network: "solana",
      },
      { requestUrl: RESOURCE, declaredResource: "https://declared.example/r" },
    );
    assert.equal(mapped.payTo, WASH_SELLER);
    assert.equal(mapped.amount, "50000");
    assert.equal(mapped.resource, "https://declared.example/r");
  }

  // --- map: 3.0.0 declaredResource { url } + requirements.resource object ---
  {
    const mappedCtx = mapX402SolanaRequirements(
      {
        payTo: WASH_SELLER,
        maxAmountRequired: "50000",
        network: "solana",
      },
      {
        requestUrl: RESOURCE,
        declaredResource: { url: "https://v2.example/paid" },
      },
    );
    assert.equal(mappedCtx.resource, "https://v2.example/paid");
    assert.notEqual(String(mappedCtx.resource), "[object Object]");

    const mappedReq = mapX402SolanaRequirements(
      {
        payTo: WASH_SELLER,
        amount: "1",
        network: "solana",
        resource: { url: "https://req.example/r" } as unknown as string,
      },
      {
        requestUrl: RESOURCE,
        declaredResource: { url: "https://declared-loses.example/r" },
      },
    );
    assert.equal(mappedReq.resource, "https://req.example/r");

    const mappedFallback = mapX402SolanaRequirements(
      { payTo: WASH_SELLER, amount: "1", network: "solana" },
      { requestUrl: RESOURCE, declaredResource: { url: "" } },
    );
    assert.equal(mappedFallback.resource, RESOURCE);
  }

  // --- createTwzrdBeforePaymentHook: wash → abort, signer_invocation_count=0 ---
  {
    let signerInvocations = 0;
    const beforePayment = createTwzrdBeforePaymentHook({
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: routedFetch(),
    });

    const outcome = await stockClientPay({
      beforePayment,
      requirements: {
        payTo: WASH_SELLER,
        network: "solana",
        amount: "50000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        scheme: "exact",
      },
      requestUrl: RESOURCE,
      signTransaction: async () => {
        signerInvocations += 1;
      },
    });

    assert.equal(outcome.signed, false, "must not reach signTransaction");
    assert.equal(signerInvocations, 0);
    assert.match(
      outcome.abortReason ?? "",
      /twzrd_wash_flagged|wash/i,
      `unexpected reason: ${outcome.abortReason}`,
    );

    const proof = buildAutogateBlockProof({
      run_id: "test-x402-solana-before-payment",
      target_seller: WASH_SELLER,
      aborted: true,
      internal_reason: outcome.abortReason ?? null,
      decision: "warn",
      wash_flagged: true,
      trust_score: 45,
      signer_invocations: signerInvocations,
      actual_spend_usdc: 0,
      onchain_settlements: 0,
      hook: "beforePayment",
      execution_mode: "x402-solana@2.1.0",
      x402_solana_version: "2.1.0",
      stock_seat_required: true,
    });
    assert.equal(proof.schema_version, AUTOGATE_BLOCK_PROOF_SCHEMA_V1_1);
    assert.equal(proof.interception.hook, "beforePayment");
    assert.equal(proof.interception.reason, TWZRD_TRUST_GATE_BLOCK_WASH);
    assert.equal(proof.interception.aborted, true);
    assert.equal(proof.invariants.signer_invocations, 0);
    assert.equal(proof.verified, true);
    assert.equal(proof.execution_mode, "x402-solana@2.1.0");
    assert.equal(proof.x402_solana_version, "2.1.0");
    assert.equal(proof.stock_seat_required, true);
  }

  // --- installTwzrdAutoGate("x402-solana") returns the same seat ---
  {
    let signerInvocations = 0;
    const beforePayment = installTwzrdAutoGate("x402-solana", {
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: routedFetch(),
    });

    const outcome = await stockClientPay({
      beforePayment,
      requirements: {
        payTo: WASH_SELLER,
        network: "solana",
        amount: "50000",
      },
      requestUrl: RESOURCE,
      signTransaction: async () => {
        signerInvocations += 1;
      },
    });
    assert.equal(outcome.signed, false);
    assert.equal(signerInvocations, 0);
  }

  // --- kill switch: disabled hook proceeds (signer would run) ---
  {
    let signerInvocations = 0;
    const beforePayment = installTwzrdAutoGate("x402-solana", {
      disabled: true,
      refuseWashFlagged: true,
      fetch: routedFetch(),
    });
    const outcome = await stockClientPay({
      beforePayment,
      requirements: {
        payTo: WASH_SELLER,
        network: "solana",
        amount: "50000",
      },
      requestUrl: RESOURCE,
      signTransaction: async () => {
        signerInvocations += 1;
      },
    });
    assert.equal(outcome.signed, true, "disabled seat must not gate");
    assert.equal(signerInvocations, 1);
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
    const liveReq: Record<string, unknown> = {
      payTo: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      network: "solana",
      amount: "1000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      resource: "https://merchant.example/clean",
    };
    const beforePayment = createTwzrdBeforePaymentHook({
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: cleanFetch,
    });
    const outcome = await stockClientPay({
      beforePayment,
      requirements: liveReq,
      requestUrl: "https://merchant.example/clean",
      signTransaction: async () => {
        signerInvocations += 1;
      },
    });
    assert.equal(outcome.signed, true);
    assert.equal(signerInvocations, 1);
    const extra = liveReq.extra as { memo?: string; twzrd_resource_bind?: string } | undefined;
    assert.equal(extra?.memo, undefined, "must not inject extra.memo (ExactSvm interop)");
    assert.equal(extra?.twzrd_resource_bind, undefined);
  }

  // --- 3.0.0 declaredResource { url }: wash abort, resource flattened, signer=0 ---
  {
    let signerInvocations = 0;
    let preflightResourceUrl: unknown;
    const inner = routedFetch();
    const fetchWithCapture = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/intel/preflight") && typeof init?.body === "string") {
        preflightResourceUrl = JSON.parse(init.body).resource_url;
      }
      return inner(input, init);
    }) as typeof fetch;
    const beforePayment = createTwzrdBeforePaymentHook({
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: fetchWithCapture,
    });

    const outcome = await stockClientPay({
      beforePayment,
      requirements: {
        payTo: WASH_SELLER,
        network: "solana",
        amount: "50000",
      },
      requestUrl: "https://caller.example/paid",
      declaredResource: { url: RESOURCE },
      signTransaction: async () => {
        signerInvocations += 1;
      },
    });

    assert.equal(outcome.signed, false, "3.0.0 object resource must still abort wash");
    assert.equal(signerInvocations, 0);
    assert.match(outcome.abortReason ?? "", /twzrd_wash_flagged|wash/i);
    assert.equal(preflightResourceUrl, RESOURCE);
  }

  // --- aborted signal never reaches sign ---
  {
    let signerInvocations = 0;
    const ac = new AbortController();
    ac.abort();
    const beforePayment = createTwzrdBeforePaymentHook({
      refuseWashFlagged: true,
      fetch: routedFetch(),
    });
    const decision = await beforePayment(
      { payTo: WASH_SELLER, amount: "1", network: "solana" },
      { requestUrl: RESOURCE, signal: ac.signal },
    );
    assert.ok(decision && decision.abort === true);
    assert.equal(signerInvocations, 0);
  }

  console.log("x402-solana-before-payment.test.ts: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
