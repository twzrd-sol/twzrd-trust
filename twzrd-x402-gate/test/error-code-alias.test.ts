/**
 * Regression: the 0.9.2 -> 0.9.3 rename of the missing-key binding error
 * (MISSING_VERIFICATION_KEY -> MISSING_VERIFIER_KEY) must not strand 0.9.x
 * consumers matching the old identifier. The canonical thrown string stays
 * MISSING_VERIFIER_KEY; the old name survives as a deprecated alias constant
 * with the identical value, exported from the package root.
 *
 * Run: npx tsx test/error-code-alias.test.ts
 */
import assert from "node:assert/strict";

import {
  assertIntentApproved,
  createLocalDecisionSigner,
  evaluateIntent,
  MISSING_VERIFICATION_KEY,
  MISSING_VERIFIER_KEY,
  TwzrdIntentBindingError,
  type PaymentIntent,
} from "../src/index.js";

const intent: PaymentIntent = {
  protocol: "x402",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "1.00",
  payTo: "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  resource: { url: "https://merchant.example/paid", method: "GET" },
};

async function run() {
  // Both identifiers exist on the public surface with the canonical value.
  assert.equal(MISSING_VERIFIER_KEY, "MISSING_VERIFIER_KEY");
  assert.equal(MISSING_VERIFICATION_KEY, "MISSING_VERIFIER_KEY");
  assert.equal(MISSING_VERIFICATION_KEY, MISSING_VERIFIER_KEY);

  // The thrown code matches either identifier.
  const signer = createLocalDecisionSigner();
  const token = await evaluateIntent(intent, { signer });
  assert.throws(
    () => assertIntentApproved(intent, token),
    (e: unknown) =>
      e instanceof TwzrdIntentBindingError &&
      e.code === MISSING_VERIFIER_KEY &&
      e.code === MISSING_VERIFICATION_KEY,
  );

  console.log("error-code-alias.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("error-code-alias.test.ts FAILED:", e);
  process.exit(1);
});
