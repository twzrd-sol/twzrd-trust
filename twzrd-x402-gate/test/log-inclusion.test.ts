/**
 * requireLogInclusion — pure policy + evaluate_x402_resource integration.
 * Run: npx tsx test/log-inclusion.test.ts
 *
 * Locks the rule that a paid receipt may not COUNT as trust until it is proven
 * included in the Receipt Transparency log under a caller-pinned key. Mocks the
 * free preflight, the paid x402Fetch, and the injected log verifier — nothing
 * settles on-chain and nothing talks to a log.
 */
import assert from "node:assert/strict";

import { evaluate_x402_resource } from "../src/evaluate.js";
import {
  evaluateLogInclusion,
  resolveRequireLogInclusionPolicy,
  type LogInclusionVerdict,
} from "../src/log-inclusion.js";
import type { X402PaymentRequirements } from "../src/types.js";

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

function x402Mock(body: unknown, status = 200) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { calls: string[] };
  (fn as { calls: string[] }).calls = calls;
  return fn;
}

/** Injected verifier mock: records what it was handed, returns or throws. */
function verifierMock(result: LogInclusionVerdict | Error) {
  const calls: unknown[] = [];
  const fn = async (receipt: unknown) => {
    calls.push(receipt);
    if (result instanceof Error) throw result;
    return result;
  };
  return Object.assign(fn, { calls });
}

const RECEIPT = { leaf: "0x" + "ab".repeat(32), preimage: { settlement_tx: "TX_PRE" } };
const WARN = { decision: "warn", trust_score: 45, can_spend: false };
const PROVEN: LogInclusionVerdict = {
  valid: true,
  errors: [],
  key_id: "twzrd-log-ed25519-v1",
  leaf_index: 17,
  tree_size: 48213,
};

async function evaluateWith(
  verifier: ReturnType<typeof verifierMock> | undefined,
  policyExtras: Record<string, unknown> = {},
  card: Record<string, unknown> = WARN,
) {
  return evaluate_x402_resource("https://seller.example/paid", REQS, {
    fetch: preflight(card),
    autoReceipt: true,
    x402Fetch: x402Mock({ tx: "TX_AAA", twzrd_receipt: RECEIPT }),
    requireLogInclusion: { verifier: verifier as never, ...policyExtras },
  });
}

async function run() {
  // ── pure policy ────────────────────────────────────────────────────────

  {
    assert.equal(resolveRequireLogInclusionPolicy(undefined), null, "unset → off");
    assert.equal(resolveRequireLogInclusionPolicy(false), null, "false → off");
    const v = verifierMock(PROVEN);
    assert.deepEqual(
      resolveRequireLogInclusionPolicy({ verifier: v }),
      { verifier: v, hard: true, onPending: "deny", refuseTofu: true },
      "defaults: hard, deny pending, refuse TOFU",
    );
    assert.deepEqual(
      resolveRequireLogInclusionPolicy({ verifier: v, hard: false, onPending: "allow", refuseTofu: false }),
      { verifier: v, hard: false, onPending: "allow", refuseTofu: false },
    );
  }

  {
    const policy = resolveRequireLogInclusionPolicy({ verifier: verifierMock(new Error("log unreachable")) })!;
    const o = await evaluateLogInclusion(RECEIPT, policy);
    assert.equal(o.checked, true);
    assert.equal(o.valid, false);
    assert.equal(o.denyReason, "twzrd_log_inclusion_error", "a throwing verifier denies under hard — never fail-open");
    assert.deepEqual(o.errors, ["log unreachable"]);
  }

  {
    // Soft policy: same failures annotate but never deny.
    const policy = resolveRequireLogInclusionPolicy({ verifier: verifierMock({ valid: false, errors: ["nope"] }), hard: false })!;
    const o = await evaluateLogInclusion(RECEIPT, policy);
    assert.equal(o.valid, false);
    assert.equal(o.denyReason, undefined, "soft policy annotates, does not deny");
  }

  // ── evaluate_x402_resource integration ────────────────────────────────

  // 1. Proven inclusion under a pin → approved, outcome attached, receipt intact.
  {
    const v = verifierMock(PROVEN);
    const r = await evaluateWith(v);
    assert.equal(v.calls.length, 1, "verifier ran once");
    assert.deepEqual(v.calls[0], RECEIPT, "verifier was handed the raw twzrd_receipt");
    assert.equal(r.approved, true);
    assert.equal(r.logInclusionDenied, undefined);
    assert.deepEqual(r.logInclusion, {
      checked: true,
      valid: true,
      key_id: "twzrd-log-ed25519-v1",
      leaf_index: 17,
      tree_size: 48213,
    });
    assert.deepEqual(r.receipt, RECEIPT, "receipt still returned");
    assert.equal(r.receiptTx, "TX_AAA");
  }

  // 2. Inclusion fails → spend denied, but the paid receipt is still handed back.
  {
    const r = await evaluateWith(verifierMock({ valid: false, errors: ["inclusion proof does not verify against the signed root"] }));
    assert.equal(r.approved, false);
    assert.equal(r.logInclusionDenied, true);
    assert.equal(r.policyAction, "block");
    assert.match(r.reason, /^twzrd_log_inclusion_failed \(/);
    assert.match(r.reason, /does not verify/);
    assert.deepEqual(r.receipt, RECEIPT, "the host paid for it; it is returned even when it does not count");
    assert.equal(r.receiptFeeCaptured, true);
  }

  // 3. Not yet merged: denied by default, tolerated with onPending:"allow".
  {
    const pending: LogInclusionVerdict = { valid: false, errors: ["inclusion proof: GET … -> HTTP 404"], not_yet_merged: true };
    const denied = await evaluateWith(verifierMock(pending));
    assert.equal(denied.approved, false);
    assert.equal(denied.logInclusion?.pending, true);
    assert.match(denied.reason, /^twzrd_log_inclusion_pending/);

    const tolerated = await evaluateWith(verifierMock(pending), { onPending: "allow" });
    assert.equal(tolerated.approved, true, "onPending:allow tolerates the merge-delay window");
    assert.equal(tolerated.logInclusionDenied, undefined);
    assert.equal(tolerated.logInclusion?.pending, true);
    assert.equal(tolerated.logInclusion?.valid, false, "tolerated is not the same as proven");
  }

  // 4. TOFU: a verdict that is "valid" against keys the log chose for itself is refused.
  {
    const tofu: LogInclusionVerdict = { ...PROVEN, tofu: true };
    const refused = await evaluateWith(verifierMock(tofu));
    assert.equal(refused.approved, false);
    assert.match(refused.reason, /^twzrd_log_inclusion_tofu_refused/);
    assert.equal(refused.logInclusion?.valid, false, "TOFU never reports as proven");
    assert.equal(refused.logInclusion?.tofu, true);

    const accepted = await evaluateWith(verifierMock(tofu), { refuseTofu: false });
    assert.equal(accepted.approved, true, "refuseTofu:false is the host's explicit choice");
    assert.equal(accepted.logInclusion?.valid, true);
  }

  // 5. Verifier throws → hard denies with the error; soft annotates and approves.
  {
    const hard = await evaluateWith(verifierMock(new Error("ECONNREFUSED")));
    assert.equal(hard.approved, false);
    assert.match(hard.reason, /^twzrd_log_inclusion_error \(ECONNREFUSED/);

    const soft = await evaluateWith(verifierMock(new Error("ECONNREFUSED")), { hard: false });
    assert.equal(soft.approved, true);
    assert.equal(soft.logInclusionDenied, undefined);
    assert.deepEqual(soft.logInclusion?.errors, ["ECONNREFUSED"]);
  }

  // 6. Policy set but verifier not wired → hard denies rather than silently skipping.
  {
    const r = await evaluateWith(undefined);
    assert.equal(r.approved, false);
    assert.match(r.reason, /^twzrd_log_inclusion_error \(requireLogInclusion is set but no verifier/);
    assert.equal(r.logInclusion?.checked, false);
  }

  // 7. Paid response carried no twzrd_receipt → nothing to prove → hard denies.
  {
    const v = verifierMock(PROVEN);
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402Mock({ tx: "TX_NO_RECEIPT" }),
      requireLogInclusion: { verifier: v },
    });
    assert.equal(v.calls.length, 0, "no receipt → verifier never invoked");
    assert.equal(r.approved, false);
    assert.match(r.reason, /^twzrd_log_inclusion_failed \(no twzrd_receipt/);
  }

  // 8. Block decision → no paid call, no verifier call: free refuse stays free.
  {
    const v = verifierMock(PROVEN);
    const r = await evaluateWith(v, {}, { decision: "block", trust_score: 10 });
    assert.equal(v.calls.length, 0, "verifier never runs on block");
    assert.equal(r.approved, false);
    assert.equal(r.logInclusion, undefined);
  }

  // 9. Policy off → verifier never consulted, result shape unchanged.
  {
    const v = verifierMock(PROVEN);
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402Mock({ tx: "TX_AAA", twzrd_receipt: RECEIPT }),
      requireLogInclusion: false,
    });
    assert.equal(v.calls.length, 0);
    assert.equal(r.approved, true);
    assert.equal(r.logInclusion, undefined);
    assert.equal("logInclusion" in r, false, "no key leaks in when the policy is off");
  }

  // 10. requireReceipt (hard) + requireLogInclusion compose: receipt obtained, then must prove.
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      requireReceipt: true,
      x402Fetch: x402Mock({ tx: "TX_AAA", twzrd_receipt: RECEIPT }),
      requireLogInclusion: { verifier: verifierMock({ valid: false, errors: ["forged"] }) },
    });
    assert.equal(r.receiptRequired, true, "Path A was required and ran");
    assert.equal(r.receiptRequiredDenied, undefined, "Path A itself succeeded");
    assert.equal(r.logInclusionDenied, true, "…but the receipt failed to prove inclusion");
    assert.equal(r.approved, false);
  }

  // ── Path A attempted but yielded no receipt: hard must not fail open ──────
  // An outage on the receipt endpoint must never produce a BETTER outcome
  // than an empty receipt body (case 7). autoReceipt (soft receipt) is used so
  // requireReceipt's own hard deny cannot mask what requireLogInclusion does.

  // 11. Paid fetch non-OK → denied, verifier never consulted.
  {
    const v = verifierMock(PROVEN);
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402Mock({ error: "upstream" }, 500),
      requireLogInclusion: { verifier: v },
    });
    assert.equal(v.calls.length, 0, "nothing to verify");
    assert.equal(r.approved, false, "a 500 on the receipt endpoint must not approve");
    assert.equal(r.logInclusionDenied, true);
    assert.equal(r.policyAction, "block");
    assert.match(r.reason, /^twzrd_log_inclusion_failed \(no receipt captured: paid_response_not_ok \(HTTP 500\)/);
    assert.equal(r.receiptRequiredDenied, undefined, "requireReceipt was not the denier");
  }

  // 12. Paid fetch throws → denied.
  {
    const v = verifierMock(PROVEN);
    const throwing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: throwing,
      requireLogInclusion: { verifier: v },
    });
    assert.equal(v.calls.length, 0);
    assert.equal(r.approved, false, "a thrown receipt fetch must not approve");
    assert.match(r.reason, /^twzrd_log_inclusion_failed \(no receipt captured: paid_fetch_error/);
    assert.deepEqual(r.logInclusion?.errors, ["no receipt captured: paid_fetch_error"]);
  }

  // 13. Path A wanted (autoReceipt) but x402Fetch not wired → denied, not skipped.
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      requireLogInclusion: { verifier: verifierMock(PROVEN) },
    });
    assert.equal(r.approved, false);
    assert.match(r.reason, /^twzrd_log_inclusion_failed \(no receipt captured: missing_x402Fetch/);
  }

  // 14. Path A NOT attempted by policy → out of scope: the knob gates receipts,
  //     it does not override the host's own threshold.
  {
    const v = verifierMock(PROVEN);
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight({ decision: "allow", trust_score: 90, can_spend: true }),
      requireReceipt: { minSpendUsdc: 10 }, // price is $0.05, allow → no Path A
      x402Fetch: x402Mock({ tx: "SHOULD_NOT_HAPPEN" }),
      requireLogInclusion: { verifier: v },
    });
    assert.equal(v.calls.length, 0);
    assert.equal(r.approved, true, "below-threshold allow proceeds; no receipt was ever in play");
    assert.equal(r.logInclusionDenied, undefined);
    assert.equal("logInclusion" in r, false);
  }

  // 15. Soft policy + paid fetch non-OK → soft never denies.
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", REQS, {
      fetch: preflight(WARN),
      autoReceipt: true,
      x402Fetch: x402Mock({ error: "upstream" }, 500),
      requireLogInclusion: { verifier: verifierMock(PROVEN), hard: false },
    });
    assert.equal(r.approved, true);
    assert.equal(r.logInclusionDenied, undefined);
  }

  console.log("log-inclusion: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
