/**
 * sponsored x402Fetch seam — no real settle, no real spend.
 * Run: npx tsx test/sponsored.test.ts
 *
 * Locks the friction-killer seam: createSponsoredX402Fetch delegates to a sponsor
 * `settle` backend (or a dry-run mock) and plugs straight into quickCheck/autoReceipt
 * so a no-wallet integrator can use the paid rungs.
 */
import assert from "node:assert/strict";

import { createSponsoredX402Fetch } from "../src/sponsored.js";
import { quickCheck } from "../src/quick.js";

const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

async function run() {
  // 1. delegates to the sponsor `settle` backend, fires onSettle with the URL.
  {
    const seen: string[] = [];
    const settle = (async (url: string) => new Response(JSON.stringify({ ok: true, url }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    const f = createSponsoredX402Fetch({ settle, onSettle: (u) => seen.push(u) });
    const resp = await f("https://intel.twzrd.xyz/v1/intel/quick/X");
    const body = await resp.json() as { ok: boolean; url: string };
    assert.equal(body.ok, true, "delegates to settle");
    assert.equal(seen.length, 1, "onSettle fired once");
    assert.match(seen[0], /\/v1\/intel\/quick\/X/, "onSettle got the URL");
  }

  // 2. dryRun -> mock 200, never calls settle (no spend).
  {
    let called = false;
    const settle = (async () => { called = true; return new Response("{}"); }) as unknown as (u: string) => Promise<Response>;
    const f = createSponsoredX402Fetch({ settle, dryRun: true, dryRunBody: { sponsored_dry_run: true } });
    const resp = await f("https://x/y");
    assert.equal(resp.status, 200);
    assert.equal(called, false, "dryRun must not call the real settle backend");
  }

  // 3. no settle + no dryRun -> still returns a mock 200 (seam is demonstrable, never throws).
  {
    const f = createSponsoredX402Fetch({});
    const resp = await f("https://x/y");
    assert.equal(resp.status, 200, "no backend -> mock, not a throw");
    const body = await resp.json() as { sponsored_dry_run?: boolean };
    assert.equal(body.sponsored_dry_run, true);
  }

  // 4. NO-WALLET INTEGRATION: a sponsored (dry-run) fetch drives quickCheck end-to-end.
  {
    const x402Fetch = createSponsoredX402Fetch({
      dryRun: true,
      dryRunBody: { pubkey: SELLER, tier: "Gold", score: 120, paid: true, charged_amount_usdc: 0.001 },
    });
    const r = await quickCheck(SELLER, { x402Fetch });
    assert.equal(r.available, true, "no-wallet integrator gets a quick result via the sponsor seam");
    assert.equal(r.tier, "Gold");
    assert.equal(r.score, 120);
  }

  console.log("sponsored.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("sponsored.test.ts FAILED:", e);
  process.exit(1);
});
