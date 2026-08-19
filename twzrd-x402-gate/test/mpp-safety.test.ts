/**
 * MPP guard — post-merge safety hardening.
 *
 * Every case here is one where the transaction mppx-solana would actually SIGN
 * is not the transaction the decision covers. All were verified against the
 * published mppx-solana@0.2.0 `charge` schema, not inferred from docs.
 *
 * Run: npx tsx test/mpp-safety.test.ts
 */
import assert from "node:assert/strict";

import {
  createTwzrdMppOnChallenge,
  mppChallengeDigest,
  mppChallengeToIntent,
  TwzrdMppBlockError,
  type MppChallenge,
} from "../src/mpp-hook.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { intentHash } from "../src/intent.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";

function challenge(request: Record<string, unknown>): MppChallenge {
  return {
    id: "ch_1",
    realm: "merchant.example",
    method: "solana",
    intent: "charge",
    request: { amount: "50000", currency: USDC, decimals: 6, recipient: SELLER, ...request },
  };
}

function expectCode(fn: () => unknown, code: TwzrdMppBlockError["code"]): TwzrdMppBlockError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TwzrdMppBlockError, `expected TwzrdMppBlockError, got ${e}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  throw new assert.AssertionError({ message: `expected ${code}, but nothing threw` });
}

async function run() {
  /* ── 1. Sponsored charges: a second, unbindable transfer ───────────── */
  {
    // mppx-solana transfers feeTokenAmount to the sponsor IN ADDITION to the
    // advertised amount. PaymentIntent v1 binds one amount to one payTo, so an
    // approved sponsored charge moves strictly more money than the decision.
    const e = expectCode(
      () => mppChallengeToIntent(challenge({ sponsored: true, sponsorPath: "/sponsor", feeTokenAmount: "10000" })),
      "SPONSORED_CHARGE",
    );
    assert.ok(e.message.includes("10000"), "refusal should name the unbound fee amount");

    // Each sponsorship marker alone is sufficient to refuse — a challenge does
    // not get to sponsor by only setting one of the three.
    expectCode(() => mppChallengeToIntent(challenge({ sponsored: true })), "SPONSORED_CHARGE");
    expectCode(() => mppChallengeToIntent(challenge({ sponsorPath: "/sponsor" })), "SPONSORED_CHARGE");
    expectCode(() => mppChallengeToIntent(challenge({ feeTokenAmount: "1" })), "SPONSORED_CHARGE");

    // Unsponsored still works.
    assert.equal(mppChallengeToIntent(challenge({})).amount, "0.05");
  }

  /* ── 2. Cluster must be a cluster, not an RPC endpoint ─────────────── */
  {
    // resolveEndpoint() returns an unrecognized cluster verbatim as the RPC URL,
    // and our classifier scores any network containing "solana" — so this would
    // otherwise be scored as mainnet against a seller-chosen node.
    for (const cluster of [
      "https://seller-rpc.example",
      "http://127.0.0.1:8899",
      "mainnet-beta-but-not-really",
    ]) {
      expectCode(() => mppChallengeToIntent(challenge({ cluster })), "UNKNOWN_CLUSTER");
    }

    // Known clusters pass and keep their honest name (devnet stays unscored
    // downstream; mainnet stays scored).
    assert.equal(mppChallengeToIntent(challenge({ cluster: "mainnet-beta" })).network, "solana:mainnet-beta");
    assert.equal(mppChallengeToIntent(challenge({ cluster: "devnet" })).network, "solana:devnet");
    // Absent cluster defaults to mainnet-beta, as mppx-solana does.
    assert.equal(mppChallengeToIntent(challenge({})).network, "solana:mainnet-beta");
  }

  /* ── 3. USD-pegged assets only ─────────────────────────────────────── */
  {
    // Native SOL: pricing it would record `asset: solana:native` beside a USD
    // `amount` and lose the token quantity actually moving. Refuse instead.
    const sol = expectCode(
      () => mppChallengeToIntent(challenge({ currency: "solana:native", decimals: 9, amount: "1500000000" })),
      "UNPRICED_ASSET",
    );
    assert.ok(sol.message.includes("solana:native"));

    // Arbitrary mint: same.
    expectCode(
      () => mppChallengeToIntent(challenge({ currency: "So11111111111111111111111111111111111111112", decimals: 9 })),
      "UNPRICED_ASSET",
    );

    // There is no caller escape hatch any more: the guard takes no price input,
    // so a non-pegged asset cannot be talked into an intent at all.
    assert.equal(mppChallengeToIntent(challenge({ currency: USDC })).asset, USDC);

    // A stablecoin lying about its decimals is a discount attempt, not rounding.
    expectCode(() => mppChallengeToIntent(challenge({ decimals: 9 })), "MALFORMED_CHALLENGE");
  }

  /* ── 4. The intent binds the WHOLE challenge, not realm:id ─────────── */
  {
    const base = challenge({});
    const baseline = intentHash(mppChallengeToIntent(base));

    // Same realm + id, mutated payload -> different digest, different intent.
    const mutations: Array<Record<string, unknown>> = [
      { recipient: "9zZ1kQmVN3Wt7xFqYuLpJ2rD8sT4vB6cA5hG1nE3oPxK" }, // payee swap
      { amount: "5000000" }, //                                        amount inflation
      { cluster: "devnet" }, //                                        chain swap
      { memo: "different" }, //                                        any field mppx acts on
    ];
    for (const m of mutations) {
      const mutated = challenge(m);
      assert.equal(mutated.id, base.id, "same challenge id");
      assert.equal(mutated.realm, base.realm, "same realm");
      assert.notEqual(
        mppChallengeDigest(mutated),
        mppChallengeDigest(base),
        `mutation ${JSON.stringify(m)} must change the challenge digest`,
      );
      assert.notEqual(
        intentHash(mppChallengeToIntent(mutated)),
        baseline,
        `mutation ${JSON.stringify(m)} must change the intent hash`,
      );
    }

    // Key ORDER is not a mutation — canonicalization must be stable.
    const reordered: MppChallenge = {
      ...base,
      request: { recipient: SELLER, decimals: 6, currency: USDC, amount: "50000" },
    };
    assert.equal(mppChallengeDigest(reordered), mppChallengeDigest(base), "digest is order-stable");
  }

  /* ── 5. Telemetry cannot mutate the challenge mid-flight ───────────── */
  {
    // onDecision runs BEFORE createCredential(). If it received the live object,
    // an observer could swap the payee between evaluation and signing.
    let signed = 0;
    const guard = createTwzrdMppOnChallenge({
      signer: await createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      onDecision: (detail) => {
        assert.ok(Object.isFrozen(detail.challenge), "challenge handed to telemetry must be frozen");
        try {
          (detail.challenge.request as Record<string, unknown>).recipient = "ATTACKER";
        } catch {
          // strict mode throws on frozen write — also acceptable
        }
      },
    });

    const live = challenge({});
    const credential = await guard(live, {
      createCredential: async () => {
        signed += 1;
        return "cred_1";
      },
    });

    assert.equal(credential, "cred_1");
    assert.equal(signed, 1);
    // The real challenge the credential was created for is untouched.
    assert.equal((live.request as Record<string, unknown>).recipient, SELLER);
  }

  /* ── 6. Refusals never reach the signer ────────────────────────────── */
  {
    let signed = 0;
    const guard = createTwzrdMppOnChallenge({
      signer: await createLocalDecisionSigner(),
      onDecision: () => {},
    });
    const createCredential = async () => {
      signed += 1;
      return "cred";
    };

    for (const bad of [
      challenge({ sponsored: true, sponsorPath: "/s", feeTokenAmount: "1" }),
      challenge({ cluster: "https://seller-rpc.example" }),
      challenge({ currency: "solana:native", decimals: 9 }),
    ]) {
      await assert.rejects(() => guard(bad, { createCredential }), TwzrdMppBlockError);
    }
    assert.equal(signed, 0, "a refused charge must never invoke createCredential");
  }

  console.log("mpp-safety.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("mpp-safety.test.ts FAILED:", e);
  process.exit(1);
});
