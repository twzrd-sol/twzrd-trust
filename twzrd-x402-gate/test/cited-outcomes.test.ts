/**
 * citedOutcomes on the DecisionToken — decision N+1 verifiably cites the
 * closed outcome of loop N (decision-loop canonicalization follow-on).
 *
 * Proves:
 *   - a token carrying cited outcome leaves signs and verifies,
 *   - the signature COMMITS to the citation set: add / remove / reorder /
 *     mutate any leaf and verification fails,
 *   - legacy tokens (no citedOutcomes) still sign+verify identically —
 *     canonicalJson drops the absent field, so old signatures are untouched,
 *   - malformed / duplicate / oversized citation sets throw at issuance
 *     (fail closed — a bad citation is a caller bug, not a policy outcome),
 *   - evaluateIntent threads citedOutcomes into the signed token.
 *
 * Run: npx tsx test/cited-outcomes.test.ts
 */
import assert from "node:assert/strict";

import {
  createLocalDecisionSigner,
  MAX_CITED_OUTCOMES,
  normalizeCitedOutcomes,
  signDecision,
  verifyDecisionSignature,
  type PaymentDecision,
} from "../src/decision-token.js";
import { intentHash, type PaymentIntent } from "../src/intent.js";
import { evaluateIntent, POLICY_VERSION } from "../src/policy-runtime.js";

const signer = createLocalDecisionSigner();

const intent: PaymentIntent = {
  protocol: "x402",
  network: "solana",
  asset: "USDC",
  amount: "0.10",
  payTo: "MerchantWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  resource: { url: "https://api.example.com/paid" },
};

const LEAF_A = "0x" + "ab".repeat(32);
const LEAF_B = "0x" + "cd".repeat(32);

function unsigned(citedOutcomes?: string[]): Omit<PaymentDecision, "signature" | "keyId"> {
  return {
    decision: "allow",
    reasonCodes: ["ALLOW"],
    intentHash: intentHash(intent),
    policyVersion: POLICY_VERSION,
    decisionId: "test-decision-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(citedOutcomes ? { citedOutcomes } : {}),
  };
}

/* 1. Round-trip: citing token signs and verifies */
{
  const token = await signDecision(unsigned([LEAF_A, LEAF_B]), signer);
  assert.deepEqual(token.citedOutcomes, [LEAF_A, LEAF_B]);
  assert.equal(verifyDecisionSignature(token, signer.publicKeyPem), true);
}

/* 2. Signature commits to the citation set — every mutation must fail */
{
  const token = await signDecision(unsigned([LEAF_A, LEAF_B]), signer);
  const mutations: PaymentDecision[] = [
    { ...token, citedOutcomes: [LEAF_A] }, // drop one
    { ...token, citedOutcomes: [LEAF_B, LEAF_A] }, // reorder
    { ...token, citedOutcomes: [LEAF_A, "0x" + "ee".repeat(32)] }, // swap leaf
    { ...token, citedOutcomes: [LEAF_A, LEAF_B, "0x" + "ff".repeat(32)] }, // append
    (({ citedOutcomes: _dropped, ...rest }) => rest as PaymentDecision)(token), // strip entirely
  ];
  for (const m of mutations) {
    assert.equal(
      verifyDecisionSignature(m, signer.publicKeyPem),
      false,
      `mutated citation set must not verify: ${JSON.stringify(m.citedOutcomes)}`,
    );
  }
}

/* 3. A citation cannot be grafted ONTO a legacy token either */
{
  const legacy = await signDecision(unsigned(), signer);
  assert.equal(legacy.citedOutcomes, undefined);
  assert.equal(verifyDecisionSignature(legacy, signer.publicKeyPem), true);
  const grafted = { ...legacy, citedOutcomes: [LEAF_A] };
  assert.equal(verifyDecisionSignature(grafted, signer.publicKeyPem), false);
}

/* 4. Issuance-time validation is fail closed */
{
  assert.deepEqual(normalizeCitedOutcomes([" 0xAB".trim() + "ab".repeat(31)]), [
    "0x" + "ab".repeat(32),
  ]);
  assert.throws(() => normalizeCitedOutcomes(["not-a-leaf"]), /64 hex/);
  assert.throws(() => normalizeCitedOutcomes(["ab".repeat(32)]), /64 hex/); // missing 0x
  assert.throws(() => normalizeCitedOutcomes(["0x" + "ab".repeat(31)]), /64 hex/); // short
  assert.throws(() => normalizeCitedOutcomes([LEAF_A, LEAF_A]), /duplicate/);
  assert.throws(
    () =>
      normalizeCitedOutcomes(
        Array.from({ length: MAX_CITED_OUTCOMES + 1 }, (_, i) =>
          ("0x" + i.toString(16).padStart(2, "0").repeat(32)).slice(0, 66),
        ),
      ),
    /MAX_CITED_OUTCOMES/,
  );
}

/* 5. evaluateIntent threads citations into the signed token */
{
  const token = await evaluateIntent(intent, {
    signer,
    citedOutcomes: ["0X" + "AB".repeat(32), LEAF_B], // mixed case in, normalized out
  });
  assert.deepEqual(token.citedOutcomes, [LEAF_A, LEAF_B]);
  assert.equal(verifyDecisionSignature(token, signer.publicKeyPem), true);

  const bare = await evaluateIntent(intent, { signer });
  assert.equal(bare.citedOutcomes, undefined);

  await assert.rejects(
    evaluateIntent(intent, { signer, citedOutcomes: ["garbage"] }),
    /64 hex/,
  );
}

console.log("cited-outcomes.test.ts: ALL PASSED");
