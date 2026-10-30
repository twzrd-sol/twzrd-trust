/**
 * TWZRD Payment Control on MPP (Machine Payments Protocol) — Solana charge only.
 * Run: npx tsx test/mpp-hook.test.ts
 *
 * The proof: with `Mppx.create({ onChallenge: createTwzrdMppOnChallenge(...) })`,
 * a policy block THROWS from onChallenge — mppx re-throws after `payment.failed`,
 * so `createCredential()` (which signs AND broadcasts the Solana tx) never runs.
 * Block means credential count 0 and signer count 0. No mainnet spending here:
 * every credential path is a stub.
 *
 * Block 2 is the pricing invariant: policy ceilings are USD, the wire amount is
 * base-unit tokens, and the guard refuses to bridge the two by assumption. A
 * 1.5 SOL charge is NOT "$1.50" just because it says 1500000000 at 9 decimals.
 */
import assert from "node:assert/strict";

import { intentHash } from "../src/intent.js";
import { classifyNetwork } from "../src/network.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import {
  createTwzrdMppOnChallenge,
  mppChallengeToIntent,
  NATIVE_SOL_CURRENCY,
  TwzrdMppBlockError,
  type MppChallenge,
} from "../src/mpp-hook.js";

const MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function solanaCharge(overrides?: Record<string, unknown>): MppChallenge {
  return {
    id: "chal_abc123",
    realm: "api.example.com",
    method: "solana",
    intent: "charge",
    request: {
      amount: "50000",
      currency: USDC,
      decimals: 6,
      recipient: MERCHANT,
      ...overrides,
    },
  };
}

/** Stub helpers: counts stand in for "the wallet signed and broadcast". */
function stubHelpers() {
  const state = { credentialCount: 0, signerCount: 0 };
  return {
    state,
    helpers: {
      createCredential: async () => {
        state.signerCount += 1; // mppx-solana signs inside createCredential
        state.credentialCount += 1;
        return "Payment credential=stub";
      },
    },
  };
}

async function run() {
  /* 1. Adapter: MPP solana charge -> canonical PaymentIntent v1 */
  {
    const intent = mppChallengeToIntent(solanaCharge(), {
      resourceUrl: "https://api.example.com/paid/report",
      method: "GET",
      purpose: "research_api",
    });
    assert.equal(intent.protocol, "mpp");
    assert.equal(intent.network, "solana:mainnet-beta");
    assert.equal(intent.amount, "0.05", "50000 USDC base units at 6dp = $0.05");
    assert.equal(intent.payTo, MERCHANT);
    assert.equal(intent.asset, USDC);
    // The exact challenge is bound, not merely an equivalent-looking payment.
    // The operation binds a digest of the whole normalized challenge, so a
    // mutated payload under the same realm:id is a different intent.
    assert.match(
      String(intent.resource?.operation),
      /^mpp-charge:api\.example\.com:chal_abc123:[0-9a-f]{64}$/,
    );
    const other = mppChallengeToIntent(
      { ...solanaCharge(), id: "chal_other" },
      { resourceUrl: "https://api.example.com/paid/report", method: "GET", purpose: "research_api" },
    );
    assert.notEqual(intentHash(intent), intentHash(other), "challenge id rotates the hash");

    // Mainnet is reputation-scored; devnet keeps its honest unscored name.
    assert.equal(classifyNetwork(intent.network).reputationScored, true);
    const dev = mppChallengeToIntent(solanaCharge({ cluster: "devnet", currency: DEVNET_USDC }));
    assert.equal(dev.network, "solana:devnet");
    assert.equal(classifyNetwork(dev.network).reputationScored, false);

    // Solana Foundation @solana/mpp nests decimals and network in methodDetails.
    // intel.twzrd.xyz sends that shape. A missing top-level decimals used to
    // throw MALFORMED_CHALLENGE before preflight. feePayer:true here is the
    // sponsored SOL fee payer, not mppx-solana's second token transfer.
    const foundation = mppChallengeToIntent({
      id: "chal_foundation",
      realm: "intel.twzrd.xyz",
      method: "solana",
      intent: "charge",
      request: {
        amount: "1000",
        currency: USDC,
        recipient: MERCHANT,
        methodDetails: {
          decimals: 6,
          feePayer: true,
          feePayerKey: "BFL9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F",
          network: "mainnet",
          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
      },
    });
    assert.equal(foundation.amount, "0.001");
    assert.equal(foundation.network, "solana:mainnet");
    assert.equal(foundation.payTo, MERCHANT);
    console.log(
      "foundation amount",
      foundation.amount,
      "network",
      foundation.network,
      "no MALFORMED_CHALLENGE",
      "no SPONSORED_CHARGE",
    );
    // Same value on both sides is one payment. @solana/mpp 0.7.0 pays
    // methodDetails.network and methodDetails.decimals.
    const agreed = mppChallengeToIntent(
      solanaCharge({
        decimals: 6,
        currency: DEVNET_USDC,
        cluster: "devnet",
        methodDetails: { decimals: 6, network: "devnet" },
      }),
    );
    assert.equal(agreed.amount, "0.05");
    assert.equal(agreed.network, "solana:devnet");
    // A disagreeing pair is not a silent preference. The client would pay the
    // nested network and decimals; the old parser scored the top-level ones.
    for (const [label, request] of [
      ["decimals", { decimals: 6, methodDetails: { decimals: 9, network: "mainnet" } }],
      ["cluster", { cluster: "devnet", methodDetails: { decimals: 6, network: "mainnet" } }],
      ["amount", { amount: "50000", methodDetails: { amount: "1000", decimals: 6 } }],
      ["recipient", { recipient: MERCHANT, methodDetails: { recipient: "OtherWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", decimals: 6 } }],
      ["currency", { currency: USDC, methodDetails: { currency: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 } }],
    ] as const) {
      assert.throws(
        () => mppChallengeToIntent(solanaCharge(request)),
        (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
        label,
      );
    }
    console.log("field conflict MALFORMED_CHALLENGE");
    // mainnet and mainnet-beta are one cluster in @solana/mpp 0.7.0.
    const aliased = mppChallengeToIntent(
      solanaCharge({
        cluster: "mainnet-beta",
        methodDetails: { decimals: 6, network: "mainnet" },
      }),
    );
    assert.equal(aliased.network, "solana:mainnet-beta");
    assert.equal(aliased.asset, USDC);
    // A devnet label does not make a mainnet mint a devnet charge. The client
    // keeps the raw mint and will sign a seller-supplied mainnet blockhash.
    assert.throws(
      () => mppChallengeToIntent(solanaCharge({ cluster: "devnet", currency: USDC })),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );
    assert.throws(
      () => mppChallengeToIntent(solanaCharge({ cluster: "localhost", currency: USDC })),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );
    const devnetMint = mppChallengeToIntent(
      solanaCharge({ cluster: "devnet", currency: DEVNET_USDC }),
    );
    assert.equal(devnetMint.network, "solana:devnet");
    assert.equal(devnetMint.asset, DEVNET_USDC);
    console.log("mint/cluster mismatch MALFORMED_CHALLENGE");
    assert.throws(
      () =>
        mppChallengeToIntent(
          solanaCharge({
            methodDetails: {
              decimals: 6,
              splits: [{ recipient: MERCHANT, amount: "1" }],
            },
          }),
        ),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );
    assert.throws(
      () =>
        mppChallengeToIntent(
          solanaCharge({ splits: [{ recipient: MERCHANT, amount: "1" }] }),
        ),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );
    const emptySplits = mppChallengeToIntent(
      solanaCharge({ methodDetails: { decimals: 6, network: "mainnet", splits: [] } }),
    );
    assert.equal(emptySplits.amount, "0.05");
    assert.equal(emptySplits.network, "solana:mainnet");
    console.log("splits MALFORMED_CHALLENGE");
    assert.throws(
      () => mppChallengeToIntent(solanaCharge({ sponsored: true })),
      (e: TwzrdMppBlockError) => e.code === "SPONSORED_CHARGE",
    );
    assert.throws(
      () => mppChallengeToIntent(solanaCharge({ feeTokenAmount: "1" })),
      (e: TwzrdMppBlockError) => e.code === "SPONSORED_CHARGE",
    );
    console.log("sponsored true SPONSORED_CHARGE");
    console.log("feeTokenAmount SPONSORED_CHARGE");
    assert.throws(
      () =>
        mppChallengeToIntent({
          id: "chal_bad_details",
          realm: "intel.twzrd.xyz",
          method: "solana",
          intent: "charge",
          request: {
            amount: "1000",
            currency: USDC,
            recipient: MERCHANT,
            methodDetails: { decimals: "6", network: "mainnet" },
          },
        }),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );
    console.log("string decimals MALFORMED_CHALLENGE");
  }

  /* 2. PRICING INVARIANT: intent.amount is USD, and the guard never invents it.
   *
   * The runtime enforces USD ceilings; the wire carries base-unit tokens.
   * Bridging the two by assuming "1 token == 1 dollar" would let a 1.5 SOL
   * charge (~$270) evaluate as "$1.50" and sail under maxAmountUsd. Unpriced
   * assets are refused instead of silently under-valued.
   */
  {
    // 2a. Native SOL with no price -> refused, NOT valued at 1.5 "USD".
    const solCharge = solanaCharge({
      currency: NATIVE_SOL_CURRENCY,
      amount: "1500000000",
      decimals: 9,
    });
    assert.throws(
      () => mppChallengeToIntent(solCharge),
      (e: TwzrdMppBlockError) => e.code === "UNPRICED_ASSET",
    );
    const unpriced = stubHelpers();
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "5.00" }, // would have "passed" at a fake $1.50
    });
    await assert.rejects(
      () => guard(solCharge, unpriced.helpers),
      (e: TwzrdMppBlockError) => e.code === "UNPRICED_ASSET",
    );
    assert.equal(unpriced.state.credentialCount, 0, "unpriced asset must not reach the signer");

    // 2b. There is no price escape hatch any more. A priced non-stablecoin
    // intent would record `asset: solana:native` beside a USD `amount` and lose
    // the token quantity actually transferred — binding a number the wallet is
    // not signing. SOL is refused outright, with no caller override.
    assert.ok(!("usdPerToken" in ({} as Record<string, unknown>)));
    const solAgain = stubHelpers();
    const guardStrict = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "5.00" },
    });
    await assert.rejects(
      () => guardStrict(solCharge, solAgain.helpers),
      (e: TwzrdMppBlockError) => e.code === "UNPRICED_ASSET",
    );
    assert.equal(solAgain.state.credentialCount, 0);

    // 2c. A stablecoin challenge that LIES about decimals is refused, not
    // discounted: 1e9 USDC base units declared at 9dp is $1,000, never "$1".
    assert.throws(
      () => mppChallengeToIntent(solanaCharge({ amount: "1000000000", decimals: 9 })),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );

    // 2d. Unknown mint, no price -> refused (no valuation, no reputation).
    assert.throws(
      () =>
        mppChallengeToIntent(
          solanaCharge({ currency: "Unkn0wnMint1111111111111111111111111111111" }),
        ),
      (e: TwzrdMppBlockError) => e.code === "UNPRICED_ASSET",
    );
  }

  /* 3. THE PROOF: block -> throw -> createCredential() and signer count stay 0 */
  {
    const { state, helpers } = stubHelpers();
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner({ keyId: "mpp-guard" }),
      intelligence: () => ({ washFlagged: true }),
    });
    await assert.rejects(
      () => guard(solanaCharge(), helpers),
      (e: TwzrdMppBlockError) =>
        e.code === "PAYMENT_CONTROL_BLOCK" && (e.reasonCodes ?? []).includes("WASH_FLAGGED"),
    );
    assert.equal(state.credentialCount, 0, "createCredential must never run on block");
    assert.equal(state.signerCount, 0, "nothing signs on block");
  }

  /* 4. Allow -> the guard itself creates the credential for the evaluated challenge */
  {
    const { state, helpers } = stubHelpers();
    const decisions: string[] = [];
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      onDecision: (d) => decisions.push(d.decision?.decision ?? "refusal"),
    });
    const credential = await guard(solanaCharge(), helpers);
    assert.equal(credential, "Payment credential=stub");
    assert.equal(state.credentialCount, 1);
    assert.deepEqual(decisions, ["allow"]);
  }

  /* 5. warn PROCEEDS by default (a warn is not a refusal); treatWarnAsBlock refuses */
  {
    const warnIntel = () => ({ decision: "warn" as const });
    const lenient = stubHelpers();
    const permissive = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      intelligence: warnIntel,
    });
    await permissive(solanaCharge(), lenient.helpers);
    assert.equal(lenient.state.credentialCount, 1, "warn pays by default - documented, not silent");

    const strict = stubHelpers();
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      intelligence: warnIntel,
      treatWarnAsBlock: true,
    });
    await assert.rejects(
      () => guard(solanaCharge(), strict.helpers),
      (e: TwzrdMppBlockError) =>
        e.code === "PAYMENT_CONTROL_BLOCK" && (e.reasonCodes ?? []).includes("INTEL_WARN"),
    );
    assert.equal(strict.state.credentialCount, 0);
  }

  /* 6. Local policy blocks without any reputation: amount ceiling on mainnet */
  {
    const { state, helpers } = stubHelpers();
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "0.01" }, // challenge asks $0.05
    });
    await assert.rejects(
      () => guard(solanaCharge(), helpers),
      (e: TwzrdMppBlockError) =>
        e.code === "PAYMENT_CONTROL_BLOCK" && (e.reasonCodes ?? []).includes("POLICY_MAX_AMOUNT"),
    );
    assert.equal(state.credentialCount, 0);
  }

  /* 7. Fail-closed on unevaluated methods; explicit opt-out passes through */
  {
    const tempo: MppChallenge = {
      id: "chal_tempo",
      realm: "api.example.com",
      method: "tempo",
      intent: "charge",
      request: { amount: "1000000", currency: "0xUSDC", recipient: "0xabc" },
    };
    const { state, helpers } = stubHelpers();
    const guard = createTwzrdMppOnChallenge({ signer: createLocalDecisionSigner() });
    await assert.rejects(
      () => guard(tempo, helpers),
      (e: TwzrdMppBlockError) => e.code === "UNEVALUATED_METHOD",
    );
    assert.equal(state.credentialCount, 0, "fail-closed: no credential for unevaluated methods");

    const passthrough = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      allowUnevaluated: true,
    });
    const result = await passthrough(tempo, helpers);
    assert.equal(result, undefined, "opt-out defers to mppx default flow");
    assert.equal(state.credentialCount, 0, "passthrough itself creates nothing");
  }

  /* 8. Malformed / adversarial challenges refuse before any credential exists */
  {
    const guard = createTwzrdMppOnChallenge({ signer: createLocalDecisionSigner() });
    const cases: Array<[string, MppChallenge]> = [
      ["missing recipient", solanaCharge({ recipient: undefined })],
      ["missing currency", solanaCharge({ currency: undefined })],
      ["non-integer amount", solanaCharge({ amount: "1.5" })],
      ["negative amount", solanaCharge({ amount: "-50000" })],
      ["negative decimals", solanaCharge({ decimals: -6 })],
      ["fractional decimals", solanaCharge({ decimals: 6.5 })],
      ["absurd decimals", solanaCharge({ decimals: 40 })],
    ];
    for (const [label, challenge] of cases) {
      const { state, helpers } = stubHelpers();
      await assert.rejects(
        () => guard(challenge, helpers),
        (e: TwzrdMppBlockError) =>
          e instanceof TwzrdMppBlockError && e.code === "MALFORMED_CHALLENGE",
        `${label} must refuse as MALFORMED_CHALLENGE`,
      );
      assert.equal(state.credentialCount, 0, `${label}: nothing signs`);
    }

    // A numeric (rather than string) amount is type-confusion-safe: it either
    // normalizes cleanly or refuses — it never reaches the signer unevaluated.
    const numeric = mppChallengeToIntent(solanaCharge({ amount: 50000 }));
    assert.equal(numeric.amount, "0.05");
  }

  console.log("mpp-hook.test.ts: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
