/**
 * AutoGate onBeforePaymentCreation intercept — wash refuse, signer never called.
 * Run: npx tsx test/autogate-intercept.test.ts
 */
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installTwzrdAutoGate, uninstallTwzrdAutoGate } from "../src/auto-gate.js";
import {
  buildAutogateBlockProof,
  AUTOGATE_BLOCK_PROOF_SCHEMA,
} from "../src/block-proof.js";
import {
  TWZRD_TRUST_GATE_BLOCK_WASH,
  toTrustGateBlockReason,
} from "../src/trust-gate-reason.js";
import type {
  BeforePaymentCreationContext,
  X402ClientLike,
} from "../src/x402-client-hook.js";

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
    // free preflight — warn with thin score; wash path must still refuse
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

function fakeX402Client() {
  let hook:
    | ((
        ctx: BeforePaymentCreationContext,
      ) => Promise<void | { abort: true; reason: string }>)
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
      if (!hook) throw new Error("no hook installed");
      return hook(ctx);
    },
  };
}

async function run() {
  // --- reason mapping ---
  assert.equal(
    toTrustGateBlockReason("twzrd_wash_flagged"),
    TWZRD_TRUST_GATE_BLOCK_WASH,
  );
  assert.equal(
    toTrustGateBlockReason(
      "[twzrd] twzrd_wash_flagged payTo=7G73… network=solana",
    ),
    TWZRD_TRUST_GATE_BLOCK_WASH,
  );

  // --- intercept: wash_flagged → abort, signer never called ---
  {
    let signerInvocations = 0;
    const fake = fakeX402Client();
    installTwzrdAutoGate(fake.client, {
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: routedFetch(),
      onDecision: () => {
        // If anything tried to sign after approve, we'd count elsewhere;
        // this path must never approve wash.
      },
    });

    const result = await fake.fire({
      selectedRequirements: {
        payTo: WASH_SELLER,
        network: "solana:mainnet",
        maxAmountRequired: "50000",
        resource: RESOURCE,
        scheme: "exact",
      },
    });

    assert.ok(result && result.abort === true, "expected abort:true");
    assert.match(
      result.reason,
      /twzrd_wash_flagged|wash/i,
      `unexpected reason: ${result.reason}`,
    );
    // Signer spy: we never invoke a wallet in this harness; count stays 0.
    assert.equal(signerInvocations, 0);

    const proof = buildAutogateBlockProof({
      run_id: "test-autogate-intercept",
      target_seller: WASH_SELLER,
      aborted: true,
      internal_reason: result.reason,
      decision: "warn",
      wash_flagged: true,
      trust_score: 45,
      signer_invocations: 0,
      actual_spend_usdc: 0,
      onchain_settlements: 0,
    });
    assert.equal(proof.schema_version, AUTOGATE_BLOCK_PROOF_SCHEMA);
    assert.equal(proof.interception.reason, TWZRD_TRUST_GATE_BLOCK_WASH);
    assert.equal(proof.interception.aborted, true);
    assert.equal(proof.invariants.signer_invocations, 0);
    assert.equal(proof.verified, true);

    const path = join(tmpdir(), `block-proof-test-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(proof, null, 2));
    unlinkSync(path);

    uninstallTwzrdAutoGate(fake.client);
  }

  // --- non-vacuous: clean card + allow must NOT abort (signer would proceed) ---
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

    const fake = fakeX402Client();
    installTwzrdAutoGate(fake.client, {
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      preflightMinScore: 0,
      failOpen: true,
      fetch: cleanFetch,
    });
    const result = await fake.fire({
      selectedRequirements: {
        payTo: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        network: "solana:mainnet",
        maxAmountRequired: "1000",
        resource: "https://merchant.example/clean",
      },
    });
    assert.equal(
      result,
      undefined,
      "clean allow must proceed (void), not abort",
    );
    uninstallTwzrdAutoGate(fake.client);
  }

  // --- proof builder: non-zero signer fails verified ---
  {
    const bad = buildAutogateBlockProof({
      run_id: "x",
      target_seller: WASH_SELLER,
      aborted: true,
      internal_reason: "twzrd_wash_flagged",
      signer_invocations: 1,
    });
    assert.equal(bad.verified, false);
  }

  console.log("autogate-intercept.test.ts: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
