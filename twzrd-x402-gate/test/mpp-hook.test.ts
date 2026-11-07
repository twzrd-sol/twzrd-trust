/**
 * TWZRD Payment Control on MPP (Machine Payments Protocol) — Solana and Tempo charges.
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
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { intentHash } from "../src/intent.js";
import { classifyNetwork } from "../src/network.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { tempDir } from "./helpers/tmpdir.js";
import {
  createTwzrdMppIntegration,
  createTwzrdMppOnChallenge as createRawTwzrdMppOnChallenge,
  evaluateTwzrdMppChallenge as evaluateRawTwzrdMppChallenge,
  mppChallengeToIntent,
  mppTempoChargeToIntent,
  NATIVE_SOL_CURRENCY,
  TwzrdMppBlockError,
  type MppChallenge,
} from "../src/mpp-hook.js";

const decisionFile = join(tempDir("twzrd-mpp-ledger-"), "decisions.jsonl");
const createTwzrdMppOnChallenge = (
  options: Parameters<typeof createRawTwzrdMppOnChallenge>[0],
) => createRawTwzrdMppOnChallenge({ ...options, decisionFile });
const evaluateTwzrdMppChallenge = (
  challenge: MppChallenge,
  options: Parameters<typeof evaluateRawTwzrdMppChallenge>[1],
) => evaluateRawTwzrdMppChallenge(challenge, { ...options, decisionFile });

const MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEMPO_MERCHANT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";

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

function tempoCharge(overrides?: Record<string, unknown>): MppChallenge {
  return {
    id: "tempo_chal_1",
    realm: "api.example.com",
    method: "tempo",
    intent: "charge",
    expires: "2030-01-01T00:00:00Z",
    request: {
      amount: "1000000",
      currency: PATH_USD,
      recipient: TEMPO_MERCHANT,
      methodDetails: { chainId: 42431, supportedModes: ["pull"] },
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
      {
        resourceUrl: "https://api.example.com/paid/report",
        method: "GET",
        purpose: "research_api",
      },
    );
    assert.notEqual(
      intentHash(intent),
      intentHash(other),
      "challenge id rotates the hash",
    );

    // Mainnet is reputation-scored; devnet keeps its honest unscored name.
    assert.equal(classifyNetwork(intent.network).reputationScored, true);
    const dev = mppChallengeToIntent(
      solanaCharge({ cluster: "devnet", currency: DEVNET_USDC }),
    );
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
      [
        "decimals",
        { decimals: 6, methodDetails: { decimals: 9, network: "mainnet" } },
      ],
      [
        "cluster",
        {
          cluster: "devnet",
          methodDetails: { decimals: 6, network: "mainnet" },
        },
      ],
      [
        "amount",
        { amount: "50000", methodDetails: { amount: "1000", decimals: 6 } },
      ],
      [
        "recipient",
        {
          recipient: MERCHANT,
          methodDetails: {
            recipient: "OtherWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            decimals: 6,
          },
        },
      ],
      [
        "currency",
        {
          currency: USDC,
          methodDetails: {
            currency: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            decimals: 6,
          },
        },
      ],
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
      () =>
        mppChallengeToIntent(
          solanaCharge({ cluster: "devnet", currency: USDC }),
        ),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );
    assert.throws(
      () =>
        mppChallengeToIntent(
          solanaCharge({ cluster: "localhost", currency: USDC }),
        ),
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
      solanaCharge({
        methodDetails: { decimals: 6, network: "mainnet", splits: [] },
      }),
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
    assert.equal(
      unpriced.state.credentialCount,
      0,
      "unpriced asset must not reach the signer",
    );

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
      () =>
        mppChallengeToIntent(
          solanaCharge({ amount: "1000000000", decimals: 9 }),
        ),
      (e: TwzrdMppBlockError) => e.code === "MALFORMED_CHALLENGE",
    );

    // 2d. Unknown mint, no price -> refused (no valuation, no reputation).
    assert.throws(
      () =>
        mppChallengeToIntent(
          solanaCharge({
            currency: "Unkn0wnMint1111111111111111111111111111111",
          }),
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
        e.code === "PAYMENT_CONTROL_BLOCK" &&
        (e.reasonCodes ?? []).includes("WASH_FLAGGED"),
    );
    assert.equal(
      state.credentialCount,
      0,
      "createCredential must never run on block",
    );
    assert.equal(state.signerCount, 0, "nothing signs on block");
  }

  /* 4. Allow -> the guard itself creates the credential for the evaluated challenge */
  {
    const { state, helpers } = stubHelpers();
    const decisions: string[] = [];
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      intelligence: () => ({ known: true, washFlagged: false, decision: "allow" }),
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
    assert.equal(
      lenient.state.credentialCount,
      1,
      "warn pays by default - documented, not silent",
    );

    const strict = stubHelpers();
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      intelligence: warnIntel,
      treatWarnAsBlock: true,
    });
    await assert.rejects(
      () => guard(solanaCharge(), strict.helpers),
      (e: TwzrdMppBlockError) =>
        e.code === "PAYMENT_CONTROL_BLOCK" &&
        (e.reasonCodes ?? []).includes("INTEL_WARN"),
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
        e.code === "PAYMENT_CONTROL_BLOCK" &&
        (e.reasonCodes ?? []).includes("POLICY_MAX_AMOUNT"),
    );
    assert.equal(state.credentialCount, 0);
  }

  /* 6a. A zero ceiling refuses every positive MPP charge before credentials. */
  {
    const { state, helpers } = stubHelpers();
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "0" },
    });
    await assert.rejects(
      () => guard(tempoCharge(), helpers),
      (e: TwzrdMppBlockError) =>
        e.code === "PAYMENT_CONTROL_BLOCK" &&
        (e.reasonCodes ?? []).includes("POLICY_MAX_AMOUNT"),
    );
    assert.equal(state.credentialCount, 0, "zero ceiling refuses before credential creation");
  }

  /* 7. Tempo charge normalization, policy evaluation, and fail-closed refusal */
  {
    const challenge = tempoCharge();
    const intent = mppChallengeToIntent(challenge, {
      resourceUrl: "https://api.example.com/paid",
      method: "GET",
      purpose: "research_api",
      now: Date.parse("2029-01-01T00:00:00Z"),
    });
    assert.equal(intent.protocol, "mpp");
    assert.equal(intent.network, "eip155:42431");
    assert.equal(intent.amount, "1");
    assert.equal(intent.asset, PATH_USD);
    assert.equal(intent.payTo, TEMPO_MERCHANT.toLowerCase());
    assert.equal(intent.resource?.url, "https://api.example.com/paid");
    assert.match(
      String(intent.resource?.operation),
      /^mpp-charge:api\.example\.com:tempo_chal_1:[0-9a-f]{64}$/,
    );

    const mainnet = mppTempoChargeToIntent({
      ...tempoCharge(),
      request: {
        amount: "750",
        currency: USDC_E,
        recipient: TEMPO_MERCHANT,
        methodDetails: { chainId: 4217 },
      },
    });
    assert.equal(mainnet.network, "eip155:4217");
    assert.equal(mainnet.amount, "0.00075");
    assert.equal(mainnet.asset, USDC_E);

    const mutated = mppChallengeToIntent(tempoCharge({ amount: "1000001" }));
    assert.notEqual(
      intentHash(intent),
      intentHash(mutated),
      "full challenge amount is bound",
    );

    const blocked = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "0.50" },
      now: () => Date.parse("2029-01-01T00:00:00Z"),
    });
    const { state, helpers } = stubHelpers();
    await assert.rejects(
      () => blocked(challenge, helpers),
      (e: TwzrdMppBlockError) => e.code === "PAYMENT_CONTROL_BLOCK",
    );
    assert.equal(
      state.credentialCount,
      0,
      "Tempo policy block happens before credential creation",
    );

    const evaluation = await evaluateTwzrdMppChallenge(challenge, {
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "0.50" },
      now: () => Date.parse("2029-01-01T00:00:00Z"),
    });
    assert.equal(evaluation.disposition, "block");
    assert.ok(evaluation.decision.reasonCodes.length > 0);

    const malformed: Array<[string, MppChallenge]> = [
      ["missing recipient", tempoCharge({ recipient: undefined })],
      ["non-integer amount", tempoCharge({ amount: "1.5" })],
      ["zero amount", tempoCharge({ amount: "0" })],
      ["unknown chain", tempoCharge({ methodDetails: { chainId: 1 } })],
      ["chain conflict", tempoCharge({ network: "eip155:4217" })],
      [
        "unknown asset",
        tempoCharge({ currency: "0x0000000000000000000000000000000000000001" }),
      ],
      [
        "split transfer",
        tempoCharge({
          methodDetails: {
            chainId: 42431,
            splits: [{ amount: "1", recipient: TEMPO_MERCHANT }],
          },
        }),
      ],
      [
        "machine token route",
        tempoCharge({
          methodDetails: { chainId: 42431, machineTokenEnabled: true },
        }),
      ],
      ["unsupported intent", { ...tempoCharge(), intent: "session" }],
      ["expired", { ...tempoCharge(), expires: "2028-01-01T00:00:00Z" }],
    ];
    for (const [label, badChallenge] of malformed) {
      const { state: badState, helpers: badHelpers } = stubHelpers();
      await assert.rejects(
        () =>
          createTwzrdMppOnChallenge({
            signer: createLocalDecisionSigner(),
            now: () => Date.parse("2029-01-01T00:00:00Z"),
          })(badChallenge, badHelpers),
        (e: TwzrdMppBlockError) => e instanceof TwzrdMppBlockError,
        label,
      );
      assert.equal(
        badState.credentialCount,
        0,
        `${label} refuses before credential creation`,
      );
    }

    assert.throws(
      () => mppChallengeToIntent({ ...tempoCharge(), method: "stripe" }),
      (e: TwzrdMppBlockError) => e.code === "UNEVALUATED_METHOD",
    );
    console.log(
      "tempo/charge allowlist, challenge binding, and pre-credential refusal pass",
    );
  }

  /* 8. Malformed / adversarial challenges refuse before any credential exists */
  {
    const guard = createTwzrdMppOnChallenge({
      signer: createLocalDecisionSigner(),
    });
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

  /* 9. Gate and MPP receipts append to one local decision ledger by default. */
  {
    const offline = await evaluateTwzrdMppChallenge(tempoCharge(), {
      signer: createLocalDecisionSigner(),
      now: () => Date.parse("2029-01-01T00:00:00Z"),
    });
    assert.equal(offline.disposition, "warn");
    assert.ok(offline.decision.reasonCodes.includes("reputation_unchecked"));

    const unscoredFile = join(tempDir("twzrd-mpp-unscored-"), "decisions.jsonl");
    let intelFetches = 0;
    const defaultIntegration = createTwzrdMppIntegration({
      signer: createLocalDecisionSigner(),
      now: () => Date.parse("2029-01-01T00:00:00Z"),
      decisionFile: unscoredFile,
      intelligenceOptions: {
        fetch: async () => {
          intelFetches += 1;
          throw new Error("unscored Tempo network must not query reputation");
        },
      },
    });
    const unsupportedTempo = await defaultIntegration.gate(tempoCharge());
    assert.equal(unsupportedTempo.disposition, "block", "unscored Tempo blocks by default");
    assert.equal(intelFetches, 0, "strict unscored-network policy refuses before intelligence fetch");
    await defaultIntegration.flush();
    const unscoredRows = readFileSync(unscoredFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(unscoredRows[0].outcome, "block");

    assert.throws(
      () => createTwzrdMppIntegration({
        signer: createLocalDecisionSigner(),
        allowUnscoredNetwork: true,
        intelligence: () => ({ known: false }),
      }),
      /allowUnscoredNetwork requires an explicit policy.maxAmountUsd ceiling/,
    );
    const underCeilingOptIn = createTwzrdMppIntegration({
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "0.01" },
      allowUnscoredNetwork: true,
      intelligence: () => ({ known: false }),
      decisionFile: join(tempDir("twzrd-mpp-optin-"), "decisions.jsonl"),
    });
    const optInDecision = await underCeilingOptIn.gate(tempoCharge({ amount: "1000" }));
    assert.equal(optInDecision.disposition, "warn");
    assert.ok(optInDecision.reasonCodes?.includes("reputation_unchecked"));
    await underCeilingOptIn.flush();

    // The same opt-in with the DEFAULT TWZRD provider (no `intelligence` stub).
    // Tempo is unscored, so no reputation runs and `known` stays undefined
    // (never collapsed to false): the result is a plain ALLOW, not a
    // reputation_unchecked warning. The provider still GETs the payee's
    // merchant card for the wash check only: wash_flagged=true refuses, and a
    // card outage keeps the allow (the observe path does not fail closed).
    const defaultProviderOptIn = async (card: () => Promise<Response>) => {
      const urls: string[] = [];
      const integration = createTwzrdMppIntegration({
        signer: createLocalDecisionSigner(),
        policy: { maxAmountUsd: "0.01" },
        allowUnscoredNetwork: true,
        intelligenceOptions: {
          fetch: async (input: string | URL | Request) => {
            urls.push(String(input instanceof Request ? input.url : input));
            return card();
          },
        },
        decisionFile: join(tempDir("twzrd-mpp-optin-default-"), "decisions.jsonl"),
      });
      const decision = await integration.gate(tempoCharge({ amount: "1000" }));
      await integration.flush();
      return { decision, urls };
    };
    const cardJson = (body: Record<string, unknown>) => async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const clean = await defaultProviderOptIn(cardJson({ wash_flagged: false }));
    assert.equal(clean.decision.disposition, "allow");
    assert.deepEqual([...(clean.decision.reasonCodes ?? [])], ["ALLOW"]);
    assert.equal(clean.urls.length, 1, "only the merchant card is fetched");
    assert.ok(
      clean.urls[0].includes(`/merchant_card/${TEMPO_MERCHANT.toLowerCase()}`),
      `unexpected intel request: ${clean.urls[0]}`,
    );

    const outage = await defaultProviderOptIn(async () => {
      throw new Error("intel unreachable");
    });
    assert.equal(outage.decision.disposition, "allow", "a card outage keeps the opt-in allow");
    assert.deepEqual([...(outage.decision.reasonCodes ?? [])], ["ALLOW"]);

    const washed = await defaultProviderOptIn(cardJson({ wash_flagged: true }));
    assert.equal(washed.decision.disposition, "block", "a wash-flagged payee still refuses");
    assert.ok(washed.decision.reasonCodes?.includes("WASH_FLAGGED"), JSON.stringify(washed.decision));

    const path = join(tempDir("twzrd-mpp-integration-"), "decisions.jsonl");
    const integration = createTwzrdMppIntegration({
      signer: createLocalDecisionSigner(),
      now: () => Date.parse("2029-01-01T00:00:00Z"),
      intelligence: () => ({
        known: true,
        washFlagged: false,
        decision: "allow",
      }),
      decisionFile: path,
    });
    const gate = await integration.gate(tempoCharge());
    assert.equal(gate.disposition, "allow");
    integration.onFulfillment({
      at_unix_ms: Date.now(),
      resource_origin: "https://api.example.com/private?token=secret",
      http_status: 200,
      payment_method: "tempo",
      payment_intent: "charge",
      challenge_id: "tempo_chal_1",
      paid_to: TEMPO_MERCHANT,
      network: "eip155:42431",
      asset: PATH_USD,
      amount_atomic: "1000000",
      receipt_state: "valid_format",
      receipt_status: "success",
      receipt_method: "tempo",
      receipt_reference: `0x${"c".repeat(64)}`,
      receipt_timestamp: "2026-11-05T23:00:00Z",
      requested_model: "qwen3-coder-30b",
      seller_reported_model: "qwen3-coder-30b",
      seller_reported_model_matches_request: true,
      gate,
    });
    await integration.flush();
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].schema_version, 1);
    assert.equal(rows[0].outcome, "allow");
    assert.equal(
      rows[0].signer_invocations,
      0,
      "the payment signer has not run before the gate returns",
    );
    assert.equal(rows[1].schema_version, 3);
    assert.equal(rows[1].record_type, "mpp_fulfillment");
    assert.equal(rows[1].resource_origin, "https://api.example.com");
    assert.equal(rows[1].receipt_reference, `0x${"c".repeat(64)}`);
    assert.equal(rows[1].response_bytes, null);
    assert.equal(rows[1].body_sha256, null);
    assert.equal(rows[1].receipt_reference_chain_verified, null);
    assert.equal(readFileSync(path, "utf8").includes("token=secret"), false);

    const { state, helpers } = stubHelpers();
    await assert.rejects(
      () => createTwzrdMppOnChallenge({
        signer: createLocalDecisionSigner(),
        treatWarnAsBlock: true,
      })(tempoCharge(), helpers),
      (error: TwzrdMppBlockError) => error.code === "PAYMENT_CONTROL_BLOCK",
    );
    assert.equal(state.credentialCount, 0, "offline reputation warning can be configured to block before signing");
  }

  /* 10. The MPP gate refuses before signing when its mandatory local ledger fails. */
  {
    const directoryAsFile = join(
      tempDir("twzrd-mpp-ledger-failure-"),
      "decisions.jsonl",
    );
    mkdirSync(directoryAsFile);
    await assert.rejects(
      () =>
        evaluateRawTwzrdMppChallenge(tempoCharge(), {
          signer: createLocalDecisionSigner(),
          decisionFile: directoryAsFile,
          intelligence: () => ({
            known: true,
            washFlagged: false,
            decision: "allow",
          }),
        }),
      (error: TwzrdMppBlockError) => error.code === "DECISION_LOG_UNAVAILABLE",
    );
  }

  console.log("mpp-hook.test.ts: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
