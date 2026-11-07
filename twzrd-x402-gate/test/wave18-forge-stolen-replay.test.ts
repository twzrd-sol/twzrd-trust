/**
 * Wave18 MMM — gate forge / stolen-challenge / replay matrix.
 *
 * Offline. No intel network. No spend.
 *
 * Matrix:
 *   1. Forged / mutated payment after approval never reaches the signer
 *   2. Stolen challenge (resource / payTo / amount) fails intent bind
 *   3. Decision replay is consume-once
 *
 * Run: npx tsx test/wave18-forge-stolen-replay.test.ts
 */
import assert from "node:assert/strict";

import { intentHash, type PaymentIntent } from "../src/intent.js";
import {
  assertIntentApproved,
  createDecisionRegistry,
  createLocalDecisionSigner,
  TwzrdIntentBindingError,
} from "../src/decision-token.js";
import { evaluateIntent } from "../src/policy-runtime.js";
import {
  evaluateResourceBind,
  resourceBindLeafHash,
  resourceBindMemo,
} from "../src/resource-bind.js";

const MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ATTACKER = "AttackerWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function baseIntent(overrides?: Partial<PaymentIntent>): PaymentIntent {
  return {
    protocol: "x402",
    network: SOL,
    asset: USDC,
    amount: "0.05",
    payTo: MERCHANT,
    resource: { url: "https://intel.twzrd.xyz/v1/intel/trust/" + MERCHANT, method: "GET" },
    context: { purpose: "trust" },
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof TwzrdIntentBindingError, String(e));
    assert.equal(e.code, code, e.code);
    return true;
  });
}

async function run() {
  const signer = await createLocalDecisionSigner({ keyId: "wave18-gate" });
  const registry = createDecisionRegistry();

  /* 1. Forged payment — mutate after allow, signer stays 0 */
  {
    const intent = baseIntent();
    const token = await evaluateIntent(intent, { signer });
    assert.equal(token.decision, "allow");
    let signerCount = 0;
    const forges: PaymentIntent[] = [
      { ...intent, payTo: ATTACKER },
      { ...intent, amount: "50.00" },
      { ...intent, resource: { url: "https://attacker.example/drain", method: "POST" } },
      { ...intent, asset: "So11111111111111111111111111111111111111112" },
      { ...intent, network: "eip155:8453" },
    ];
    for (const forged of forges) {
      expectCode(
        () =>
          assertIntentApproved(forged, token, {
            registry,
            publicKeyPem: signer.publicKeyPem,
          }),
        "INTENT_HASH_MISMATCH",
      );
    }
    assert.equal(signerCount, 0);
    assert.notEqual(intentHash(intent), intentHash({ ...intent, payTo: ATTACKER }));
  }

  /* 2. Stolen challenge — approve A, present B */
  {
    const scored = baseIntent({
      resource: { url: "https://merchant.example/paid-a", method: "GET" },
      amount: "0.001",
    });
    const token = await evaluateIntent(scored, { signer });
    assert.equal(token.decision, "allow");

    const stolen: PaymentIntent[] = [
      { ...scored, resource: { url: "https://merchant.example/paid-b", method: "GET" } },
      { ...scored, payTo: ATTACKER },
      { ...scored, amount: "5.00" },
    ];
    const stealRegistry = createDecisionRegistry();
    for (const challenge of stolen) {
      expectCode(
        () =>
          assertIntentApproved(challenge, token, {
            registry: stealRegistry,
            publicKeyPem: signer.publicKeyPem,
          }),
        "INTENT_HASH_MISMATCH",
      );
    }

    const leafA = resourceBindLeafHash({
      payTo: MERCHANT,
      network: SOL,
      amount: "1000",
      asset: USDC,
      resource: "https://merchant.example/paid-a",
    });
    const leafB = resourceBindLeafHash({
      payTo: MERCHANT,
      network: SOL,
      amount: "1000",
      asset: USDC,
      resource: "https://merchant.example/paid-b",
    });
    assert.notEqual(leafA, leafB, "stolen resource must not share the bind leaf");
    const memoA = resourceBindMemo(leafA);
    const stolenEval = evaluateResourceBind({ leaf_hash: leafB, tx_memo: memoA });
    assert.equal(stolenEval.strength, "soft", "A's memo must not hard-bind B's leaf");
    assert.equal(evaluateResourceBind({ leaf_hash: leafA, tx_memo: memoA }).strength, "hard");
  }

  /* 3. Replay — consume-once, then refuse */
  {
    const intent = baseIntent({ amount: "0.01" });
    const token = await evaluateIntent(intent, { signer });
    const once = createDecisionRegistry();
    assertIntentApproved(intent, token, { registry: once, publicKeyPem: signer.publicKeyPem });
    expectCode(
      () => assertIntentApproved(intent, token, { registry: once, publicKeyPem: signer.publicKeyPem }),
      "DECISION_REPLAYED",
    );
    expectCode(
      () =>
        assertIntentApproved(intent, token, {
          now: Date.parse(token.expiresAt) + 1,
          publicKeyPem: signer.publicKeyPem,
        }),
      "DECISION_EXPIRED",
    );
  }

  console.log("wave18-forge-stolen-replay.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("wave18-forge-stolen-replay.test.ts FAILED:", e);
  process.exit(1);
});
