/**
 * Single-evaluation + install/standalone parity for Path E.
 *
 * Guards the partial-refactor failure mode where installTwzrdX402ClientHook
 * (or twzrdBeforePaymentCreation) ran both an inline body AND
 * evaluateBeforePaymentCreation — double preflight, double evaluateIntent,
 * double onDecision, double ledger record.
 *
 * Run: npx tsx test/hook-single-eval.test.ts
 */
import assert from "node:assert/strict";

import {
  installTwzrdX402ClientHook,
  resolvePaymentControlSigner,
  twzrdBeforePaymentCreation,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import {
  createLocalDecisionSigner,
  type DecisionSigner,
} from "../src/decision-token.js";
import {
  createMemorySpendLedger,
  type SpendLedger,
} from "../src/policy-runtime.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";

const SELECTED = {
  payTo: SELLER,
  network: SOL,
  amount: "1000",
  asset: USDC,
  resource: "https://merchant.example/paid",
};

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

function countingFetch(card: Record<string, unknown>) {
  let preflightCount = 0;
  let merchantCardCount = 0;
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/v1/intel/preflight")) {
      preflightCount += 1;
      return new Response(JSON.stringify({ readiness_card: card }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/intel/merchant_card")) {
      merchantCardCount += 1;
      return new Response(JSON.stringify({ wash_flagged: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return {
    fetch: fetchFn,
    counts: () => ({ preflightCount, merchantCardCount }),
  };
}

function countingLedger(): SpendLedger & { recordCount: number } {
  const inner = createMemorySpendLedger();
  let recordCount = 0;
  return {
    get recordCount() {
      return recordCount;
    },
    spentMicro: (...args) => inner.spentMicro(...args),
    firstSeen: (...args) => inner.firstSeen(...args),
    record(scopeKey, amountMicro, at) {
      recordCount += 1;
      return inner.record(scopeKey, amountMicro, at);
    },
  };
}

function countingSigner(inner: DecisionSigner): DecisionSigner & {
  signCount: number;
} {
  let signCount = 0;
  return {
    get signCount() {
      return signCount;
    },
    keyId: inner.keyId,
    publicKeyPem: inner.publicKeyPem,
    async sign(preimage: Uint8Array) {
      signCount += 1;
      return inner.sign(preimage);
    },
  };
}

async function run() {
  const allowCard = {
    decision: "allow",
    can_spend: true,
    trust_score: 90,
    seller_wallet: SELLER,
  };
  const denyCard = {
    decision: "block",
    can_spend: false,
    trust_score: 5,
    seller_wallet: SELLER,
  };

  // 1–4. Install path: one preflight, one decision, one sign, one ledger record
  {
    const { fetch, counts } = countingFetch(allowCard);
    const ledger = countingLedger();
    const signer = countingSigner(createLocalDecisionSigner());
    let decisions = 0;
    const { client, fire } = mockClient();

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: true,
      preflightMinScore: 40,
      fetch,
      paymentControl: {
        signer,
        ledger,
        policy: { maxAmountUsd: "1.00" },
      },
      onDecision: () => {
        decisions += 1;
      },
    });

    const result = await fire({ selectedRequirements: SELECTED });
    assert.equal(result, undefined, "allow must not abort");
    assert.equal(counts().preflightCount, 1, "exactly one preflight");
    assert.equal(decisions, 1, "exactly one onDecision");
    assert.equal(signer.signCount, 1, "exactly one decision signature");
    assert.equal(ledger.recordCount, 1, "exactly one ledger record on allow");
  }

  // 5. Legacy preflight deny: zero ledger recording
  {
    const { fetch, counts } = countingFetch(denyCard);
    const ledger = countingLedger();
    const signer = countingSigner(createLocalDecisionSigner());
    let decisions = 0;
    const { client, fire } = mockClient();

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch,
      paymentControl: {
        signer,
        ledger,
        policy: { maxAmountUsd: "1.00" },
      },
      onDecision: () => {
        decisions += 1;
      },
    });

    const result = await fire({ selectedRequirements: SELECTED });
    assert.ok(result && "abort" in result && result.abort === true);
    assert.equal(counts().preflightCount, 1, "one preflight even on deny");
    assert.equal(decisions, 1, "onDecision still fires once on deny");
    // evaluateIntent still signs a block decision once when paymentControl is set
    assert.equal(signer.signCount, 1, "one signed decision (block) on deny");
    assert.equal(
      ledger.recordCount,
      0,
      "ledger must not record when legacy preflight denies",
    );
  }

  // 6. Install helper and standalone helper return identical results
  {
    const makeOpts = () => {
      const { fetch } = countingFetch(allowCard);
      const ledger = countingLedger();
      const signer = createLocalDecisionSigner();
      let decisions = 0;
      return {
        opts: {
          gateOnCanSpend: false as const,
          refuseWashFlagged: false as const,
          preflightMinScore: 40,
          fetch,
          paymentControl: {
            signer,
            ledger,
            policy: { maxAmountUsd: "1.00" },
          },
          now: () => 1_800_000_000_000,
          onDecision: () => {
            decisions += 1;
          },
        },
        get decisions() {
          return decisions;
        },
      };
    };

    const installSide = makeOpts();
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, installSide.opts);
    const installResult = await fire({ selectedRequirements: SELECTED });

    const standSide = makeOpts();
    const standResult = await twzrdBeforePaymentCreation(
      SELECTED,
      standSide.opts,
    );

    assert.deepEqual(
      installResult,
      standResult,
      "install and standalone must return identical results",
    );
    assert.equal(installSide.decisions, 1);
    assert.equal(standSide.decisions, 1);
  }

  // 6b. Deny parity too
  {
    const installFetch = countingFetch(denyCard);
    const standFetch = countingFetch(denyCard);
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: installFetch.fetch,
    });
    const installResult = await fire({ selectedRequirements: SELECTED });
    const standResult = await twzrdBeforePaymentCreation(SELECTED, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch: standFetch.fetch,
    });
    assert.deepEqual(installResult, standResult);
    assert.equal(installFetch.counts().preflightCount, 1);
    assert.equal(standFetch.counts().preflightCount, 1);
  }

  // 7. Both signer and secret fail immediately
  {
    const { client } = mockClient();
    assert.throws(
      () =>
        installTwzrdX402ClientHook(client, {
          paymentControl: {
            signer: createLocalDecisionSigner(),
            secret: "a".repeat(64),
          } as never,
        }),
      /exactly one of `signer` or `secret`/,
    );
    assert.throws(
      () =>
        resolvePaymentControlSigner({
          signer: createLocalDecisionSigner(),
          secret: "b".repeat(64),
        } as never),
      /both were given/,
    );
  }

  // 8. Neither signer nor secret fails immediately
  {
    const { client } = mockClient();
    assert.throws(
      () =>
        installTwzrdX402ClientHook(client, {
          paymentControl: {} as never,
        }),
      /exactly one of `signer` or `secret`.*neither/,
    );
    assert.throws(
      () => resolvePaymentControlSigner({} as never),
      /neither was given/,
    );
  }

  // Standalone also fails fast when paymentControl misconfigured at evaluate
  {
    await assert.rejects(
      () =>
        twzrdBeforePaymentCreation(SELECTED, {
          refuseWashFlagged: false,
          fetch: countingFetch(allowCard).fetch,
          paymentControl: {} as never,
        }),
      /exactly one of `signer` or `secret`/,
    );
  }

  console.log("hook-single-eval.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("hook-single-eval.test.ts FAILED:", e);
  process.exit(1);
});
