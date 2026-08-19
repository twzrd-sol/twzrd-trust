/**
 * x402 client hook + TWZRD Payment Control binding (item 7).
 *
 * The policy runtime and assertIntentApproved are unit-tested in
 * payment-control.test.ts. This file proves the HOOK integration:
 *   - opt-in paymentControl issues a signed, intent-bound decision on approve,
 *   - a cooperating signer refuses a post-approval mutation (count 0),
 *   - local policy can only TIGHTEN the legacy gate,
 *   - consume-once holds across the sign boundary,
 *   - the x402 wire micro-amount is corrected to decimal USD before policy eval.
 *
 * Run: npx tsx test/intent-binding.test.ts
 */
import assert from "node:assert/strict";

import {
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import {
  assertIntentApproved,
  createDecisionRegistry,
  createLocalDecisionSigner,
  TwzrdIntentBindingError,
  type PaymentDecision,
} from "../src/decision-token.js";
import type { PaymentIntent } from "../src/intent.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const ATTACKER = "AtTaCkeRwaLLeT1111111111111111111111111111";
const T0 = 1_800_000_000_000;

function allowPreflight(): typeof fetch {
  return (async () =>
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
    )) as typeof fetch;
}

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

/** A signer that only runs when the sign-boundary guard passes. */
function makeGuardedSigner(publicKeyPem: string, registry?: ReturnType<typeof createDecisionRegistry>) {
  let count = 0;
  return {
    sign(intent: PaymentIntent, decision: PaymentDecision) {
      assertIntentApproved(intent, decision, { now: T0, publicKeyPem, registry });
      count += 1;
      return "SIGNATURE_BYTES";
    },
    get count() {
      return count;
    },
  };
}

const twelveUsdcMicro = "12000000"; // 12.00 USDC on the x402 wire

function selected(overrides: Record<string, string> = {}) {
  return {
    payTo: SELLER,
    network: SOL,
    amount: twelveUsdcMicro,
    asset: USDC,
    resource: "https://merchant.example/report",
    ...overrides,
  };
}

async function run() {
  // 1. Approve → signed, intent-bound decision; clean signer runs once; mutation refused.
  {
    const signer = createLocalDecisionSigner();
    const { client, fire } = mockClient();
    let decision: PaymentDecision | undefined;
    let intent: PaymentIntent | undefined;
    installTwzrdX402ClientHook(client, {
      paymentControl: { signer, purpose: "report" },
      now: () => T0,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: allowPreflight(),
      onDecision: (d) => {
        decision = d.decision;
        intent = d.intent;
      },
    });

    const result = await fire({ selectedRequirements: selected() });
    assert.ok(result === undefined || !("abort" in result && result.abort), "approved: no abort");
    assert.ok(decision, "signed decision surfaced");
    assert.ok(intent, "evaluated intent surfaced");
    assert.equal(decision!.decision, "allow");
    // Wire micro corrected to decimal USD (the 1e6 fix).
    assert.equal(intent!.amount, "12");

    // Clean intent signs exactly once.
    const clean = makeGuardedSigner(signer.publicKeyPem);
    clean.sign(intent!, decision!);
    assert.equal(clean.count, 1);

    // payTo swapped after approval → refuse, signer never runs.
    const mutated = { ...intent!, payTo: ATTACKER };
    const guarded = makeGuardedSigner(signer.publicKeyPem);
    assert.throws(
      () => guarded.sign(mutated, decision!),
      (e: unknown) =>
        e instanceof TwzrdIntentBindingError && e.code === "INTENT_HASH_MISMATCH",
    );
    assert.equal(guarded.count, 0);
  }

  // 2. TIGHTEN: preflight allows, but local policy blocks on amount → hook aborts.
  {
    const signer = createLocalDecisionSigner();
    const { client, fire } = mockClient();
    let decision: PaymentDecision | undefined;
    installTwzrdX402ClientHook(client, {
      paymentControl: { signer, policy: { maxAmountUsd: "10" } },
      now: () => T0,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: allowPreflight(),
      onDecision: (d) => {
        decision = d.decision;
      },
    });

    const result = await fire({ selectedRequirements: selected() });
    assert.ok(result && "abort" in result && result.abort === true, "policy block aborts");
    assert.match(String((result as { reason: string }).reason), /payment_control_block/);
    assert.equal(decision!.decision, "block");
    assert.ok(decision!.reasonCodes.includes("POLICY_MAX_AMOUNT"));
  }

  // 2b. Same policy, higher ceiling → allowed (proves the amount is not mis-scaled).
  {
    const signer = createLocalDecisionSigner();
    const { client, fire } = mockClient();
    let decision: PaymentDecision | undefined;
    installTwzrdX402ClientHook(client, {
      paymentControl: { signer, policy: { maxAmountUsd: "20" } },
      now: () => T0,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: allowPreflight(),
      onDecision: (d) => {
        decision = d.decision;
      },
    });
    const result = await fire({ selectedRequirements: selected() });
    assert.ok(result === undefined || !("abort" in result && result.abort), "under ceiling: allowed");
    assert.equal(decision!.decision, "allow");
  }

  // 3. Consume-once across the sign boundary.
  {
    const signer = createLocalDecisionSigner();
    const { client, fire } = mockClient();
    let decision: PaymentDecision | undefined;
    let intent: PaymentIntent | undefined;
    installTwzrdX402ClientHook(client, {
      paymentControl: { signer },
      now: () => T0,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: allowPreflight(),
      onDecision: (d) => {
        decision = d.decision;
        intent = d.intent;
      },
    });
    await fire({ selectedRequirements: selected() });
    const registry = createDecisionRegistry();
    const s = makeGuardedSigner(signer.publicKeyPem, registry);
    s.sign(intent!, decision!);
    assert.equal(s.count, 1);
    const replay = makeGuardedSigner(signer.publicKeyPem, registry);
    assert.throws(
      () => replay.sign(intent!, decision!),
      (e: unknown) => e instanceof TwzrdIntentBindingError && e.code === "DECISION_REPLAYED",
    );
    assert.equal(replay.count, 0);
  }

  // 4. Never loosen: legacy can_spend=false still aborts even with paymentControl.
  {
    const signer = createLocalDecisionSigner();
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, {
      paymentControl: { signer },
      now: () => T0,
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            readiness_card: { decision: "warn", can_spend: false, trust_score: 56, seller_wallet: SELLER },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const result = await fire({ selectedRequirements: selected() });
    assert.ok(result && "abort" in result && result.abort === true, "legacy denial preserved");
  }

  // 5. Opt-out: no paymentControl → no decision, exact prior behavior.
  {
    const { client, fire } = mockClient();
    let sawDecision = false;
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: allowPreflight(),
      onDecision: (d) => {
        sawDecision = d.decision !== undefined;
      },
    });
    const result = await fire({ selectedRequirements: selected() });
    assert.ok(result === undefined || !("abort" in result && result.abort));
    assert.equal(sawDecision, false, "no decision issued when paymentControl unset");
  }

  console.log("intent-binding.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("intent-binding.test.ts FAILED:", e);
  process.exit(1);
});
