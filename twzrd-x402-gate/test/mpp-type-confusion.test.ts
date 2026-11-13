/**
 * MPP Solana charge: a field that is present with the wrong type is refused.
 *
 * The guard used to treat a mistyped request field as absent and read the
 * well-formed value in methodDetails, while the payment client coerced the
 * mistyped one. So the decision covered one payment and the client built
 * another: an array amount paid more than the approved amount, an array
 * recipient paid someone the allowlist never saw, and a truthy non-boolean
 * `sponsored` added a second transfer.
 *
 * Run: npx tsx --test test/mpp-type-confusion.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import {
  createTwzrdMppOnChallenge,
  mppChallengeToIntent,
  TwzrdMppBlockError,
  type MppChallenge,
} from "../src/mpp-hook.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MERCHANT = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const OTHER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

function charge(request: Record<string, unknown>): MppChallenge {
  return {
    id: "ch_types",
    realm: "merchant.example",
    method: "solana",
    intent: "charge",
    request: { amount: "1000", currency: USDC, decimals: 6, recipient: MERCHANT, ...request },
  } as MppChallenge;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TwzrdMppBlockError, `expected TwzrdMppBlockError, got ${e}`);
    return e.code;
  }
  return "no_throw";
}

test("a well-formed charge still normalizes, on either side", () => {
  assert.equal(mppChallengeToIntent(charge({})).amount, "0.001");
  assert.equal(mppChallengeToIntent(charge({ amount: 1000 })).amount, "0.001");
  // Foundation shape: decimals and network in methodDetails.
  const nested = mppChallengeToIntent(
    charge({ decimals: undefined, methodDetails: { decimals: 6, network: "mainnet" } }),
  );
  assert.equal(nested.amount, "0.001");
  assert.equal(nested.payTo, MERCHANT);
  // Both sides, same values.
  const both = mppChallengeToIntent(
    charge({ methodDetails: { amount: "1000", recipient: MERCHANT, currency: USDC, decimals: 6 } }),
  );
  assert.equal(both.amount, "0.001");
});

test("an array amount with a scalar decoy in methodDetails is refused", () => {
  const decoy = { methodDetails: { amount: "1000" } };
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ amount: ["5000000"], ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ amount: [["1000000000"]], ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ amount: { valueOf: 5 }, ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ amount: true, ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ amount: null, ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ amount: "", ...decoy }))), "MALFORMED_CHALLENGE");
  // The other direction: a scalar on the request, a mistyped value nested.
  assert.equal(
    codeOf(() => mppChallengeToIntent(charge({ methodDetails: { amount: ["5000000"] } }))),
    "MALFORMED_CHALLENGE",
  );
});

test("an array recipient with an allowlisted decoy in methodDetails is refused", () => {
  const decoy = { methodDetails: { recipient: MERCHANT } };
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ recipient: [OTHER], ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ recipient: { toString: OTHER }, ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(codeOf(() => mppChallengeToIntent(charge({ recipient: null, ...decoy }))), "MALFORMED_CHALLENGE");
  assert.equal(
    codeOf(() => mppChallengeToIntent(charge({ methodDetails: { recipient: [OTHER] } }))),
    "MALFORMED_CHALLENGE",
  );
});

test("mistyped currency, decimals, cluster and network are refused on both sides", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["request.currency array", { currency: [USDC], methodDetails: { currency: USDC } }],
    ["request.decimals array", { decimals: ["9"], methodDetails: { decimals: 6 } }],
    ["request.decimals string", { decimals: "9", methodDetails: { decimals: 6 } }],
    ["request.cluster array", { cluster: ["https://rpc.example"], methodDetails: { network: "mainnet" } }],
    ["request.network array", { network: ["devnet"], methodDetails: { network: "mainnet" } }],
    ["methodDetails.currency array", { methodDetails: { currency: [USDC] } }],
    ["methodDetails.decimals array", { methodDetails: { decimals: [6] } }],
    ["methodDetails.network object", { methodDetails: { network: { name: "mainnet" } } }],
    ["methodDetails array", { methodDetails: [{ amount: "1000" }] }],
    ["methodDetails string", { methodDetails: "amount=1000" }],
  ];
  for (const [label, request] of cases) {
    assert.equal(codeOf(() => mppChallengeToIntent(charge(request))), "MALFORMED_CHALLENGE", label);
  }
});

test("sponsorship is refused by presence, not by type", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["sponsored string", { sponsored: "yes" }],
    ["sponsored number", { sponsored: 1 }],
    ["sponsored empty string", { sponsored: "" }],
    ["sponsored array", { sponsored: [] }],
    ["sponsorPath array", { sponsorPath: ["/sponsor"] }],
    ["sponsorPath object", { sponsorPath: { path: "/sponsor" } }],
    ["feeTokenAmount number", { feeTokenAmount: 1000000 }],
    ["feeTokenAmount array", { feeTokenAmount: ["1000000"] }],
    ["the reported pair", { sponsored: "yes", sponsorPath: ["/sponsor"] }],
    ["nested sponsored", { methodDetails: { sponsored: true } }],
    ["nested sponsorPath", { methodDetails: { sponsorPath: "/sponsor" } }],
    ["nested feeTokenAmount", { methodDetails: { feeTokenAmount: "1" } }],
  ];
  for (const [label, request] of cases) {
    assert.equal(codeOf(() => mppChallengeToIntent(charge(request))), "SPONSORED_CHARGE", label);
  }
  // An explicit "not sponsored" is not sponsorship.
  assert.equal(mppChallengeToIntent(charge({ sponsored: false })).amount, "0.001");
  assert.equal(mppChallengeToIntent(charge({ sponsored: null, sponsorPath: null })).amount, "0.001");
});

test("the guard creates no credential for any of them", async () => {
  const guard = createTwzrdMppOnChallenge({ signer: createLocalDecisionSigner() });
  const attacks: Array<[string, Record<string, unknown>]> = [
    ["array amount", { amount: ["5000000"], methodDetails: { amount: "1000" } }],
    ["array recipient", { recipient: [OTHER], methodDetails: { recipient: MERCHANT } }],
    ["truthy sponsored", { sponsored: "yes", sponsorPath: ["/sponsor"] }],
  ];
  for (const [label, request] of attacks) {
    let credentials = 0;
    const helpers = {
      createCredential: async () => {
        credentials += 1;
        return "credential";
      },
    };
    await assert.rejects(
      () => guard(charge(request), helpers as never),
      (e: unknown) => e instanceof TwzrdMppBlockError,
      label,
    );
    assert.equal(credentials, 0, `${label}: no credential`);
  }
});
