/**
 * requireLogInclusion wired to the REAL offline verifier, against a REAL
 * receipt and the proof the log served for it.
 * Run: npx tsx test/log-inclusion-offline.test.ts
 *
 * The gate takes no dependency on twzrd-log-verifier — hosts inject it. This
 * test is the proof that the injection seam fits the verifier with no adapter:
 * `verifyLogInclusion`'s result is a `LogInclusionVerdict` structurally, and
 * the whole paid response the seam passes is exactly what the offline
 * verifier consumes. It imports the sibling workspace's SOURCE (tsx resolves
 * it; no build needed) precisely so a signature drift on either side fails
 * here rather than in a host's integration.
 *
 * The receipt is one the paid trust endpoint issued on 2026-11-13 and the
 * block is the inclusion proof the log served for its leaf (index 19 of 20),
 * the same pair docs/verify-intel-receipt.md walks through. The gate checks
 * the receipt's signature and recomputes its leaf before the verifier runs,
 * so a leaf with no signed receipt behind it (the log's genesis leaf, which
 * this file used before) cannot stand in for one. If the pair stops
 * verifying, a pinned key changed or history was rewritten; either is worth
 * knowing. The genesis block stays pinned in twzrd-log-verifier's own suite.
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { verifyLogInclusion } from "../../twzrd-log-verifier/src/client.js";
import { DEFAULT_STH_PUBKEY } from "../../twzrd-log-verifier/src/index.js";
import {
  REAL_LEAF,
  REAL_LOG_INCLUSION,
  REAL_RECEIPT,
  signTestReceipt,
  TEST_RECEIPT_PUBKEY,
} from "./helpers/receipts.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const REQS: X402PaymentRequirements = {
  payTo: SELLER,
  maxAmountRequired: "50000",
  resource: "https://seller.example/paid",
  network: "solana",
} as X402PaymentRequirements;

const preflight = (card: Record<string, unknown>): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ readiness_card: card, wash_flagged: false, confidence: "full" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const x402 = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const WARN = { decision: "warn", trust_score: 45, can_spend: false, recommended_cap_usdc: 1000 };

const LIVE_RECEIPT = REAL_RECEIPT;
const LIVE_BLOCK = REAL_LOG_INCLUSION;

/** The documented wiring: offline against the attached block, no adapter. */
const offline = async (_receipt: unknown, ctx: { response: unknown }) =>
  verifyLogInclusion(ctx.response, DEFAULT_STH_PUBKEY);

async function run() {
  // 1. Real block, real verifier, built-in pin → proven; the gate approves.
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402({ tx: "TX_LIVE", twzrd_receipt: LIVE_RECEIPT, log_inclusion: LIVE_BLOCK }),
      requireLogInclusion: { verifier: offline },
    });
    assert.equal(r.approved, true, (r.logInclusion?.errors ?? []).join("; "));
    assert.equal(r.logInclusionDenied, undefined);
    assert.equal(r.logInclusion?.checked, true);
    assert.equal(r.logInclusion?.receipt_bound, true, "the receipt's signature and leaf were checked first");
    assert.equal(r.logInclusion?.leaf, REAL_LEAF);
    assert.equal(r.logInclusion?.valid, true, "the served proof verifies offline against the built-in pin");
    assert.equal(r.logInclusion?.leaf_index, 19);
    assert.equal(r.logInclusion?.tree_size, 20);
    assert.equal(r.logInclusion?.tofu, undefined, "an explicit pin is never TOFU");
    assert.deepEqual(r.receipt, LIVE_RECEIPT);
  }

  // 2. Tampered proof → the real verifier rejects, the gate denies, receipt still returned.
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402({
        tx: "TX_LIVE",
        twzrd_receipt: LIVE_RECEIPT,
        log_inclusion: { ...LIVE_BLOCK, sth: { ...LIVE_BLOCK.sth, tree_size: 21 } },
      }),
      requireLogInclusion: { verifier: offline },
    });
    assert.equal(r.approved, false, "a head that no longer verifies must not count");
    assert.equal(r.logInclusionDenied, true);
    assert.match(r.reason, /^twzrd_log_inclusion_failed/);
    assert.deepEqual(r.receipt, LIVE_RECEIPT, "the host paid for it; it is returned even when it does not count");
  }

  // 3. A proof for a DIFFERENT leaf attached to this receipt proves nothing → denied.
  //    The other receipt is genuinely signed by a key the host pinned, so it
  //    passes the gate's own check and it is the verifier that refuses it.
  {
    const other = signTestReceipt();
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402({ tx: "TX_OTHER", twzrd_receipt: other, log_inclusion: LIVE_BLOCK }),
      requireLogInclusion: { verifier: offline, receiptPubkey: TEST_RECEIPT_PUBKEY },
    });
    assert.equal(r.approved, false);
    assert.equal(r.logInclusion?.receipt_bound, true);
    assert.match(r.reason, /^twzrd_log_inclusion_failed/);
    assert.match((r.logInclusion?.errors ?? []).join(" "), /leaf mismatch/);
  }

  // 3b. The same proof beside the issued receipt with its score changed: the
  //     leaf is still the logged one, so the verifier alone would pass it. The
  //     gate refuses it before the verifier runs.
  {
    const rescored = { ...LIVE_RECEIPT, preimage: { ...LIVE_RECEIPT.preimage, score: 99 } };
    assert.equal(
      verifyLogInclusion({ twzrd_receipt: rescored, log_inclusion: LIVE_BLOCK }, DEFAULT_STH_PUBKEY).valid,
      true,
      "the log proof does not cover the receipt's fields",
    );
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402({ tx: "TX_LIVE", twzrd_receipt: rescored, log_inclusion: LIVE_BLOCK }),
      requireLogInclusion: { verifier: offline },
    });
    assert.equal(r.approved, false);
    assert.equal(r.logInclusionDenied, true);
    assert.match(r.reason, /^twzrd_log_inclusion_receipt_invalid \(receipt\.leaf does not match/);
    assert.equal(r.logInclusion?.receipt_bound, false);
  }

  // 4. No block attached → the offline verifier cannot prove anything ("no sth").
  //    Under hard that denies as _failed: correct for a verifier that only
  //    verifies offline. The documented composition falls back to a fetch here
  //    so a not-yet-merged leaf reports `pending` instead — that path is the
  //    network verifier's, covered in twzrd-log-verifier's own suite.
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402({ tx: "TX_LIVE", twzrd_receipt: LIVE_RECEIPT }),
      requireLogInclusion: { verifier: offline },
    });
    assert.equal(r.approved, false);
    assert.match(r.reason, /^twzrd_log_inclusion_failed/);
    assert.match((r.logInclusion?.errors ?? []).join(" "), /no sth/);
  }

  console.log("log-inclusion-offline: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
