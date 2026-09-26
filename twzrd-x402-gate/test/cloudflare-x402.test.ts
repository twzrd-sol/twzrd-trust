/** Cloudflare Agents x402 onPaymentRequired adapter contract. */
import assert from "node:assert/strict";

import { createTwzrdCloudflareX402Approval } from "../src/cloudflare-x402.js";

const BASE_PAY_TO = "0x3803A19280DeeFe533D177C4A169412BD341101b";

const baseRequirements = {
  x402Version: 2,
  resource: "https://worker.example/mcp",
  accepts: [
    {
      network: "eip155:8453",
      payTo: BASE_PAY_TO,
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
  ],
};

/** Preflight always answers a scored Base warn; merchant_card is unreachable (500). */
function baseWarnCardOutageFetch(hits: { preflight: number; card: number }): typeof fetch {
  return (async (url) => {
    const u = String(url);
    if (u.includes("/v1/intel/preflight")) {
      hits.preflight += 1;
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
    if (u.includes("/v1/intel/merchant_card")) {
      hits.card += 1;
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
}

async function run() {
  // Base is scored from its own corpus (x402_base_daily), so it consults the
  // preflight rather than being waved through as an unknown. No Solana
  // reputation is invented: the card returned here is the Base card. The
  // merchant_card wash brake still runs on top, and an outage on that brake
  // is decided by failOpen — fail-closed by default (see
  // test/card-unreachable-failopen.test.ts, #2845 / 0.9.10): a merchant_card
  // outage must never collapse into a silent allow regardless of what the
  // Base preflight itself said.
  {
    const hits = { preflight: 0, card: 0 };
    const approve = createTwzrdCloudflareX402Approval({
      unsupportedNetworkMode: "observe",
      fetch: baseWarnCardOutageFetch(hits),
    });
    assert.equal(
      await approve(baseRequirements),
      false,
      "merchant_card outage must fail closed by default, even for a scored Base warn",
    );
    assert.equal(hits.preflight, 1, "Base consults its own corpus");
    assert.equal(hits.card, 1, "wash brake still fetches merchant_card");
  }

  // Same outage, but the caller opted into legacy failOpen: the Cloudflare
  // adapter must still honour it and let the scored Base warn proceed.
  {
    const hits = { preflight: 0, card: 0 };
    const approve = createTwzrdCloudflareX402Approval({
      unsupportedNetworkMode: "observe",
      failOpen: true,
      fetch: baseWarnCardOutageFetch(hits),
    });
    assert.equal(
      await approve(baseRequirements),
      true,
      "failOpen:true must still proceed through a merchant_card outage",
    );
    assert.equal(hits.preflight, 1, "Base consults its own corpus");
    assert.equal(hits.card, 1, "wash brake still fetches merchant_card");
  }

  // Measured wash on Base still refuses, now on top of a real scored card.
  {
    let preflightHits = 0;
    const approve = createTwzrdCloudflareX402Approval({
      unsupportedNetworkMode: "observe",
      fetch: (async (url) => {
        const u = String(url);
        if (u.includes("/v1/intel/preflight")) {
          preflightHits += 1;
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
        return new Response(
          JSON.stringify({
            merchant: BASE_PAY_TO,
            wash_flagged: true,
            wash_confidence: "full",
            ring_evaluated: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    assert.equal(await approve(baseRequirements), false);
    assert.equal(preflightHits, 1);
  }

  // Strict mode is now about chains with no corpus at all. Base has one, so a
  // strict posture no longer blocks it outright; an unreachable gate does,
  // because the documented default is fail-closed.
  {
    let preflightHits = 0;
    const approve = createTwzrdCloudflareX402Approval({
      unsupportedNetworkMode: "strict",
      fetch: (async () => {
        preflightHits += 1;
        throw new Error("strict Base must fail before Solana preflight");
      }) as typeof fetch,
    });
    assert.equal(await approve(baseRequirements), false);
    assert.equal(preflightHits, 1, "strict still consults the Base corpus");
  }

  // A malformed payment request never receives automatic approval.
  {
    const approve = createTwzrdCloudflareX402Approval({
      unsupportedNetworkMode: "observe",
    });
    assert.equal(await approve({ x402Version: 2, accepts: [] }), false);
  }

  console.log("cloudflare-x402.test.ts: ALL PASSED");
}

run().catch((error) => {
  console.error("cloudflare-x402.test.ts FAILED:", error);
  process.exit(1);
});
