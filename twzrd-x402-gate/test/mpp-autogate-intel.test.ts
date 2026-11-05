/**
 * installTwzrdAutoGate("mpp") runs the same seller pipeline as the x402 seats by
 * default (preflight, readiness, merchant_card wash refuse, fail-closed outage).
 * `intelligence: false` keeps local policy only.
 * Run: npx tsx test/mpp-autogate-intel.test.ts
 */
import assert from "node:assert/strict";
import { installTwzrdAutoGate } from "../src/auto-gate.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import type { MppChallenge, MppOnChallengeHelpers } from "../src/mpp-hook.js";

const SELLER = "34w53UkhfBBmVLBcphD1M4dRhbBTQaLLbnRfyTeXzc5m";
const challenge = (): MppChallenge =>
  ({
    id: "c1",
    realm: "r",
    method: "solana",
    intent: "charge",
    request: {
      amount: "50000",
      currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      recipient: SELLER,
      cluster: "mainnet-beta",
    },
  }) as MppChallenge;

function helpers(): MppOnChallengeHelpers & { created: number } {
  const h = {
    created: 0,
    createCredential: async () => {
      h.created += 1;
      return "cred";
    },
  };
  return h;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("test: global fetch must not be used");
}) as typeof fetch;

try {
  // 1. Default: wash-flagged seller refused before createCredential.
  {
    const urls: string[] = [];
    const onChallenge = installTwzrdAutoGate("mpp", {
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      intelligenceOptions: {
        fetch: (async (u: string | URL | Request) => {
          urls.push(String(u));
          return json({
            readiness_card: { decision: "block", trust_score: 30, can_spend: false, wash_flagged: true },
            wash_flagged: true,
          });
        }) as typeof fetch,
      },
    });
    const h = helpers();
    const err = await onChallenge(challenge(), h).then(
      () => assert.fail("wash-flagged seller must be refused"),
      (e: { code?: string; message: string }) => e,
    );
    console.log("case1 refusal:", err.code, err.message);
    assert.equal(err.code, "PAYMENT_CONTROL_BLOCK");
    assert.match(err.message, /INTEL_BLOCK|WASH_FLAGGED/);
    assert.doesNotMatch(err.message, /unreachable|outage/i, "must be a wash/intel verdict, not an outage");
    assert.equal(h.created, 0, "no credential for a wash-flagged seller");
    assert.ok(urls.length > 0, "default MPP seat must call TWZRD intel");
  }

  // 2. Default: intel outage fails closed (no failOpen).
  {
    const onChallenge = installTwzrdAutoGate("mpp", {
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      intelligenceOptions: {
        fetch: (async () => {
          throw new Error("down");
        }) as unknown as typeof fetch,
      },
    });
    const h = helpers();
    await assert.rejects(() => onChallenge(challenge(), h));
    assert.equal(h.created, 0, "outage must not create a credential");
  }

  // 3. intelligence:false = local policy only, no network, credential created.
  {
    const onChallenge = installTwzrdAutoGate("mpp", {
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      intelligence: false,
    });
    const h = helpers();
    assert.equal(await onChallenge(challenge(), h), "cred");
    assert.equal(h.created, 1);
  }

  // 4. A caller-supplied provider replaces the default.
  {
    let calls = 0;
    const onChallenge = installTwzrdAutoGate("mpp", {
      signer: createLocalDecisionSigner(),
      policy: { maxAmountUsd: "1.00" },
      intelligence: async () => {
        calls += 1;
        return { washFlagged: true };
      },
    });
    const h = helpers();
    await assert.rejects(() => onChallenge(challenge(), h), /WASH_FLAGGED/);
    assert.equal(calls, 1);
    assert.equal(h.created, 0);
  }
  console.log("mpp-autogate-intel: 4 cases ok");
} finally {
  globalThis.fetch = realFetch;
}
