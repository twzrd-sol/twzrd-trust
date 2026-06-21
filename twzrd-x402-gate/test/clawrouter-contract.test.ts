/**
 * Over-the-wire "ClawRouter-shaped 402" contract test (for the exposed-402 path).
 *
 * Stands up a real loopback HTTP server that emits a BlockRun-shaped x402 402
 * (the exact shape `@blockrun/clawrouter`'s :8402 proxy *would* return if it exposed
 * the 402 to the caller), wraps the REAL global fetch with the gate, and proves:
 *   - decision=block  -> gate throws BEFORE the caller signs USDC
 *   - decision=allow  -> original 402 is returned so the x402 client pays + retries
 *   - preflight down  -> fail-open returns the 402 (never hard-blocks)
 *
 * Note: This tests the *exposed 402 contract* the gate can actually see. The real
 * ClawRouter proxy signs internally and returns 200, so wrap-fetch never triggers
 * against it (use the pre-proxy hook in twzrd-clawrouter skill instead).
 *
 * Run: npx tsx test/clawrouter-contract.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { resolveConfig } from "../src/config.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";

const PAYTO = "BLOCKRUN_TREASURY_WALLET";

async function withMockProxy(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        x402Version: 1,
        error: "payment_required",
        accepts: [
          {
            scheme: "exact",
            network: "solana",
            maxAmountRequired: "3000",
            resource: `https://blockrun.ai${req.url}`,
            payTo: PAYTO,
            asset: "USDC",
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const preflight = (card: unknown): typeof fetch =>
  (async (url: unknown) => {
    assert.ok(String(url).endsWith("/v1/intel/preflight"), "gate must hit the free preflight endpoint");
    return new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

async function run() {
  await withMockProxy(async (base) => {
    const paidUrl = `${base}/v1/surf/market/price?symbol=BTC`;

    // 1. BLOCK -> the real global fetch hits the proxy, gets a 402 over the wire,
    //    gate runs preflight on payTo and throws before any USDC is signed.
    {
      const cfg = resolveConfig({ fetch: preflight({ decision: "block", trust_score: 9, can_spend: false }) });
      const gated = wrapFetchWithTwzrdGate(fetch, cfg);
      await assert.rejects(() => gated(paidUrl), /payment blocked: twzrd_decision_block/);
      console.log("  PASS: block decision aborts BEFORE pay (over the wire)");
    }

    // 2. ALLOW -> original 402 returned for the x402 client to pay + retry.
    {
      const cfg = resolveConfig({ fetch: preflight({ decision: "allow", trust_score: 86, can_spend: true }) });
      const gated = wrapFetchWithTwzrdGate(fetch, cfg);
      const resp = await gated(paidUrl);
      assert.equal(resp.status, 402);
      const body = await resp.json();
      assert.equal(body.accepts[0].payTo, PAYTO, "approved 402 is intact for the payer");
      console.log("  PASS: allow returns the intact 402 for the payer");
    }

    // 3. FAIL-OPEN -> preflight unreachable must not hard-block ClawRouter usage.
    {
      const cfg = resolveConfig({
        failOpen: true,
        fetch: (async () => {
          throw new Error("preflight unreachable");
        }) as unknown as typeof fetch,
      });
      const gated = wrapFetchWithTwzrdGate(fetch, cfg);
      const resp = await gated(paidUrl);
      assert.equal(resp.status, 402);
      console.log("  PASS: fail-open returns the 402 (no hard block)");
    }
  });

  console.log("clawrouter-contract.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("clawrouter-contract.test.ts FAILED:", e);
  process.exit(1);
});
