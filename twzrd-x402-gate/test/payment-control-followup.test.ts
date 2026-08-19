/**
 * Payment Control follow-up: seeded signer secret ergonomic, live-pipeline
 * intelligence provider, and ledger hygiene on legacy denial.
 * Run: npx tsx test/payment-control-followup.test.ts
 */
import assert from "node:assert/strict";

import {
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import {
  createLocalDecisionSigner,
  createSeededDecisionSigner,
  verifyDecisionSignature,
  type PaymentDecision,
} from "../src/decision-token.js";
import { intentHash } from "../src/intent.js";
import { x402RequirementsToIntent } from "../src/intent-adapters.js";
import { createTwzrdIntelligenceProvider } from "../src/intelligence.js";
import { createMemorySpendLedger, evaluateIntent } from "../src/policy-runtime.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const T0 = 1_800_000_000_000;

/** Real 32-byte key material (openssl rand -hex 32). Passphrases are rejected. */
const SHARED_SECRET =
  "9f2c41d7b8e05a6c3f1d94b7e28a60c5d3719fb46a8e2c07d51b93f6ae4c28d0";
const OTHER_SECRET =
  "4b1e77a0c95d386fe2ac40b91d7f6528c3ea19d47b06f82c5d3b7e10a94c62f8";
const HOOK_SECRET =
  "c70a5f31e9b248d6ac1e05397fb82d4610c93e7a25bf40d81639ae52c807b4f9";


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

function cardFetch(card: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const REQ = {
  payTo: SELLER,
  network: SOL,
  amount: "12000000", // 12 USDC on the wire
  asset: USDC,
  resource: "https://merchant.example/report",
};

async function run() {
  /* 1. Seeded signer: deterministic, secret-derived, verifiable */
  {
    const a = createSeededDecisionSigner(SHARED_SECRET);
    const b = createSeededDecisionSigner(SHARED_SECRET);
    const c = createSeededDecisionSigner(OTHER_SECRET);
    assert.equal(a.publicKeyPem, b.publicKeyPem, "same secret -> same key");
    assert.notEqual(a.publicKeyPem, c.publicKeyPem);
    assert.throws(() => createSeededDecisionSigner(""));
  }

  /* 2. paymentControl.secret on the hook: token issued + re-derived verify */
  {
    const { client, fire } = mockClient();
    let decision: PaymentDecision | undefined;
    installTwzrdX402ClientHook(client, {
      paymentControl: { secret: HOOK_SECRET },
      now: () => T0,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: cardFetch({
        decision: "allow",
        can_spend: true,
        trust_score: 90,
        seller_wallet: SELLER,
      }),
      onDecision: (d) => {
        decision = d.decision;
      },
    });
    const result = await fire({ selectedRequirements: REQ });
    assert.ok(result === undefined || !("abort" in result && result.abort));
    assert.ok(decision, "secret alone must issue a signed decision");
    assert.equal(decision.decision, "allow");
    assert.equal(decision.intentHash, intentHash(x402RequirementsToIntent(REQ)));
    const verifier = createSeededDecisionSigner(HOOK_SECRET);
    assert.ok(verifyDecisionSignature(decision, verifier.publicKeyPem));
    const wrong = createSeededDecisionSigner(OTHER_SECRET);
    assert.equal(verifyDecisionSignature(decision, wrong.publicKeyPem), false);
  }

  /* 3. paymentControl without signer or secret: fail fast at install */
  {
    const { client } = mockClient();
    assert.throws(
      // `as never`: the exactly-one union now rejects this at COMPILE time too.
      // The cast keeps the runtime guard under test for plain-JS callers.
      () => installTwzrdX402ClientHook(client, { paymentControl: {} as never }),
      /signer.*secret|secret.*signer/,
    );
  }

  /* 4. Ledger hygiene: legacy denial must not record spend */
  {
    const ledger = createMemorySpendLedger();
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, {
      paymentControl: {
        secret: HOOK_SECRET,
        ledger,
        policy: { newCounterpartyCap: { capUsd: "100", windowHours: 24 } },
      },
      now: () => T0,
      gateOnCanSpend: true, // legacy denies: can_spend=false
      refuseWashFlagged: false,
      fetch: cardFetch({
        decision: "warn",
        can_spend: false,
        trust_score: 56,
        seller_wallet: SELLER,
      }),
    });
    const result = await fire({ selectedRequirements: REQ });
    assert.ok(result && "abort" in result && result.abort === true, "legacy denial aborts");
    assert.equal(
      ledger.spentMicro(`counterparty:${SELLER}`, 24 * 3_600_000, T0),
      0n,
      "denied payment must not pollute cumulative caps",
    );
  }

  /* 5. Intelligence provider: live pipeline through evaluateIntent */
  {
    const signer = createLocalDecisionSigner();
    const intent = x402RequirementsToIntent(REQ);
    assert.equal(intent.amount, "12"); // adapter converts wire micro -> decimal

    const allow = await evaluateIntent(intent, {
      signer,
      intelligence: createTwzrdIntelligenceProvider({
        refuseWashFlagged: false,
        preflightMinScore: 40,
        fetch: cardFetch({
          decision: "allow",
          can_spend: true,
          trust_score: 90,
          seller_wallet: SELLER,
        }),
      }),
    });
    assert.equal(allow.decision, "allow");
    assert.equal(allow.intentHash, intentHash(intent));

    const blocked = await evaluateIntent(intent, {
      signer,
      intelligence: createTwzrdIntelligenceProvider({
        gateOnCanSpend: true,
        refuseWashFlagged: false,
        fetch: cardFetch({
          decision: "warn",
          can_spend: false,
          trust_score: 40,
          seller_wallet: SELLER,
        }),
      }),
    });
    assert.equal(blocked.decision, "block");
    assert.ok(blocked.reasonCodes.includes("INTEL_BLOCK"));
  }

  console.log("payment-control-followup.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("payment-control-followup.test.ts FAILED:", e);
  process.exit(1);
});
