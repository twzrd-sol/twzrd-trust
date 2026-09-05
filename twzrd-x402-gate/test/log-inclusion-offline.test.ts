/**
 * requireLogInclusion wired to the REAL offline verifier, against the REAL
 * served genesis block. Run: npx tsx test/log-inclusion-offline.test.ts
 *
 * The gate takes no dependency on twzrd-log-verifier — hosts inject it. This
 * test is the proof that the injection seam fits the verifier with no adapter:
 * `verifyLogInclusion`'s result is a `LogInclusionVerdict` structurally, and
 * the whole paid response the seam passes is exactly what the offline
 * verifier consumes. It imports the sibling workspace's SOURCE (tsx resolves
 * it; no build needed) precisely so a signature drift on either side fails
 * here rather than in a host's integration.
 *
 * The block is the live log's genesis as served 2026-09-04 — real data, the
 * same fixture the verifier's own suite pins. If it stops verifying, the
 * pinned key changed or history was rewritten; either is worth knowing.
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import type { X402PaymentRequirements } from "../src/types.js";
import { verifyLogInclusion } from "../../twzrd-log-verifier/src/client.js";
import { DEFAULT_STH_PUBKEY } from "../../twzrd-log-verifier/src/index.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const REQS: X402PaymentRequirements = {
  payTo: SELLER,
  maxAmountRequired: "50000",
  resource: "https://seller.example/paid",
  network: "solana",
} as X402PaymentRequirements;

const preflight = (card: Record<string, unknown>): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const x402 = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const WARN = { decision: "warn", trust_score: 45, can_spend: false };

// Live genesis, verbatim from https://intel.twzrd.xyz/v1/log/sth (2026-09-04).
const LIVE_LEAF = "0xf7e88f2666a0590d8cf7d426d4842e29a23b66607f2c0a691bf6fc7d0d63ba8f";
const LIVE_BLOCK = {
  log_id: "intel.twzrd.xyz/v6",
  leaf: LIVE_LEAF,
  leaf_index: 0,
  tree_size: 1,
  audit_path: [] as string[],
  sth: {
    domain: "TWZRD:RECEIPT_LOG_STH_V1",
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 1,
    timestamp_unix: 1788450541,
    root: "0x811e1fee65f06c5cfcfee8f338e933c1d3dd261c4c09b8f2793b62bea7ea6db4",
    signature: "5tgH6Y9x1pcE5eDWjaNb8reUpuy88A5xNanSsJu1A5hEgKbH2kwZtAev6ifE9RWTspkvkvhvuLEGtPbpEN5yVete",
    signing_pubkey: DEFAULT_STH_PUBKEY,
  },
  anchor: null,
  verify: `/v1/log/proof/inclusion?leaf=${LIVE_LEAF}`,
};
const LIVE_RECEIPT = { leaf: LIVE_LEAF, preimage: { settlement_tx: "TX_LIVE" } };

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
    assert.equal(r.logInclusion?.valid, true, "genesis block proves offline against the built-in pin");
    assert.equal(r.logInclusion?.leaf_index, 0);
    assert.equal(r.logInclusion?.tree_size, 1);
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
        log_inclusion: { ...LIVE_BLOCK, sth: { ...LIVE_BLOCK.sth, tree_size: 2 } },
      }),
      requireLogInclusion: { verifier: offline },
    });
    assert.equal(r.approved, false, "a head that no longer verifies must not count");
    assert.equal(r.logInclusionDenied, true);
    assert.match(r.reason, /^twzrd_log_inclusion_failed/);
    assert.deepEqual(r.receipt, LIVE_RECEIPT, "the host paid for it; it is returned even when it does not count");
  }

  // 3. A proof for a DIFFERENT leaf attached to this receipt proves nothing → denied.
  {
    const other = { leaf: "0x" + "ab".repeat(32), preimage: { settlement_tx: "TX_OTHER" } };
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402({ tx: "TX_OTHER", twzrd_receipt: other, log_inclusion: LIVE_BLOCK }),
      requireLogInclusion: { verifier: offline },
    });
    assert.equal(r.approved, false);
    assert.match((r.logInclusion?.errors ?? []).join(" "), /leaf mismatch/);
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
