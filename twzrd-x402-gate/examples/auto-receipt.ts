#!/usr/bin/env -S npx tsx
/**
 * TURN ON REVENUE: autoReceipt.
 *
 * The gate's free preflight blocks bad merchants for $0. The ONLY path that earns
 * TWZRD revenue is the paid trust receipt (GET /v1/intel/trust/{seller}, 0.05 USDC
 * over x402). `autoReceipt: true` auto-fetches it after a non-block verdict, so a
 * buyer that already vets sellers also pulls (and pays for) the signed receipt.
 *
 *   ┌── free preflight (block/warn/allow) ── always on, $0
 *   └── autoReceipt:true + x402Fetch ─────── paid receipt, 0.05 USDC -> TWZRD
 *
 * TWO THINGS THE INTEGRATOR SUPPLIES:
 *   1. `autoReceipt: true`        — opt in (default false; it spends the BUYER's USDC).
 *   2. `x402Fetch`                — an x402-capable fetch that settles the 402 challenge.
 *
 * x402Fetch IS NOT BUNDLED (this package is dependency-free on purpose). Wire the
 * proven `@x402/svm` sponsored-feePayer client (same one twzrd-mcp-server uses, PR
 * #1169). See "PRODUCTION WIRING" at the bottom. A bundled/sponsored x402Fetch (so
 * integrators need no wallet) is the founder-gated next step — see Task #1.
 *
 * Run (no spend, mocked):  npx tsx examples/auto-receipt.ts --dry-run
 */
import {
  evaluate_x402_resource,
  withTwzrdGuard,
  type X402PaymentRequirements,
} from "../src/index.js";

const DRY_RUN = process.argv.includes("--dry-run") || !process.env.TWZRD_X402_LIVE;
const SELLER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// --- dry-run mocks (no network, no on-chain settle) -----------------------
const mockPreflight = (async () =>
  new Response(JSON.stringify({ readiness_card: { decision: "warn", trust_score: 55, can_spend: false } }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

/** Stand-in for a real x402 wallet fetch. In production this SETTLES 0.05 USDC. */
const mockX402Fetch = (async (url: string | URL) => {
  console.log(`   [x402] (dry-run) would settle 0.05 USDC -> GET ${String(url)}`);
  return new Response(JSON.stringify({
    tx: "DRYRUN_SETTLEMENT_TX",
    twzrd_receipt: { v: "V6", seller: SELLER, preimage: { settlement_tx: "DRYRUN_SETTLEMENT_TX" } },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const reqs: X402PaymentRequirements = {
  payTo: SELLER,
  maxAmountRequired: "50000", // 0.05 USDC (micro)
  resource: "https://seller.example/paid",
  network: "solana",
} as X402PaymentRequirements;

async function main() {
  if (!DRY_RUN) {
    console.error("Refusing to run live without a real x402Fetch wired. Use --dry-run, or see PRODUCTION WIRING.");
    process.exit(1);
  }
  console.log("== Pattern A: evaluate_x402_resource (decide + capture receipt) ==");
  const r = await evaluate_x402_resource("https://seller.example/paid", reqs, {
    fetch: mockPreflight,          // free preflight
    autoReceipt: true,             // <-- opt into revenue
    x402Fetch: mockX402Fetch,      // <-- BYO x402 wallet (settles USDC)
    onReceipt: (receipt, tx) => console.log(`   [onReceipt] captured tx=${tx}`),
  });
  console.log(`   decision=${r.decision} approved=${r.approved} feeCaptured=${r.receiptFeeCaptured} tx=${r.receiptTx}`);

  console.log("\n== Pattern B: withTwzrdGuard (wrap your resource fetch) ==");
  const resourceFetch = (async () =>
    new Response(JSON.stringify({ accepts: [{ payTo: SELLER, maxAmountRequired: "50000", network: "solana" }] }), {
      status: 402, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const guarded = withTwzrdGuard(resourceFetch, {
    fetch: mockPreflight,
    autoReceipt: true,
    x402Fetch: mockX402Fetch,
    onReceipt: (_r, tx) => console.log(`   [onReceipt] guard captured tx=${tx}`),
  });
  const resp = await guarded("https://seller.example/paid");
  console.log(`   guard returned status=${resp.status} (caller pays the resource itself)`);

  console.log("\nDone (dry-run — nothing settled on-chain).");
}

/*
 * ── PRODUCTION WIRING ──────────────────────────────────────────────────────
 * import { wrapFetchWithPayment } from "@x402/svm"; // or @x402/fetch
 * import { Keypair } from "@solana/web3.js";
 *
 * const wallet = Keypair.fromSecretKey(...);            // the BUYER's USDC wallet
 * const x402Fetch = wrapFetchWithPayment(fetch, wallet); // settles 402 challenges
 *
 * await evaluate_x402_resource(url, reqs, { autoReceipt: true, x402Fetch });
 * // -> on a warn/allow verdict, 0.05 USDC settles to TWZRD and you get the V6 receipt.
 *
 * NOTE: autoReceipt spends the buyer's USDC on every non-block evaluation. Gate it
 * behind your own ROI policy (e.g. only for payments above a threshold).
 */
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
