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

  // --- REAL @x402/mcp v2 context shape: { toolName, arguments, paymentRequired } ---
  // accepts[] nested under paymentRequired (PaymentRequestedContext in
  // @x402/mcp@2.17.0). Before 0.6.1 this shape was unread -> accepts undefined
  // -> unconditional fail-closed block even for decision:allow.
  const realCtx = {
    toolName: "surf.market.price",
    arguments: { q: "x" },
    paymentRequired: {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          payTo: "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs",
          amount: "1000",
        },
      ],
    },
  };
  assert.equal(
    await twzrdOnPaymentRequested(
      realCtx,
      resolveConfig({
        fetch: pf({
          decision: "allow",
          trust_score: 77,
          can_spend: true,
          seller_wallet: "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs",
        }),
      }),
    ),
    true,
    "real @x402/mcp context shape allows on decision:allow",
  );
  assert.equal(
    await twzrdOnPaymentRequested(
      realCtx,
      resolveConfig({ fetch: pf({ decision: "block", trust_score: 5 }) }),
    ),
    false,
    "real @x402/mcp context shape denies on decision:block",
  );

  console.log("mcp-hook.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("mcp-hook.test.ts FAILED:", e);
  process.exit(1);
});
