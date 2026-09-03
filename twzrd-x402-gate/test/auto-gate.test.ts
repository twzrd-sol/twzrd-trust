/**
 * installTwzrdAutoGate contract test — no real network / no real spend.
 * Run: npx tsx test/auto-gate.test.ts
 *
 * Locks default-on composition across fetch, x402 client, and MPP adapters.
 */
import assert from "node:assert/strict";

import {
  installTwzrdAutoGate,
  uninstallTwzrdAutoGate,
  isTwzrdAutoGateDisabled,
} from "../src/auto-gate.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import type { X402ClientLike, BeforePaymentCreationContext } from "../src/x402-client-hook.js";
import type { MppChallenge, MppOnChallengeHelpers } from "../src/mpp-hook.js";

const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const URL_ = "https://merchant.example/paid";

function merchant402(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        accepts: [{ network: "solana", payTo: SELLER, maxAmountRequired: "50000", resource: URL_ }],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

function preflightFetch(card: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Stand-in for an x402 client: "signs" and returns 200. */
function fakePayClient() {
  let signed = 0;
  const wrap = (guarded: typeof fetch): typeof fetch =>
    (async (input: unknown, init?: unknown) => {
      const resp = await guarded(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
      if (resp.status !== 402) return resp;
      signed += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  return { wrap, signedCount: () => signed };
}

/** Minimal x402Client surface with single-hook registry. */
function fakeX402Client() {
  let hook:
    | ((ctx: BeforePaymentCreationContext) => Promise<void | { abort: true; reason: string }>)
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
      if (!hook) throw new Error("no hook");
      return hook(ctx);
    },
  };
}

async function run() {
  // 1. decision=block -> payWrap never signs
  {
    const client = fakePayClient();
    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: merchant402(),
      fetch: preflightFetch({ decision: "block", trust_score: 5 }),
    });
    await assert.rejects(() => payingFetch(URL_), /payment blocked|BLOCKED|block/i);
    assert.equal(client.signedCount(), 0);
  }

  // 2. decision=allow -> pay client signs
  {
    const client = fakePayClient();
    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: merchant402(),
      fetch: preflightFetch({ decision: "allow", trust_score: 90 }),
    });
    const resp = await payingFetch(URL_);
    assert.equal(resp.status, 200);
    assert.equal(client.signedCount(), 1);
  }

  // 3. disabled:true bypass
  {
    const client = fakePayClient();
    const raw = merchant402();
    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: raw,
      fetch: preflightFetch({ decision: "block", trust_score: 5 }),
      disabled: true,
    });
    const resp = await payingFetch(URL_);
    assert.equal(resp.status, 200);
    assert.equal(client.signedCount(), 1);
  }

  // 3b. malformed 402 fails closed
  {
    const client = fakePayClient();
    let preflightHit = false;
    const spyPreflight: typeof fetch = (async () => {
      preflightHit = true;
      return new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const malformed402: typeof fetch = (async () =>
      new Response(JSON.stringify({ accepts: [] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const payingFetch = installTwzrdAutoGate(client.wrap, {
      rawFetch: malformed402,
      fetch: spyPreflight,
    });
    await assert.rejects(() => payingFetch(URL_), /twzrd_unidentifiable_payment_recipient/);
    assert.equal(client.signedCount(), 0);
    assert.equal(preflightHit, false);
  }

  // 4. TWZRD_AUTO_GATE=0 bypass
  {
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      assert.equal(isTwzrdAutoGateDisabled(), true);
      const client = fakePayClient();
      const payingFetch = installTwzrdAutoGate(client.wrap, {
        rawFetch: merchant402(),
        fetch: preflightFetch({ decision: "block", trust_score: 5 }),
      });
      const resp = await payingFetch(URL_);
      assert.equal(resp.status, 200);
      assert.equal(client.signedCount(), 1);
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
  }

  // 5. TWZRD_GATE_ENABLED=false alias kill switch
  {
    process.env.TWZRD_GATE_ENABLED = "false";
    try {
      assert.equal(isTwzrdAutoGateDisabled(), true);
      const client = fakePayClient();
      const payingFetch = installTwzrdAutoGate(client.wrap, {
        rawFetch: merchant402(),
        fetch: preflightFetch({ decision: "block", trust_score: 5 }),
      });
      const resp = await payingFetch(URL_);
      assert.equal(resp.status, 200);
      assert.equal(client.signedCount(), 1);
    } finally {
      delete process.env.TWZRD_GATE_ENABLED;
    }
  }

  // 6. x402 client path — block aborts before "sign"
  {
    const { client, fire } = fakeX402Client();
    installTwzrdAutoGate(client, {
      fetch: preflightFetch({ decision: "block", trust_score: 5, can_spend: false }),
    });
    const result = await fire({
      selectedRequirements: {
        payTo: SELLER,
        network: "solana",
        maxAmountRequired: "50000",
        resource: URL_,
      },
    });
    assert.ok(result && typeof result === "object" && "abort" in result && result.abort === true);
  }

  // 7. x402 client — uninstall soft-disables further evaluations
  {
    const { client, fire } = fakeX402Client();
    installTwzrdAutoGate(client, {
      fetch: preflightFetch({ decision: "block", trust_score: 5, can_spend: false }),
    });
    uninstallTwzrdAutoGate(client);
    const result = await fire({
      selectedRequirements: {
        payTo: SELLER,
        network: "solana",
        maxAmountRequired: "50000",
      },
    });
    // unguarded: proceed (undefined)
    assert.equal(result, undefined);
  }

  // 8. MPP adapter — disabled returns createCredential
  {
    let created = 0;
    const onChallenge = installTwzrdAutoGate("mpp", {
      disabled: true,
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
    });
    const helpers: MppOnChallengeHelpers = {
      createCredential: async () => {
        created += 1;
        return "cred";
      },
    };
    const challenge = {
      id: "c1",
      realm: "r",
      method: "solana",
      intent: "charge",
      request: {
        amount: "1000000",
        currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        recipient: SELLER,
        cluster: "mainnet-beta",
      },
    } as MppChallenge;
    const out = await onChallenge(challenge, helpers);
    assert.equal(out, "cred");
    assert.equal(created, 1);
  }

  // 9. MPP adapter — active path refuses non-solana/charge (default)
  {
    const onChallenge = installTwzrdAutoGate("mpp", {
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
    });
    const helpers: MppOnChallengeHelpers = {
      createCredential: async () => "should-not",
    };
    await assert.rejects(
      () =>
        onChallenge(
          {
            id: "c2",
            realm: "r",
            method: "tempo",
            intent: "charge",
            request: {},
          } as MppChallenge,
          helpers,
        ),
      /UNEVALUATED|solana\/charge|MPP/i,
    );
  }

  // 10. x402-solana adapter — returns beforePayment hook (disabled → proceed)
  {
    const hook = installTwzrdAutoGate("x402-solana", { disabled: true });
    const result = await hook(
      { payTo: SELLER, amount: "1000", network: "solana" },
      { requestUrl: "https://merchant.example/x" },
    );
    assert.equal(result, undefined);
  }

  // 10b. pay-kit adapter — returns official-context hook (disabled → proceed)
  {
    const hook = installTwzrdAutoGate("pay-kit", { disabled: true });
    const result = await hook({
      selectedRequirements: { payTo: SELLER, amount: "1000", network: "solana" },
    });
    assert.equal(result, undefined);
  }

  // 11. bad target type
  {
    assert.throws(
      () => installTwzrdAutoGate({} as never),
      /PayWrap|x402 client|mpp|x402-solana|pay-kit/,
    );
  }

  console.log("auto-gate.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("auto-gate.test.ts FAILED:", e);
  process.exit(1);
});
