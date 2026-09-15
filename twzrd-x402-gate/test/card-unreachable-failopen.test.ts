/**
 * Regression: a merchant_card OUTAGE must obey failOpen, and a reachable card
 * with no wash signal must still fail open.
 *
 * Root cause this locks: fetchMerchantCard caught its own errors and returned
 * null, so "intel is down" and "intel answered, no wash signal" arrived at the
 * wash policy as the same value and both allowed. The surrounding try/catch in
 * twzrdApprovePayment that honours cfg.failOpen never saw the error, so
 * failOpen:false — the documented default, "block and log loudly on preflight
 * outage" — could not be enforced on the engine that 0.9.4 made the default.
 *
 * BlockRunAI/ClawRouter removed the integration over exactly this
 * (v0.12.278 notes, 2026-09-07): "The package converts a fast lookup failure —
 * 503, 404, fetch failed, invalid JSON, its own 3s timeout — into allow
 * internally, and ignores the failOpen we pass."
 *
 * The two unknowns are NOT the same and this pins both:
 *   unreachable        -> decided by failOpen (fail-closed by default)
 *   reachable, no flag -> always allow (the no-invent rule, unchanged)
 *
 * Run: npx tsx test/card-unreachable-failopen.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";

const PAYTO = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";

/** Card lookups fail the given way; preflight always answers allow. */
function cardFailingFetch(mode: "http503" | "http429" | "http404" | "badjson" | "throw"): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/v1/intel/preflight")) {
      return new Response(
        JSON.stringify({
          readiness_card: { decision: "allow", trust_score: 80, can_spend: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/intel/merchant_card/")) {
      if (mode === "throw") throw new Error("ECONNREFUSED");
      if (mode === "http503") return new Response("upstream down", { status: 503 });
      if (mode === "http429") return new Response("slow down", { status: 429 });
      if (mode === "http404") return new Response("nope", { status: 404 });
      // valid HTTP 200 whose body is not a JSON object
      return new Response("<html>captive portal</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
}

/** Card is reachable and answers 200 with a body that carries no wash_flagged. */
const cardNoSignalFetch: typeof fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/v1/intel/preflight")) {
    return new Response(
      JSON.stringify({
        readiness_card: { decision: "allow", trust_score: 80, can_spend: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.includes("/v1/intel/merchant_card/")) {
    // in_corpus but never wash-evaluated: wash_flagged absent entirely
    return new Response(JSON.stringify({ merchant: PAYTO, in_corpus: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 500 });
}) as unknown as typeof fetch;

async function run() {
  // Outages only: a 4xx is intel answering, not intel being down (see section 5).
  const modes = ["http503", "http429", "badjson", "throw"] as const;

  // --- 1. unreachable + failOpen:false (the DEFAULT) must refuse before sign ---
  for (const mode of modes) {
    const r = await twzrdApprovePayment(
      { payTo: PAYTO, chain: "solana", priceUsdc: 0.05 },
      resolveConfig({
        refuseWashFlagged: true,
        failOpen: false,
        fetch: cardFailingFetch(mode),
      }),
    );
    assert.equal(r.approved, false, `${mode}: outage must refuse when failOpen=false`);
    assert.equal(r.verdict, "block", `${mode}: verdict`);
    assert.match(
      r.reason,
      /^twzrd_card_unreachable_fail_closed/,
      `${mode}: reason must name the outage, not a wash verdict (got ${r.reason})`,
    );
    assert.equal(
      r.washFlagged,
      null,
      `${mode}: must not invent a wash verdict from an outage`,
    );
  }
  console.log("ok  merchant_card outage refuses under failOpen=false (503/429/bad-json/throw)");

  // --- 2. same outages with failOpen:true must proceed (opt-in legacy) ---
  for (const mode of modes) {
    const r = await twzrdApprovePayment(
      { payTo: PAYTO, chain: "solana", priceUsdc: 0.05 },
      resolveConfig({
        refuseWashFlagged: true,
        failOpen: true,
        fetch: cardFailingFetch(mode),
      }),
    );
    assert.equal(r.approved, true, `${mode}: failOpen=true must proceed`);
    assert.ok(
      !/fail_closed/.test(r.reason),
      `${mode}: must not report fail-closed when the caller opted open (got ${r.reason})`,
    );
  }
  console.log("ok  the same outages proceed under failOpen=true (opt-in preserved)");

  // --- 3. REACHABLE card with no wash signal still fails open, even failOpen:false.
  //        This is the no-invent rule and must not regress into a refusal. ---
  {
    const r = await twzrdApprovePayment(
      { payTo: PAYTO, chain: "solana", priceUsdc: 0.05 },
      resolveConfig({
        refuseWashFlagged: true,
        failOpen: false,
        fetch: cardNoSignalFetch,
      }),
    );
    assert.equal(
      r.approved,
      true,
      "a reachable card carrying no wash_flagged is a genuine unknown, not an outage",
    );
    assert.equal(r.washFlagged, null, "no signal stays null, never invented");
    assert.ok(!/unreachable/.test(r.reason), `must not be reported as an outage (got ${r.reason})`);
  }
  console.log("ok  reachable card with no wash signal still allows (no-invent rule intact)");

  // --- 4. the lookup primitive itself distinguishes the two ---
  //     Imported dynamically so sections 1-3 still LOAD against a build that
  //     lacks this symbol -- that is what makes the red run demonstrate the
  //     behaviour (an outage allowing) instead of a module-resolution error.
  {
    const { fetchMerchantCardResult } = await import("../src/merchant-card.js");
    const down = await fetchMerchantCardResult(PAYTO, {
      intelBase: "https://intel.example",
      fetch: cardFailingFetch("http503"),
    });
    assert.equal(down.reachable, false, "503 is unreachable");
    assert.equal(down.card, null);
    assert.match((down as { error: string }).error, /^http_503$/);

    const up = await fetchMerchantCardResult(PAYTO, {
      intelBase: "https://intel.example",
      fetch: cardNoSignalFetch,
    });
    assert.equal(up.reachable, true, "200 + JSON object is reachable");
    assert.equal(up.card?.in_corpus, true);
    assert.equal(up.card?.wash_flagged, undefined, "reachable with no signal");

    // empty wallet is nothing to look up, not an outage
    const none = await fetchMerchantCardResult("  ", {
      intelBase: "https://intel.example",
      fetch: cardFailingFetch("throw"),
    });
    assert.equal(none.reachable, true, "no wallet is not an outage");
    assert.equal(none.card, null);
  }
  console.log("ok  fetchMerchantCardResult separates outage from no-signal");

  // --- 5. a 4xx is NOT an outage: the service answered and has nothing.
  //        Live intel returns 200 + wash_flagged:null for an unscored wallet and
  //        400 for a malformed address, so 4xx must never refuse -- otherwise
  //        every unscored recipient blocks under the default failOpen=false,
  //        which is the over-refusal that got this gate removed downstream. ---
  for (const status of ["http404" as const]) {
    const r = await twzrdApprovePayment(
      { payTo: PAYTO, chain: "solana", priceUsdc: 0.05 },
      resolveConfig({
        refuseWashFlagged: true,
        failOpen: false,
        fetch: cardFailingFetch(status),
      }),
    );
    assert.equal(r.approved, true, `${status}: a 4xx must not be treated as an outage`);
    assert.ok(
      !/unreachable/.test(r.reason),
      `${status}: must not report an outage (got ${r.reason})`,
    );
    assert.equal(r.washFlagged, null, `${status}: no signal, none invented`);
  }
  console.log("ok  a 4xx answer does not refuse (unscored recipients still proceed)");

  // --- 6. the outage refusal only TIGHTENS: it must not relabel a payment that
  //        was already refused for a more specific reason. The caller needs the
  //        real cause (twzrd_decision_block), and a denied payment is denied
  //        either way. Pinned by clawrouter-contract.test.ts, which asserts the
  //        thrown message names the decision -- restated here at the policy
  //        level so the reason is owned by this file's contract too. ---
  {
    const r = await twzrdApprovePayment(
      { payTo: PAYTO, chain: "solana", priceUsdc: 0.05 },
      resolveConfig({
        refuseWashFlagged: true,
        failOpen: false,
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("/v1/intel/preflight")) {
            return new Response(
              JSON.stringify({
                readiness_card: { decision: "block", trust_score: 9, can_spend: false },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          // card is down at the same time
          return new Response("upstream down", { status: 503 });
        }) as unknown as typeof fetch,
      }),
    );
    assert.equal(r.approved, false, "a blocked decision stays blocked");
    assert.match(
      r.reason,
      /twzrd_decision_block/,
      `a prior deny keeps its own reason, not the outage's (got ${r.reason})`,
    );
    assert.ok(
      !/unreachable/.test(r.reason),
      `outage must not relabel a more specific refusal (got ${r.reason})`,
    );
  }
  console.log("ok  an outage never relabels a payment already refused (only tightens)");

  // --- 7. unscored network in observe mode: a card OUTAGE keeps the observe
  //        allow. The operator chose "allow what you cannot score" for a chain
  //        that gets no trust signal at all, so refusing it on a wash-lookup
  //        hiccup is over-refusal, not safety. strict blocks that path before
  //        intel is called. Pinned by network.test.ts ("wash fail-open on 500").
  //        A wash_flagged=true payTo on that same path still refuses -- wash is
  //        wallet-keyed and chain-neutral -- which is what keeps this narrow. ---
  {
    const base = "0x3803A19280DeeFe533D177C4A169412BD341101b";
    // Polygon, not Base: Base is scored now, so it no longer takes the
    // unscored-observe path this case exists to pin. On Base a preflight
    // outage is a fail-closed refusal, which network.test.ts pins.
    const r = await twzrdApprovePayment(
      { payTo: base, chain: "eip155:137", priceUsdc: 0.01 },
      resolveConfig({
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: true,
        failOpen: false,
        fetch: (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch,
      }),
    );
    assert.equal(r.approved, true, "observe on an unscored chain keeps its allow on a card outage");
    assert.equal(r.verdict, "unknown", "and does not invent a block verdict");
    assert.equal(r.reason, "network_not_scored", `reason stays the network one (got ${r.reason})`);

    // ...but a wash_flagged=true seller on the same unscored path still refuses.
    const flagged = await twzrdApprovePayment(
      { payTo: base, chain: "eip155:137", priceUsdc: 0.01 },
      resolveConfig({
        unsupportedNetworkMode: "observe",
        refuseWashFlagged: true,
        failOpen: false,
        fetch: (async (input: string | URL | Request) =>
          String(input).includes("/v1/intel/merchant_card/")
            ? new Response(JSON.stringify({ merchant: base, wash_flagged: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : new Response("{}", { status: 500 })) as unknown as typeof fetch,
      }),
    );
    assert.equal(flagged.approved, false, "a wash_flagged payTo refuses on any chain");
    assert.equal(flagged.washFlagged, true);
  }
  console.log("ok  unscored+observe keeps its allow on an outage, still refuses a flagged payTo");

  // --- 8. stock beforePayment seat (the ClawRouter / PayAI path): a card
  //        outage under the default failOpen=false must abort BEFORE sign.
  //        Existing x402-solana-before-payment tests all pass failOpen:true,
  //        so they cannot catch this. ---
  {
    let signed = 0;
    const hook = createTwzrdBeforePaymentHook({
      refuseWashFlagged: true,
      failOpen: false,
      fetch: cardFailingFetch("http503"),
    });
    const outcome = await hook({
      payTo: PAYTO,
      network: "solana",
      amount: "1000",
      resource: "https://merchant.example/paid",
    });
    if (outcome && "abort" in outcome && outcome.abort) {
      assert.match(
        outcome.reason,
        /twzrd_card_unreachable_fail_closed/,
        `hook must name the outage (got ${outcome.reason})`,
      );
    } else {
      signed += 1;
      assert.fail("hook must abort on scored-path card 503; void means the client would sign");
    }
    assert.equal(signed, 0, "signer_invocation_count stays 0");
  }
  console.log("ok  createTwzrdBeforePaymentHook aborts on card 503 before sign (failOpen=false)");

  // --- 9. wrapFetch (the other public 402 seat): same outage must throw
  //        before the caller can attach payment. clawrouter-contract only
  //        covers preflight block/allow and failOpen:true. ---
  {
    const merchant402: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          accepts: [{ payTo: PAYTO, network: "solana", maxAmountRequired: "1000" }],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const gated = wrapFetchWithTwzrdGate(
      merchant402,
      resolveConfig({
        refuseWashFlagged: true,
        failOpen: false,
        fetch: cardFailingFetch("http503"),
      }),
    );
    await assert.rejects(
      () => gated("https://merchant.example/paid"),
      /twzrd_card_unreachable_fail_closed/,
    );
  }
  console.log("ok  wrapFetch throws on card 503 before the caller can pay (failOpen=false)");

  console.log("card-unreachable-failopen.test.ts: ALL PASSED");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
