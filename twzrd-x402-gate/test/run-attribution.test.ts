/**
 * Run-attribution contract: the gate stamps X-TWZRD-Integration / X-TWZRD-Run-Id /
 * X-TWZRD-Client on the TWZRD *preflight* request (and no other request), and only
 * when attribution is configured. This is correlation evidence for counting external
 * executions — the runId is caller-supplied and spoofable, so a run only counts when
 * the same runId is echoed by the integrator AND observed server-side from
 * non-internal lineage.
 * Run: npx tsx test/run-attribution.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { twzrdPreflight } from "../src/policy.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { CLIENT_VERSION } from "../src/version.js";
import type { TwzrdPreflightInput } from "../src/types.js";

const INPUT: TwzrdPreflightInput = { resource_name: "r", seller_wallet: "SELLER" };
const CARD = {
  readiness_card: { decision: "block", trust_score: 10, seller_wallet: "SELLER" },
  preflight_id: 1,
};

/** A fetch stub that records the URL + headers of every call. */
function recordingFetch(): { fetch: typeof fetch; calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: unknown, init?: { headers?: HeadersInit }) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(CARD), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

async function run() {
  // A. default (no attribution) -> no attribution headers on preflight
  {
    const { fetch, calls } = recordingFetch();
    await twzrdPreflight(INPUT, resolveConfig({ fetch }));
    const h = calls[0].headers;
    assert.equal(h.get("x-twzrd-integration"), null, "no integration header by default");
    assert.equal(h.get("x-twzrd-run-id"), null, "no run-id header by default");
    assert.equal(h.get("x-twzrd-client"), null, "no client header by default");
  }

  // B. configured -> all three headers present with exact values
  {
    const { fetch, calls } = recordingFetch();
    await twzrdPreflight(
      INPUT,
      resolveConfig({ fetch, attribution: { integration: "payai-x402-solana-pr38", runId: "run-abc-123" } }),
    );
    const h = calls[0].headers;
    assert.equal(h.get("x-twzrd-integration"), "payai-x402-solana-pr38");
    assert.equal(h.get("x-twzrd-run-id"), "run-abc-123");
    assert.equal(h.get("x-twzrd-client"), `twzrd-x402-gate/${CLIENT_VERSION}`);
  }

  // C. partial config (integration without runId) -> NOT stamped (no partial attribution)
  {
    const { fetch, calls } = recordingFetch();
    await twzrdPreflight(
      INPUT,
      resolveConfig({ fetch, attribution: { integration: "x" } as { integration: string; runId: string } }),
    );
    assert.equal(
      calls[0].headers.get("x-twzrd-integration"),
      null,
      "partial attribution (missing runId) is not stamped",
    );
  }

  // D. end-to-end via withTwzrdGuard + preflight-only scoping: the preflight carries the
  //    headers; the guarded resource fetch and any non-preflight call do NOT.
  {
    const { fetch: intelFetch, calls: intelCalls } = recordingFetch();
    const resourceHeaders: Headers[] = [];
    const innerFetch = (async (_url: unknown, init?: { headers?: HeadersInit }) => {
      resourceHeaders.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify({
          accepts: [
            {
              scheme: "exact",
              network: "solana",
              payTo: "SELLER",
              maxAmountRequired: "50000",
              resource: "https://m/paid",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const guarded = withTwzrdGuard(innerFetch, {
      fetch: intelFetch,
      attribution: { integration: "payai-x402-solana-pr38", runId: "run-e2e-9" },
    });
    // decision=block -> the guard throws; we only care about which requests were stamped.
    await guarded("https://m/paid").catch(() => {});

    const preflightCall = intelCalls.find((c) => c.url.includes("/v1/intel/preflight"));
    assert.ok(preflightCall, "preflight was called end-to-end");
    assert.equal(preflightCall!.headers.get("x-twzrd-integration"), "payai-x402-solana-pr38");
    assert.equal(preflightCall!.headers.get("x-twzrd-run-id"), "run-e2e-9");
    assert.equal(preflightCall!.headers.get("x-twzrd-client"), `twzrd-x402-gate/${CLIENT_VERSION}`);

    // The guarded resource fetch never carries attribution headers.
    assert.ok(resourceHeaders.length > 0, "resource fetch happened");
    for (const h of resourceHeaders) {
      assert.equal(h.get("x-twzrd-integration"), null, "resource fetch must NOT carry attribution");
    }
    // No non-preflight intel call (e.g. merchant card) carries the header either.
    for (const c of intelCalls) {
      if (!c.url.includes("/v1/intel/preflight")) {
        assert.equal(
          c.headers.get("x-twzrd-integration"),
          null,
          `only preflight is stamped, not ${c.url}`,
        );
      }
    }
  }

  console.log("run-attribution.test.ts: OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
