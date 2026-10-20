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

    // Base has its own corpus (x402_base_daily), so it is scored like Solana.
    const base = classifyNetwork("eip155:8453");
    assert.equal(base.reputationScored, true);
    assert.equal(base.kind, "evm");
    assert.equal(base.reason, "base_scored");
    assert.equal(base.networkSupported, true);
    assert.equal(classifyNetwork("base").reputationScored, true);

    // Every other EVM chain still has no corpus and must never be scored.
    const poly = classifyNetwork("eip155:137");
    assert.equal(poly.reputationScored, false);
    assert.equal(poly.reason, "network_not_scored");
    for (const n of ["eip155:1", "eip155:42161", "polygon", "arbitrum", "ethereum"]) {
      assert.equal(classifyNetwork(n).reputationScored, false, `${n} must stay unscored`);
    }
    // Base testnet is recognized but has no corpus.
    assert.equal(classifyNetwork("eip155:84532").reputationScored, false);
    assert.equal(classifyNetwork("base-sepolia").reputationScored, false);

    // Legacy: missing network + base58 payTo → Solana scored (backward compatible)
    const legacy = classifyNetwork(undefined, "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk");
    assert.equal(legacy.reputationScored, true);
    assert.equal(legacy.kind, "solana");
    // Missing network + 0x payTo → EVM unscored. A bare address says nothing
    // about which chain it is on, so Base scoring must not leak in here.
    const evmGuess = classifyNetwork(undefined, "0x3803A19280DeeFe533D177C4A169412BD341101b");
    assert.equal(evmGuess.reputationScored, false);
    assert.equal(evmGuess.kind, "evm");
  }

  // --- decideUnsupportedNetwork modes ---
  {
    // Base is scored now, so the unscored-network modes are exercised on a
    // chain that genuinely has no corpus.
    const base = classifyNetwork("eip155:137");
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

  // --- twzrdApprovePayment: Base reaches its own corpus via the preflight ---
  // The preflight serves the Base corpus, so consulting it is not "inventing a
  // Solana reputation" — it is asking the question the corpus can answer.
  {
    let preflightHits = 0;
    const cfg = resolveConfig({
      unsupportedNetworkMode: "observe",
      fetch: (async (input) => {
        const url = String(input);
        if (url.includes("/v1/intel/preflight")) preflightHits += 1;
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
    assert.equal(preflightHits, 1, "Base must consult the preflight");
    assert.equal(r.reputationScored, true);
    // BEHAVIOUR CHANGE, deliberate: the preflight returned HTTP 500 and the
    // documented default is fail-closed, so an unreachable gate now refuses a
    // Base payment. Previously Base skipped the preflight and observe allowed
    // it. Base now fails the same way Solana always has. TWZRD_FAIL_OPEN=true
    // restores the old availability.
    assert.equal(r.approved, false, "unreachable preflight fails closed");
    assert.match(r.reason, /twzrd_fail_closed/);
    assert.equal(r.policyAction, "block");
    assert.equal(r.score, null);
  }

  // --- an UNSCORED chain keeps the observe behaviour Base used to have ---
  {
    let preflightHits = 0;
    const cfg = resolveConfig({
      unsupportedNetworkMode: "observe",
      fetch: (async (input) => {
        const url = String(input);
        if (url.includes("/v1/intel/preflight")) preflightHits += 1;
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    });
    const r = await twzrdApprovePayment(
      {
        payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
        chain: "eip155:137",
        priceUsdc: 0.01,
        agentIntent: "network_test_unscored",
      },
      cfg,
    );
    assert.equal(preflightHits, 0, "an unscored chain must not hit the preflight");
    assert.equal(r.verdict, "unknown");
    assert.equal(r.reason, "network_not_scored");
    assert.equal(r.approved, true, "observe allows unscored (wash fail-open on 500)");
    assert.equal(r.reputationScored, false);
    assert.equal(r.policyAction, "allow");
    assert.equal(r.score, null);
  }

  // --- strict mode blocks an UNSCORED chain before any sign path ---
  // Base is scored now, so strict no longer applies to it. Polygon has no
  // corpus, so it is the case strict mode exists for.
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
        chain: "eip155:137",
        agentIntent: "network_test_strict",
      },
      cfg,
    );
    assert.equal(r.approved, false);
    assert.equal(r.verdict, "unknown");
    assert.equal(r.policyAction, "block");
  }

  // --- Base under strict: scored, so it consults the corpus and fails closed
  // when the gate is unreachable rather than refusing for lack of one.
  {
    const cfg = resolveConfig({
      unsupportedNetworkMode: "strict",
      fetch: (async () => {
        throw new Error("preflight unreachable");
      }) as typeof fetch,
    });
    const r = await twzrdApprovePayment(
      {
        payTo: "0x3803A19280DeeFe533D177C4A169412BD341101b",
        chain: "eip155:8453",
        agentIntent: "network_test_strict_base",
      },
      cfg,
    );
    assert.equal(r.approved, false);
    assert.equal(r.reputationScored, true);
    assert.match(r.reason, /twzrd_fail_closed/);
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
      fetch: (async (input) => {
        const url = String(input);
        if (url.includes("/v1/intel/preflight")) {
          preflightHits += 1;
          // A real Base card: warn, above the floor, cap above this price.
          return new Response(
            JSON.stringify({
              readiness_card: {
                decision: "warn",
                trust_score: 56,
                score: 0.56,
                null_reason: null,
                can_spend: false,
                recommended_cap_usdc: 1.0,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ wash_flagged: false, confidence: "full" }), { status: 200 });
      }) as typeof fetch,
    });
    const gated = wrapFetchWithTwzrdGate(base402, cfg);
    const resp = await gated("https://merchant.example/base-paid");
    assert.equal(resp.status, 402, "a scored, allowed Base seller returns the 402 for the pay client");
    assert.equal(preflightHits, 1, "Base consults its own corpus");
  }

  // --- wrapFetch: an UNSCORED chain 402, strict → throws before pay client ---
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
    // 0.11.2: the payer, not the wrapper, picks the entry it pays, so every
    // distinct offer is scored (one free preflight each).
    assert.equal(preflightHits, 2, "every offer scored");
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

  // --- strict refuses a Solana devnet/testnet named only by its CAIP-2 genesis id ---
  // classifyNetwork still scores those ids. Observe still reaches preflight.
  {
    const DEVNET_ID = "etwtrabzayq6imfeykouru166vu2xqa1";
    const TESTNET_ID = "4uhcvjyu9pjkvqys88urdiswhxscky3z";
    const MAINNET_ID = "5eykt4usfv8p8njdtrepy1vzqkqzkvdp";
    const seller = "SeLLeRWa11et1111111111111111111111111111111";
    for (const id of [DEVNET_ID, `solana:${DEVNET_ID}`, TESTNET_ID, `solana:${TESTNET_ID}`]) {
      assert.equal(classifyNetwork(id).reputationScored, true, id);
      assert.equal(classifyNetwork(id.toUpperCase()).reputationScored, true, id);
    }
    assert.equal(classifyNetwork("solana:devnet").reputationScored, false);
    assert.equal(classifyNetwork(MAINNET_ID).reputationScored, true);

    const probe = (mode: "strict" | "observe") => {
      let preflight = 0;
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v1/intel/preflight")) {
          preflight += 1;
          return new Response(
            JSON.stringify({
              readiness_card: {
                decision: "allow",
                trust_score: 90,
                can_spend: true,
                recommended_cap_usdc: 1,
                seller_wallet: seller,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ wash_flagged: false, confidence: "full", ring_evaluated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      return {
        cfg: resolveConfig({
          unsupportedNetworkMode: mode,
          failOpen: false,
          refuseWashFlagged: true,
          fetch: fetchImpl,
        }),
        preflight: () => preflight,
      };
    };

    for (const chain of [
      DEVNET_ID,
      `solana:${DEVNET_ID}`,
      `SOLANA:${DEVNET_ID.toUpperCase()}`,
      TESTNET_ID,
      `solana:${TESTNET_ID.toUpperCase()}`,
    ]) {
      const { cfg, preflight } = probe("strict");
      const r = await twzrdApprovePayment(
        { payTo: seller, chain, priceUsdc: 0.001, agentIntent: "genesis_strict" },
        cfg,
      );
      assert.equal(r.approved, false, chain);
      assert.equal(r.reason, "network_not_scored", chain);
      assert.equal(preflight(), 0, chain);
    }

    const observe = probe("observe");
    const allowed = await twzrdApprovePayment(
      { payTo: seller, chain: `solana:${DEVNET_ID}`, priceUsdc: 0.001, agentIntent: "genesis_observe" },
      observe.cfg,
    );
    assert.equal(observe.preflight(), 1);
    assert.notEqual(allowed.reason, "network_not_scored");

    const keyword = probe("strict");
    const kw = await twzrdApprovePayment(
      { payTo: seller, chain: "solana:devnet", priceUsdc: 0.001, agentIntent: "keyword_devnet" },
      keyword.cfg,
    );
    assert.equal(kw.approved, false);
    assert.equal(kw.reason, "network_not_scored");
    assert.equal(keyword.preflight(), 0);

    const mainnet = probe("strict");
    const main = await twzrdApprovePayment(
      { payTo: seller, chain: `solana:${MAINNET_ID.toUpperCase()}`, priceUsdc: 0.001, agentIntent: "mainnet_genesis_strict" },
      mainnet.cfg,
    );
    assert.notEqual(main.reason, "network_not_scored");
    assert.notEqual(main.reason, "network_missing");
    assert.equal(mainnet.preflight(), 1);
  }

  console.log("network.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("network.test.ts FAILED:", e);
  process.exit(1);
});
