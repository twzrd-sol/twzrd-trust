/**
 * twzrdOnPaymentRequested contract test (the @x402/mcp hook).
 * Run: npx tsx test/mcp-hook.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { twzrdOnPaymentRequested } from "../src/mcp-hook.js";

const pf = (card: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const req = {
  accepts: [{ payTo: "SELLER", maxAmountRequired: "5000", resource: "https://merchant/surf" }],
  context: { toolName: "surf.market.price" },
};

async function run() {
  // block -> deny (false)
  assert.equal(
    await twzrdOnPaymentRequested(req, resolveConfig({ fetch: pf({ decision: "block", trust_score: 5 }) })),
    false,
  );
  // allow -> permit (true)
  assert.equal(
    await twzrdOnPaymentRequested(req, resolveConfig({ fetch: pf({ decision: "allow", trust_score: 77, can_spend: true }) })),
    true,
  );
  // fail-open -> permit (true)
  assert.equal(
    await twzrdOnPaymentRequested(
      req,
      resolveConfig({ failOpen: true, fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch }),
    ),
    true,
  );

  console.log("mcp-hook.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("mcp-hook.test.ts FAILED:", e);
  process.exit(1);
});
