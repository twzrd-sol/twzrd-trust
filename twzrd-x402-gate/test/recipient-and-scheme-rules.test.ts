/**
 * Two rules of the requirement reader and Payment Control:
 *  - An EVM recipient is one account in any letter case: blocklists,
 *    allowlists and the new-counterparty cap read it that way.
 *  - The `auth-capture` scheme is refused: its client signs escrow terms from
 *    `extra` that a check on payTo and amount does not see.
 *
 * Run: npx tsx --test test/recipient-and-scheme-rules.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTwzrdCloudflareBaseApproval } from "../src/cloudflare-base.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import type { PaymentIntent } from "../src/intent.js";
import { createTwzrdPolicyFetch } from "../src/policy-fetch.js";
import { AUTH_CAPTURE_REFUSED, isAuthCapture, resolveRequirementFields } from "../src/payto.js";
import { counterpartyScope, createMemorySpendLedger, evaluateIntent } from "../src/policy-runtime.js";

const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const EIP55 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const OTHER_EVM = "0x1111111111111111111111111111111111111111";
const BASE = "eip155:8453";
const BASE_USDC = "0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913";
const SOLANA_A = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const t0 = 1_700_000_000_000;
const signer = createLocalDecisionSigner({ keyId: "recipient-rules-test" });

function intent(payTo: string, amount = "0.01"): PaymentIntent {
  return { protocol: "x402", network: BASE, asset: BASE_USDC, amount, payTo, resource: { url: "https://store.example/item", method: "GET" } };
}

test("a blocklisted EVM recipient is blocked in either spelling", async () => {
  for (const [listed, asked] of [[LOWER, EIP55], [EIP55, LOWER], [LOWER, LOWER]]) {
    const d = await evaluateIntent(intent(asked), { signer, policy: { blocklist: [listed] }, now: t0 });
    assert.equal(d.decision, "block", `${listed} listed, ${asked} asked`);
    assert.ok(d.reasonCodes.includes("POLICY_BLOCKLIST"));
  }
  const m = await evaluateIntent(intent(EIP55), { signer, mandate: { mandateId: "m", payeeBlocklist: [LOWER] } as never, now: t0 });
  assert.ok(m.reasonCodes.includes("MANDATE_PAYEE_BLOCKED"), JSON.stringify(m.reasonCodes));
});

test("an allowlisted EVM recipient is allowed in either spelling, and no other address is", async () => {
  assert.equal((await evaluateIntent(intent(EIP55), { signer, policy: { allowlist: [LOWER] }, now: t0 })).decision, "allow");
  const other = await evaluateIntent(intent(OTHER_EVM), { signer, policy: { allowlist: [LOWER] }, now: t0 });
  assert.ok(other.reasonCodes.includes("POLICY_NOT_ALLOWLISTED"));
});

test("the new-counterparty cap counts both spellings of one EVM recipient together", async () => {
  const ledger = createMemorySpendLedger();
  const opts = { signer, ledger, policy: { newCounterpartyCap: { capUsd: "0.03", windowHours: 24 } } };
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    outcomes.push((await evaluateIntent(intent(i % 2 === 0 ? LOWER : EIP55), { ...opts, now: t0 + i })).decision);
  }
  assert.deepEqual(outcomes, ["allow", "allow", "allow", "block", "block", "block"]);
  assert.equal(counterpartyScope(EIP55), counterpartyScope(LOWER));
  assert.equal(ledger.spentMicro(counterpartyScope(LOWER), 24 * 3_600_000, t0 + 10), 30_000n);
});

test("spend an older ledger booked under the mixed-case spelling still counts", async () => {
  const ledger = createMemorySpendLedger();
  ledger.record(`counterparty:${EIP55}`, 30_000n, t0);
  const d = await evaluateIntent(intent(EIP55), { signer, ledger, policy: { newCounterpartyCap: { capUsd: "0.03", windowHours: 24 } }, now: t0 + 1 });
  assert.ok(d.reasonCodes.includes("NEW_COUNTERPARTY_CAP"), JSON.stringify(d.reasonCodes));
});

test("Solana recipients stay case-sensitive", async () => {
  assert.notEqual(counterpartyScope(SOLANA_A), counterpartyScope(SOLANA_A.toLowerCase()));
  const d = await evaluateIntent({ ...intent(SOLANA_A.toLowerCase()), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    { signer, policy: { blocklist: [SOLANA_A] }, now: t0 });
  assert.ok(!d.reasonCodes.includes("POLICY_BLOCKLIST"));
});

const AUTH_CAPTURE = {
  scheme: "auth-capture", network: BASE, asset: BASE_USDC, amount: "10000", payTo: EIP55, maxTimeoutSeconds: 60,
  extra: { captureAuthorizer: OTHER_EVM, feeRecipient: OTHER_EVM, minFeeBps: 10000, maxFeeBps: 10000 },
};

test("the reader refuses auth-capture, however the scheme is spelled", () => {
  assert.equal(resolveRequirementFields(AUTH_CAPTURE).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, extra: {} }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, scheme: " Auth-Capture " }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, scheme: ["auth-capture"] }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(isAuthCapture({ ...AUTH_CAPTURE, scheme: "exact" }), false);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, scheme: "exact" }).conflict, undefined);
});

test("the policy fetch never hands an auth-capture offer to the payer", async () => {
  let handed = 0;
  const pf = createTwzrdPolicyFetch({
    signer,
    fetch: (async () => Response.json({ wash_flagged: false, wash_confidence: "full" })) as unknown as typeof fetch,
    rawFetch: (async () => new Response(JSON.stringify({ x402Version: 2, accepts: [AUTH_CAPTURE] }), { status: 402, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    wrapPay: (gated) => async (input, init) => {
      const r = await gated(input, init);
      if (r.status === 402) handed += 1;
      return r;
    },
    policy: { maxAmountUsd: "0.05" },
    deliveryCapture: false,
  });
  await assert.rejects(() => pf("https://worker.example/paid-tool"));
  assert.equal(handed, 0);
});

test("the Base Worker approval refuses an offer whose scheme is not exact", async () => {
  const intel = (async () => new Response(JSON.stringify({
    readiness_card: { decision: "allow", trust_score: 90, score: 90, recommended_cap_usdc: 100, wash_flagged: false },
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const approve = createTwzrdCloudflareBaseApproval({ fetch: intel });
  const exact = { scheme: "exact", network: BASE, payTo: EIP55, amount: "1000", asset: BASE_USDC };
  assert.equal(await approve({ resource: "https://worker.example/paid-tool", accepts: [exact] }), true, "control");
  for (const scheme of ["auth-capture", "batch-settlement", "upto", "deferred"]) {
    assert.equal(
      await approve({ resource: "https://worker.example/paid-tool", accepts: [{ ...exact, scheme }] }),
      false,
      `${scheme} must not be approved`,
    );
  }
});
