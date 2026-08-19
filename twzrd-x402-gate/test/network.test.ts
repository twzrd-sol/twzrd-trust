/**
 * Cross-chain / unsupported-network honesty.
 * Run: npx tsx test/network.test.ts
 */
import assert from "node:assert/strict";

import {
  classifyNetwork,
  decideUnsupportedNetwork,
} from "../src/network.js";
import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";
import { installTwzrdAutoGate } from "../src/auto-gate.js";

async function run() {
  // --- classifyNetwork ---
  {
    const sol = classifyNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.equal(sol.reputationScored, true);
    assert.equal(sol.kind, "solana");
    assert.equal(sol.reason, "solana_scored");

    const base = classifyNetwork("eip155:8453");
    assert.equal(base.reputationScored, false);
    assert.equal(base.kind, "evm");
    assert.equal(base.reason, "network_not_scored");
    assert.equal(base.networkSupported, true);

    const poly = classifyNetwork("eip155:137");
    assert.equal(poly.reputationScored, false);

    // Legacy: missing network + base58 payTo → Solana scored (backward compatible)
    const legacy = classifyNetwork(undefined, "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk");
    assert.equal(legacy.reputationScored, true);
    assert.equal(legacy.kind, "solana");
    // Missing network + 0x payTo → EVM unscored
    const evmGuess = classifyNetwork(undefined, "0x3803A19280DeeFe533D177C4A169412BD341101b");
    assert.equal(evmGuess.reputationScored, false);
    assert.equal(evmGuess.kind, "evm");
  }

  // --- decideUnsupportedNetwork modes ---
  {
    const base = classifyNetwork("eip155:8453");
    const obs = decideUnsupportedNetwork(base, "observe");
    assert.equal(obs.decision, "unknown");
    assert.equal(obs.policyAction, "allow");
    assert.equal(obs.approved, true);
    assert.equal(obs.reputationScored, false);

    const strict = decideUnsupportedNetwork(base, "strict");
    assert.equal(strict.policyAction, "block");
    assert.equal(strict.approved, false);
    assert.equal(strict.decision, "unknown");
  }

  // --- twzrdApprovePayment: Base never calls preflight ---
  {
    let preflightHits = 0;
    const cfg = resolveConfig({
      unsupportedNetworkMode: "observe",
      fetch: (async () => {
        preflightHits += 1;
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    });
    const r = await twzrdApprovePayment(
      {
        payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
        chain: "eip155:8453",
        priceUsdc: 0.01,
        agentIntent: "network_test",
      },
      cfg,
    );
    assert.equal(preflightHits, 0, "Base must not hit Solana preflight");
    assert.equal(r.verdict, "unknown");
    assert.equal(r.reason, "network_not_scored");
    assert.equal(r.approved, true, "observe allows unscored");
    assert.equal(r.reputationScored, false);
    assert.equal(r.policyAction, "allow");
    assert.equal(r.score, null);
  }

  // --- strict mode blocks Base before any sign path ---
  {
    const cfg = resolveConfig({
      unsupportedNetworkMode: "strict",
      fetch: (async () => {
        throw new Error("preflight must not run");
      }) as typeof fetch,
    });
    const r = await twzrdApprovePayment(
      {
        payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
        chain: "eip155:8453",
        agentIntent: "network_test_strict",
      },
      cfg,
    );
    assert.equal(r.approved, false);
    assert.equal(r.verdict, "unknown");
    assert.equal(r.policyAction, "block");
  }

  // --- wrapFetch: Base-only 402, observe → returns 402 (policy allow) ---
  {
    let preflightHits = 0;
    const base402: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          accepts: [
            {
              network: "eip155:8453",
              payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
              amount: "1000",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const cfg = resolveConfig({
      unsupportedNetworkMode: "observe",
      fetch: (async () => {
        preflightHits += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const gated = wrapFetchWithTwzrdGate(base402, cfg);
    const resp = await gated("https://merchant.example/base-paid");
    assert.equal(resp.status, 402, "observe returns 402 for pay client");
    assert.equal(preflightHits, 0);
  }

  // --- wrapFetch: Base-only 402, strict → throws before pay client ---
  {
    const base402: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          accepts: [
            {
              network: "eip155:8453",
              payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
              amount: "1000",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const cfg = resolveConfig({
      unsupportedNetworkMode: "strict",
      fetch: (async () => {
        throw new Error("must not preflight");
      }) as typeof fetch,
    });
    const gated = wrapFetchWithTwzrdGate(base402, cfg);
    await assert.rejects(() => gated("https://merchant.example/base-paid"), /network_not_scored|payment blocked/);
  }

  // --- dual-chain: Solana preferred → still scores (preflight called) ---
  {
    let preflightHits = 0;
    const dual: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          accepts: [
            {
              network: "eip155:8453",
              payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
              amount: "1000",
            },
            {
              network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
              payTo: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
              amount: "1000",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const cfg = resolveConfig({
      fetch: (async () => {
        preflightHits += 1;
        return new Response(
          JSON.stringify({
            readiness_card: {
              decision: "allow",
              trust_score: 90,
              can_spend: true,
              seller_wallet: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
      refuseWashFlagged: false,
    });
    const gated = wrapFetchWithTwzrdGate(dual, cfg);
    const resp = await gated("https://merchant.example/dual");
    assert.equal(resp.status, 402);
    assert.equal(preflightHits, 1, "Solana accept preferred and scored");
  }

  // --- auto-gate: strict Base never signs ---
  {
    let signed = 0;
    const paying = installTwzrdAutoGate(
      (guarded) =>
        (async (input, init) => {
          const r = await guarded(input, init);
          if (r.status === 402) {
            signed += 1;
            return new Response("paid", { status: 200 });
          }
          return r;
        }) as typeof fetch,
      {
        rawFetch: (async () =>
          new Response(
            JSON.stringify({
              accepts: [
                {
                  network: "eip155:8453",
                  payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
                  amount: "1000",
                },
              ],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
        unsupportedNetworkMode: "strict",
        refuseWashFlagged: false,
      },
    );
    await assert.rejects(() => paying("https://x.example/paid"), /blocked|network_not_scored/);
    assert.equal(signed, 0);
  }

  console.log("network.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("network.test.ts FAILED:", e);
  process.exit(1);
});
