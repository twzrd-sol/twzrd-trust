/**
 * TWZRD Payment Control — core invariant tests.
 * Run: npx tsx test/payment-control.test.ts
 *
 * The headline is the category test (definition of done):
 *   mandate permits software < $100 -> agent prepares $12 checkout ->
 *   TWZRD approves the exact merchant/amount/resource -> orchestration
 *   mutates payTo after approval -> wallet refuses (intentHash mismatch) ->
 *   signerInvocationCount === 0 -> decision AND refusal independently
 *   auditable.
 */
import assert from "node:assert/strict";

import { canonicalJson, intentHash, toMicroUsd, type PaymentIntent } from "../src/intent.js";
import { classifyNetwork } from "../src/network.js";
import {
  assertIntentApproved,
  createDecisionRegistry,
  createLocalDecisionSigner,
  TwzrdIntentBindingError,
  verifyDecisionSignature,
} from "../src/decision-token.js";
import {
  createMemorySpendLedger,
  evaluateIntent,
  POLICY_VERSION,
} from "../src/policy-runtime.js";
import { ap2CheckoutToIntent, x402RequirementsToIntent } from "../src/intent-adapters.js";

const MERCHANT = "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ATTACKER = "AttackerWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function baseIntent(overrides?: Partial<PaymentIntent>): PaymentIntent {
  return {
    protocol: "x402",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "12.00",
    payTo: MERCHANT,
    resource: { url: "https://store.example/checkout/pro-plan", method: "POST" },
    context: { purpose: "software" },
    ...overrides,
  };
}

async function run() {
  /* 1. Canonicalization + hash determinism */
  {
    const a = intentHash(baseIntent());
    const i = baseIntent();
    const reordered: PaymentIntent = {
      context: { purpose: i.context!.purpose },
      resource: { method: i.resource!.method, url: i.resource!.url },
      payTo: i.payTo,
      amount: i.amount,
      asset: i.asset,
      network: i.network,
      protocol: i.protocol,
    };
    assert.equal(a, intentHash(reordered), "hash must be key-order independent");
    assert.match(a, /^tiv1:[0-9a-f]{64}$/);

    const mutated = intentHash(baseIntent({ amount: "12.01" }));
    assert.notEqual(a, mutated, "amount change must change the hash");
    assert.notEqual(a, intentHash(baseIntent({ payTo: ATTACKER })));
    assert.notEqual(
      a,
      intentHash(baseIntent({ resource: { url: "https://store.example/admin/export" } })),
    );

    // canonical form drops null/undefined members
    assert.equal(canonicalJson({ b: 1, a: "x", c: undefined }), '{"a":"x","b":1}');
    assert.equal(toMicroUsd("0.10"), 100_000n);
    assert.throws(() => toMicroUsd("1e3"));
  }

  /* 2. DEFINITION OF DONE — the category test */
  {
    const signer = createLocalDecisionSigner({ keyId: "test-key" });
    const registry = createDecisionRegistry();
    const audit: Array<Record<string, unknown>> = [];

    // 1. User mandate permits software purchases under $100.
    const mandate = {
      mandateId: "mandate-software-100",
      purposes: ["software"],
      maxPerTransactionUsd: "100",
      resourceAllow: ["https://store.example/checkout/"],
    };

    // 2. Agent prepares a $12 checkout.
    const intent = baseIntent();

    // 3. TWZRD approves the exact merchant, amount and resource.
    const token = await evaluateIntent(intent, { signer, mandate });
    assert.equal(token.decision, "allow");
    assert.equal(token.policyVersion, POLICY_VERSION);
    assert.equal(token.intentHash, intentHash(intent));
    audit.push({ kind: "decision", token });

    // 4. Merchant or orchestration layer mutates payTo after approval.
    const tampered = { ...intent, payTo: ATTACKER };

    // 5+6. Wallet refuses because intentHash no longer matches; signer = 0.
    let signerInvocationCount = 0;
    const signTransaction = async () => {
      signerInvocationCount += 1;
      throw new Error("signer must never run");
    };
    let refusal: TwzrdIntentBindingError | null = null;
    try {
      assertIntentApproved(tampered, token, {
        registry,
        publicKeyPem: signer.publicKeyPem,
      });
      await signTransaction();
    } catch (error) {
      refusal = error as TwzrdIntentBindingError;
    }
    assert.ok(refusal instanceof TwzrdIntentBindingError);
    assert.equal(refusal.code, "INTENT_HASH_MISMATCH");
    assert.equal(signerInvocationCount, 0, "signerInvocationCount must be 0");
    audit.push({ kind: "refusal", code: refusal.code, decisionId: refusal.decisionId });

    // 7. Decision and refusal are independently auditable.
    const [decisionRecord, refusalRecord] = audit;
    assert.ok(
      verifyDecisionSignature(
        (decisionRecord as { token: typeof token }).token,
        signer.publicKeyPem,
      ),
      "decision token must verify from the audit record alone",
    );
    assert.equal(refusalRecord.decisionId, token.decisionId);

    // The UNTAMPERED intent still passes binding — and consumes the token once.
    assertIntentApproved(intent, token, { registry, publicKeyPem: signer.publicKeyPem });
  }

  /* 3. Consume-once + expiry + signature */
  {
    const signer = createLocalDecisionSigner();
    const registry = createDecisionRegistry();
    const intent = baseIntent();
    const token = await evaluateIntent(intent, { signer });

    assertIntentApproved(intent, token, { registry });
    assert.throws(
      () => assertIntentApproved(intent, token, { registry }),
      (e: TwzrdIntentBindingError) => e.code === "DECISION_REPLAYED",
    );

    assert.throws(
      () =>
        assertIntentApproved(intent, token, {
          now: Date.parse(token.expiresAt) + 1,
        }),
      (e: TwzrdIntentBindingError) => e.code === "DECISION_EXPIRED",
    );

    const otherKey = createLocalDecisionSigner();
    assert.throws(
      () => assertIntentApproved(intent, token, { publicKeyPem: otherKey.publicKeyPem }),
      (e: TwzrdIntentBindingError) => e.code === "BAD_SIGNATURE",
    );
  }

  /* 4. Policy runtime: the five concrete policies */
  {
    const signer = createLocalDecisionSigner();

    // wash-flagged counterparties blocked (signed block, not an exception)
    const washed = await evaluateIntent(baseIntent(), {
      signer,
      intelligence: () => ({ washFlagged: true }),
    });
    assert.equal(washed.decision, "block");
    assert.ok(washed.reasonCodes.includes("WASH_FLAGGED"));
    assert.throws(
      () => assertIntentApproved(baseIntent(), washed),
      (e: TwzrdIntentBindingError) => e.code === "DECISION_NOT_ALLOW",
    );

    // unknown merchant: allow <= $0.10, block above
    const policy = { unknownCounterparty: { allowUnderUsd: "0.10" } };
    const small = await evaluateIntent(baseIntent({ amount: "0.10" }), {
      signer,
      policy,
      intelligence: () => ({ known: false }),
    });
    assert.equal(small.decision, "warn");
    const big = await evaluateIntent(baseIntent({ amount: "0.11" }), {
      signer,
      policy,
      intelligence: () => ({ known: false }),
    });
    assert.equal(big.decision, "block");
    assert.ok(big.reasonCodes.includes("UNKNOWN_ABOVE_LIMIT"));

    // new counterparty: max $5 cumulative in 24h
    const ledger = createMemorySpendLedger();
    const capPolicy = { newCounterpartyCap: { capUsd: "5", windowHours: 24 } };
    const first = await evaluateIntent(baseIntent({ amount: "3" }), {
      signer,
      policy: capPolicy,
      ledger,
    });
    assert.equal(first.decision, "allow");
    const second = await evaluateIntent(baseIntent({ amount: "3" }), {
      signer,
      policy: capPolicy,
      ledger,
    });
    assert.equal(second.decision, "block");
    assert.ok(second.reasonCodes.includes("NEW_COUNTERPARTY_CAP"));

    // recurring service: block price increase > 20%
    const recurring = await evaluateIntent(
      baseIntent({ amount: "13", context: { purpose: "software", recurring: true, priorSpend: "10" } }),
      { signer, policy: { recurringMaxPriceIncreasePct: 20 } },
    );
    assert.equal(recurring.decision, "block");
    assert.ok(recurring.reasonCodes.includes("RECURRING_PRICE_INCREASE"));

    // mandate resource binding: approval scope /weather cannot pay /admin/export
    const scoped = await evaluateIntent(
      baseIntent({ resource: { url: "https://api.example/admin/export" } }),
      {
        signer,
        mandate: {
          mandateId: "m2",
          resourceAllow: ["https://api.example/weather"],
        },
      },
    );
    assert.equal(scoped.decision, "block");
    assert.ok(scoped.reasonCodes.includes("MANDATE_RESOURCE_SCOPE"));

    // mandate monthly ceiling
    const ledger2 = createMemorySpendLedger();
    const m = { mandateId: "m3", monthlyCeilingUsd: "500" };
    await evaluateIntent(baseIntent({ amount: "499" }), { signer, mandate: m, ledger: ledger2 });
    const over = await evaluateIntent(baseIntent({ amount: "2" }), {
      signer,
      mandate: m,
      ledger: ledger2,
    });
    assert.equal(over.decision, "block");
    assert.ok(over.reasonCodes.includes("MANDATE_MONTHLY_CEILING"));
  }

  /* 5. Adapters */
  {
    // x402 (v2 field names)
    const intent = x402RequirementsToIntent(
      {
        payTo: MERCHANT,
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "50000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      { resourceUrl: "https://merchant.example/paid", method: "GET" },
    );
    assert.equal(intent.protocol, "x402");
    assert.equal(intent.payTo, MERCHANT);
    assert.equal(intent.resource?.url, "https://merchant.example/paid");
    // x402 wire amount is USDC micro units → decimal USD (50000 micro = 0.05).
    assert.equal(intent.amount, "0.05");

    // v1 field names normalize identically
    const v1 = x402RequirementsToIntent({
      pay_to: MERCHANT,
      network: "solana",
      maxAmountRequired: "50000",
      asset: "USDC",
    });
    assert.equal(v1.amount, "0.05");
    assert.equal(v1.payTo, MERCHANT);

    // AP2 reference: mandate + cart -> intent + normalized mandate
    const signer = createLocalDecisionSigner();
    const { intent: ap2Intent, mandate } = ap2CheckoutToIntent(
      {
        merchantId: "acme-saas",
        payTo: "acct_acme",
        currency: "USD",
        total: "12.00",
        checkoutUrl: "https://store.example/checkout/pro-plan",
        category: "software",
      },
      {
        mandateId: "user-mandate-1",
        categories: ["software"],
        maxPerTransaction: "100",
        merchantAllowPrefixes: ["https://store.example/checkout/"],
      },
    );
    assert.equal(ap2Intent.protocol, "ap2");
    assert.equal(ap2Intent.agent?.mandateId, "user-mandate-1");
    const decision = await evaluateIntent(ap2Intent, { signer, mandate });
    assert.equal(decision.decision, "allow");

    // same cart outside mandate category -> signed block
    const { intent: badIntent, mandate: m2 } = ap2CheckoutToIntent(
      {
        merchantId: "acme-saas",
        payTo: "acct_acme",
        currency: "USD",
        total: "12.00",
        checkoutUrl: "https://store.example/checkout/pro-plan",
        category: "gambling",
      },
      { mandateId: "user-mandate-1", categories: ["software"] },
    );
    const blocked = await evaluateIntent(badIntent, { signer, mandate: m2 });
    assert.equal(blocked.decision, "block");
    assert.ok(blocked.reasonCodes.includes("MANDATE_PURPOSE"));
  }

  /* 6. Stripe-shaped x402 on Base: a fresh deposit address per PaymentIntent is a
   * settlement destination, not merchant identity; resource.url is a stable
   * merchant locator, not verified identity. Claim: TWZRD's intent model can
   * bind Stripe-shaped Base x402 requirements, including rotating deposit
   * addresses, while leaving merchant reputation unknown.
   */
  {
    const DEPOSIT_A = "0xa11ce00000000000000000000000000000000001";
    const DEPOSIT_B = "0xb0b0000000000000000000000000000000000002";
    const stripeIntent = (payTo: string): PaymentIntent =>
      x402RequirementsToIntent(
        {
          payTo,
          network: "eip155:8453",
          amount: "10000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
        {
          resourceUrl: "https://api.acme-tools.example/paid/report",
          method: "GET",
          // Caller-supplied label bound into the hash — not discovered/attested.
          facilitator: "https://facilitator.stripe-sample.example",
        },
      );

    // Rotating payTo under the same merchant locator → distinct payment identities.
    const intentA = stripeIntent(DEPOSIT_A);
    const intentB = stripeIntent(DEPOSIT_B);
    assert.equal(intentA.resource?.url, intentB.resource?.url, "merchant locator is stable");
    assert.notEqual(intentHash(intentA), intentHash(intentB), "deposit address rotates the hash");

    // Post-approval deposit-address swap refuses before the signer runs.
    const signer = createLocalDecisionSigner({ keyId: "stripe-x402-fixture" });
    const registry = createDecisionRegistry();
    const token = await evaluateIntent(intentA, { signer });
    assert.equal(token.decision, "allow");
    let signerInvocationCount = 0;
    assert.throws(
      () => {
        assertIntentApproved({ ...intentA, payTo: DEPOSIT_B }, token, {
          registry,
          publicKeyPem: signer.publicKeyPem,
        });
        signerInvocationCount += 1;
      },
      (e: TwzrdIntentBindingError) => e.code === "INTENT_HASH_MISMATCH",
    );
    assert.equal(signerInvocationCount, 0, "signer never ran on the swapped intent");
    assertIntentApproved(intentA, token, { registry, publicKeyPem: signer.publicKeyPem });

    // Base stays recognized-but-unscored: reputation remains unknown here.
    const cls = classifyNetwork(intentA.network, DEPOSIT_A);
    assert.equal(cls.reputationScored, false);
    assert.equal(cls.reason, "network_not_scored");
  }

  console.log("payment-control.test.ts: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
