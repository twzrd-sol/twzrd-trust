/**
 * Regression: Base / EVM observe must still refuse wash_flagged before sign.
 *
 * Root cause this locks: Path E / twzrdApprovePayment classified Base as
 * unscored and, with unsupportedNetworkMode:"observe", returned allow
 * before merchant_card wash ran. Solana wash aborted; the same payTo on
 * Base signed (signer_invocation_count=1).
 *
 * Observe stays observe (no Solana preflight / no invented reputation).
 * Wash is wallet-keyed and must still tighten.
 *
 * Run: npx tsx test/base-wash-observe.test.ts
 */
import assert from "node:assert/strict";

import { installTwzrdAutoGate, uninstallTwzrdAutoGate } from "../src/auto-gate.js";
import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";
import {
  twzrdBeforePaymentCreation,
  type BeforePaymentCreationContext,
  type X402ClientLike,
} from "../src/x402-client-hook.js";

/** Same wash fixture used by autogate-intercept / Solana beforePayment proofs. */
const WASH_PAYTO = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";
const CLEAN_PAYTO = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const EVM_WASH = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const EVM_CLEAN = "0x1111111111111111111111111111111111111111";

type FetchHits = { preflight: number; merchantCard: number; other: number };

function washRoutedFetch(opts: {
  washByWallet: Record<string, boolean>;
  hits: FetchHits;
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/preflight")) {
      opts.hits.preflight += 1;
      return new Response(
        JSON.stringify({
          readiness_card: { decision: "allow", trust_score: 80, can_spend: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const cardMatch = url.match(/\/v1\/intel\/merchant_card\/([^/?#]+)/);
    if (cardMatch) {
      opts.hits.merchantCard += 1;
      const wallet = decodeURIComponent(cardMatch[1] ?? "");
      const flagged = opts.washByWallet[wallet];
      return new Response(JSON.stringify({ wash_flagged: flagged === true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    opts.hits.other += 1;
    return new Response("{}", { status: 500 });
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
  // --- policy: same Solana wash payTo on Base observe must refuse ---
  {
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const r = await twzrdApprovePayment(
      {
        payTo: WASH_PAYTO,
        chain: "base",
        priceUsdc: 0.05,
        agentIntent: "base_wash_observe",
      },
      resolveConfig({
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: true,
        fetch: washRoutedFetch({
          washByWallet: { [WASH_PAYTO]: true, [CLEAN_PAYTO]: false },
          hits,
        }),
      }),
    );
    assert.equal(hits.preflight, 0, "Base observe must not invent Solana preflight");
    assert.equal(hits.merchantCard, 1, "Base observe must still GET merchant_card");
    assert.equal(r.approved, false, "wash_flagged on Base must refuse");
    assert.equal(r.reason, "twzrd_wash_flagged");
    assert.equal(r.washFlagged, true);
    assert.equal(r.verdict, "block");
    assert.equal(r.reputationScored, false);
    assert.equal(r.policyAction, "block");
  }

  // --- policy: eip155:8453 + 0x wash payTo (CAIP-2 Base) ---
  {
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const r = await twzrdApprovePayment(
      {
        payTo: EVM_WASH,
        chain: "eip155:8453",
        priceUsdc: 0.05,
      },
      resolveConfig({
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: true,
        fetch: washRoutedFetch({
          washByWallet: { [EVM_WASH]: true },
          hits,
        }),
      }),
    );
    assert.equal(hits.preflight, 0);
    assert.equal(r.approved, false);
    assert.equal(r.reason, "twzrd_wash_flagged");
    assert.equal(r.reputationScored, false);
  }

  // --- policy: clean Base payTo still allows (observe, unknown, not scored) ---
  {
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const r = await twzrdApprovePayment(
      {
        payTo: CLEAN_PAYTO,
        chain: "base",
        priceUsdc: 0.05,
      },
      resolveConfig({
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: true,
        fetch: washRoutedFetch({
          washByWallet: { [WASH_PAYTO]: true, [CLEAN_PAYTO]: false },
          hits,
        }),
      }),
    );
    assert.equal(hits.preflight, 0);
    assert.equal(hits.merchantCard, 1);
    assert.equal(r.approved, true, "clean Base payTo must still allow under observe");
    assert.equal(r.verdict, "unknown");
    assert.equal(r.reason, "network_not_scored");
    assert.equal(r.washFlagged, false);
    assert.equal(r.reputationScored, false);
    assert.equal(r.policyAction, "allow");
  }

  // --- policy: observe + refuseWashFlagged=false still skips wash (opt-out) ---
  {
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const r = await twzrdApprovePayment(
      { payTo: WASH_PAYTO, chain: "base", priceUsdc: 0.05 },
      resolveConfig({
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: false,
        fetch: washRoutedFetch({
          washByWallet: { [WASH_PAYTO]: true },
          hits,
        }),
      }),
    );
    assert.equal(hits.merchantCard, 0, "opt-out must not fetch merchant_card");
    assert.equal(r.approved, true);
    assert.equal(r.reason, "network_not_scored");
  }

  // --- policy: strict still blocks Base without needing wash ---
  {
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const r = await twzrdApprovePayment(
      { payTo: EVM_CLEAN, chain: "eip155:8453" },
      resolveConfig({
        unsupportedNetworkMode: "strict",
        refuseWashFlagged: true,
        fetch: washRoutedFetch({ washByWallet: {}, hits }),
      }),
    );
    assert.equal(hits.preflight, 0);
    assert.equal(hits.merchantCard, 0, "strict blocks before wash");
    assert.equal(r.approved, false);
    assert.equal(r.reason, "network_not_scored");
    assert.equal(r.policyAction, "block");
  }

  // --- Path E AutoGate: Base wash abort, signer never called ---
  {
    let signerInvocations = 0;
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const fake = fakeX402Client();
    installTwzrdAutoGate(fake.client, {
      unsupportedNetworkMode: "observe",
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      fetch: washRoutedFetch({
        washByWallet: { [WASH_PAYTO]: true, [CLEAN_PAYTO]: false },
        hits,
      }),
    });

    const result = await fake.fire({
      selectedRequirements: {
        payTo: WASH_PAYTO,
        network: "base",
        maxAmountRequired: "50000",
        resource: "https://merchant.example/base-wash",
        scheme: "exact",
      },
    });

    assert.ok(result && result.abort === true, "Base wash must abort Path E");
    assert.match(result.reason, /twzrd_wash_flagged/);
    assert.equal(signerInvocations, 0, "signer_invocation_count must stay 0");
    assert.equal(hits.preflight, 0);
    assert.equal(hits.merchantCard, 1);
    uninstallTwzrdAutoGate(fake.client);
  }

  // --- Path E AutoGate: Base clean proceeds (would sign) ---
  {
    let signerInvocations = 0;
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const fake = fakeX402Client();
    installTwzrdAutoGate(fake.client, {
      unsupportedNetworkMode: "observe",
      refuseWashFlagged: true,
      gateOnCanSpend: false,
      fetch: washRoutedFetch({
        washByWallet: { [CLEAN_PAYTO]: false },
        hits,
      }),
    });

    const result = await fake.fire({
      selectedRequirements: {
        payTo: CLEAN_PAYTO,
        network: "eip155:8453",
        maxAmountRequired: "1000",
        resource: "https://merchant.example/base-clean",
      },
    });
    assert.equal(result, undefined, "clean Base must proceed (void), not abort");
    // Harness never invokes a wallet; a proceed is the green-light to sign.
    assert.equal(signerInvocations, 0);
    assert.equal(hits.preflight, 0);
    uninstallTwzrdAutoGate(fake.client);
  }

  // --- standalone Path E evaluator: same Base wash abort ---
  {
    const hits: FetchHits = { preflight: 0, merchantCard: 0, other: 0 };
    const result = await twzrdBeforePaymentCreation(
      {
        payTo: WASH_PAYTO,
        network: "base",
        amount: "1000",
      },
      {
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: true,
        fetch: washRoutedFetch({
          washByWallet: { [WASH_PAYTO]: true },
          hits,
        }),
      },
    );
    assert.ok(result && "abort" in result && result.abort === true);
    assert.match(String(result.reason), /twzrd_wash_flagged/);
    assert.equal(hits.preflight, 0);
  }

  console.log("base-wash-observe.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("base-wash-observe.test.ts FAILED:", e);
  process.exit(1);
});
