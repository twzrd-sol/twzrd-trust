/**
 * autoReceipt revenue-path contract test (no real network / no real x402 spend).
 * Run: npx tsx test/auto-receipt.test.ts
 *
 * Locks the ONE code path that earns revenue: evaluate_x402_resource +
 * withTwzrdGuard auto-fetching the PAID /v1/intel/trust receipt via the
 * caller-supplied x402Fetch after a non-block verdict. Mocks both the free
 * preflight (config.fetch) and the paid x402Fetch — nothing settles on-chain.
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import type { X402PaymentRequirements } from "../src/types.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const REQS: X402PaymentRequirements = {
  payTo: SELLER,
  maxAmountRequired: "50000", // 0.05 USDC (micro)
  resource: "https://seller.example/paid",
  network: "solana",
} as X402PaymentRequirements;

/** Free-preflight mock: returns a readiness_card with the given decision. */
const preflight = (card: Record<string, unknown>): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

/** Paid x402Fetch mock: records calls, returns the given trust-receipt body. */
function x402Mock(body: unknown, status = 200) {
  const calls: Array<{ url: string }> = [];
  const fn = (async (url: string | URL) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { calls: typeof calls };
  (fn as { calls: typeof calls }).calls = calls;
  return fn as typeof fetch & { calls: typeof calls };
}

const RECEIPT = { score: 80, preimage: { settlement_tx: "TX_PRE" } };

async function run() {
  // 1. warn + autoReceipt=true -> paid receipt captured, onReceipt fires, fee captured.
  {
    const x402 = x402Mock({ tx: "TX_AAA", twzrd_receipt: RECEIPT });
    let seenTx: string | undefined;
    let seenReceipt: unknown;
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "warn", trust_score: 45, can_spend: false }),
      autoReceipt: true,
      x402Fetch: x402,
      onReceipt: (receipt, tx) => { seenReceipt = receipt; seenTx = tx; },
    });
    assert.equal(x402.calls.length, 1, "warn must trigger one paid receipt call");
    assert.match(x402.calls[0].url, /\/v1\/intel\/trust\//, "receipt call hits the paid trust endpoint");
    assert.match(x402.calls[0].url, new RegExp(SELLER), "receipt call targets the seller wallet");
    assert.deepEqual(r.receipt, RECEIPT, "receipt body returned on result");
    assert.equal(r.receiptTx, "TX_AAA", "tx taken from body.tx");
    assert.equal(r.receiptFeeCaptured, true, "fee captured when tx present");
    assert.equal(seenTx, "TX_AAA", "onReceipt got the tx");
    assert.deepEqual(seenReceipt, RECEIPT, "onReceipt got the receipt");
    assert.equal(r.approved, true, "warn still approves resource access");
  }

  // 2. block + autoReceipt=true -> NO paid call (never pay to vet a blocked seller).
  {
    const x402 = x402Mock({ tx: "SHOULD_NOT_HAPPEN" });
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "block", trust_score: 10 }),
      autoReceipt: true,
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 0, "block decision must NOT trigger a paid receipt");
    assert.equal(r.receipt, undefined, "no receipt on block");
    assert.equal(r.approved, false, "block denies the resource");
  }

  // 3. allow + autoReceipt=true -> paid call fires (allow is also non-block).
  {
    const x402 = x402Mock({ tx: "TX_ALLOW", twzrd_receipt: RECEIPT });
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "allow", trust_score: 90, can_spend: true }),
      autoReceipt: true,
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 1, "allow triggers the paid receipt too");
    assert.equal(r.receiptTx, "TX_ALLOW");
  }

  // 4. autoReceipt=false -> never calls x402Fetch even on warn (off by default).
  {
    const x402 = x402Mock({ tx: "NOPE" });
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "warn", trust_score: 45 }),
      autoReceipt: false,
      x402Fetch: x402,
    });
    assert.equal(x402.calls.length, 0, "autoReceipt=false must not spend");
    assert.equal(r.receipt, undefined);
    assert.equal(r.receiptUrl?.includes("/v1/intel/trust/"), true, "receiptUrl still surfaced for manual upsell");
  }

  // 5. x402Fetch throws -> fail-open: resource access preserved, no receipt, no throw.
  {
    const throwing = (async () => { throw new Error("x402 settle failed"); }) as unknown as typeof fetch;
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "warn", trust_score: 45 }),
      autoReceipt: true,
      x402Fetch: throwing,
    });
    assert.equal(r.receipt, undefined, "no receipt when x402 settle throws");
    assert.equal(r.approved, true, "receipt failure must NOT block resource access (fail-open upsell)");
  }

  // 6. fee-capture detection variants.
  {
    // tx_pending
    let r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "warn", trust_score: 45 }),
      autoReceipt: true, x402Fetch: x402Mock({ tx_pending: "TX_PEND", twzrd_receipt: {} }),
    });
    assert.equal(r.receiptTx, "TX_PEND", "tx falls back to tx_pending");
    assert.equal(r.receiptFeeCaptured, true);
    // preimage.settlement_tx
    r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "warn", trust_score: 45 }),
      autoReceipt: true, x402Fetch: x402Mock({ twzrd_receipt: { preimage: { settlement_tx: "TX_PRE2" } } }),
    });
    assert.equal(r.receiptTx, "TX_PRE2", "tx falls back to preimage.settlement_tx");
    // charged=true, no tx
    r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "warn", trust_score: 45 }),
      autoReceipt: true, x402Fetch: x402Mock({ charged: true, twzrd_receipt: {} }),
    });
    assert.equal(r.receiptTx, undefined, "no tx string present");
    assert.equal(r.receiptFeeCaptured, true, "charged=true still counts as fee captured");
  }

  // 7. withTwzrdGuard integration: a 402 + warn -> paid receipt fires through the guard.
  {
    const x402 = x402Mock({ tx: "TX_GUARD", twzrd_receipt: RECEIPT });
    const resourceFetch = (async () =>
      new Response(JSON.stringify({ accepts: [{ payTo: SELLER, maxAmountRequired: "50000", network: "solana", resource: "https://seller.example/paid" }] }), {
        status: 402, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const guarded = withTwzrdGuard(resourceFetch, {
      fetch: preflight({ decision: "warn", trust_score: 45 }),
      autoReceipt: true,
      x402Fetch: x402,
    });
    const resp = await guarded("https://seller.example/paid");
    assert.equal(resp.status, 402, "guard returns the original 402 for the caller to pay the resource");
    assert.equal(x402.calls.length, 1, "guard auto-fetched the paid receipt on the warn verdict");
  }

  console.log("auto-receipt.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("auto-receipt.test.ts FAILED:", e);
  process.exit(1);
});
