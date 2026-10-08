/**
 * Clearance SKU — requirePaymentDecision on the before-payment hook.
 * Run: npx tsx --test test/clearance.test.ts
 *
 * Locks issue #99: signer is not reached without an unexpired allow/warn
 * payment_decision.v1 for this challenge_hash. Free refuse stays free.
 * quickCheck is not this SKU.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createSeededDecisionSigner } from "../src/decision-token.js";
import {
  CLEARANCE_SKU_USDC,
  evaluateClearanceSku,
  resolveRequirePaymentDecisionPolicy,
} from "../src/clearance.js";
import { issuePaymentDecisionRecord } from "../src/payment-decision.js";
import {
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";
import type { ResourceBindReq } from "../src/resource-bind.js";

const VECTOR_SECRET = createHash("sha256")
  .update("twzrd.payment_decision.v1 test vectors — NOT A DEPLOYMENT KEY")
  .digest("hex");
const signer = createSeededDecisionSigner(VECTOR_SECRET, "twzrd-pd-v1-vectors");
const PEM = signer.publicKeyPem;
const NOW = Date.parse("2026-09-20T00:00:00.000Z");
const EXPIRES = "2030-01-01T00:00:00.000Z";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const CHALLENGE = {
  scheme: "exact",
  network: "solana",
  payTo: SELLER,
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "20000",
  resource: "https://deskcrew.example/api/x402/paid/ping",
} satisfies ResourceBindReq;

function mockClient() {
  let hook:
    | ((ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>)
    | undefined;
  const client: X402ClientLike = {
    onBeforePaymentCreation(h) {
      hook = h;
      return client;
    },
  };
  return {
    client,
    async fire(ctx: BeforePaymentCreationContext) {
      if (!hook) throw new Error("hook not installed");
      return hook(ctx);
    },
  };
}

const allowPreflight = (async () =>
  new Response(
    JSON.stringify({
      readiness_card: {
        decision: "allow",
        can_spend: true,
        trust_score: 90,
        seller_wallet: SELLER,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

const blockPreflight = (async () =>
  new Response(
    JSON.stringify({
      readiness_card: {
        decision: "block",
        can_spend: false,
        trust_score: 5,
        seller_wallet: SELLER,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

async function run() {
  assert.equal(CLEARANCE_SKU_USDC, 0.001);
  assert.equal(resolveRequirePaymentDecisionPolicy(undefined), null);
  assert.equal(resolveRequirePaymentDecisionPolicy(false), null);
  assert.deepEqual(resolveRequirePaymentDecisionPolicy(true), { hard: true });

  const allowRec = await issuePaymentDecisionRecord(
    {
      challenge: CHALLENGE,
      decision: "allow",
      reason_code: "ALLOW",
      evidence_id: "clearance-allow-1",
      expires_at: EXPIRES,
    },
    signer,
  );
  const blockRec = await issuePaymentDecisionRecord(
    {
      challenge: CHALLENGE,
      decision: "block",
      reason_code: "INTEL_BLOCK",
      evidence_id: "clearance-block-1",
      expires_at: EXPIRES,
    },
    signer,
  );
  const warnRec = await issuePaymentDecisionRecord(
    {
      challenge: CHALLENGE,
      decision: "warn",
      reason_code: "INTEL_WARN",
      evidence_id: "clearance-warn-1",
      expires_at: EXPIRES,
    },
    signer,
  );
  const expiredRec = await issuePaymentDecisionRecord(
    {
      challenge: CHALLENGE,
      decision: "allow",
      reason_code: "ALLOW",
      evidence_id: "clearance-expired-1",
      expires_at: "2026-01-01T00:00:00.000Z",
    },
    signer,
  );
  const otherChallenge = { ...CHALLENGE, amount: "999000000" };
  const otherRec = await issuePaymentDecisionRecord(
    {
      challenge: otherChallenge,
      decision: "allow",
      reason_code: "ALLOW",
      evidence_id: "clearance-other-1",
      expires_at: EXPIRES,
    },
    signer,
  );

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true, record: allowRec, publicKeyPem: PEM },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.cleared, true);
    assert.equal(r.denied, undefined);
    assert.equal(r.verification?.decision, "allow");
  }

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true, record: warnRec, publicKeyPem: PEM },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.cleared, true, "warn unlocks the signer, same as allow");
  }

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true, record: blockRec, publicKeyPem: PEM },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.cleared, false);
    assert.match(r.reason, /clearance_decision_block/);
  }

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true, record: expiredRec, publicKeyPem: PEM },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.cleared, false);
    assert.match(r.reason, /expired/);
  }

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true, record: otherRec, publicKeyPem: PEM },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.cleared, false);
    assert.match(r.reason, /challenge_hash_mismatch/);
  }

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.cleared, false);
    assert.equal(r.reason, "clearance_required_missing_record");
  }

  {
    const r = await evaluateClearanceSku({
      policy: { hard: true, record: allowRec },
      challenge: CHALLENGE,
      now: NOW,
    });
    assert.equal(r.reason, "clearance_required_missing_verifier_key");
  }

  {
    let issuerCalls = 0;
    const x402Fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      issuerCalls += 1;
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ twzrd_payment_decision: allowRec }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const r = await evaluateClearanceSku({
      policy: {
        hard: true,
        issuerUrl: "https://issuer.example/v1/intel/payment-decision",
        publicKeyPem: PEM,
      },
      challenge: CHALLENGE,
      x402Fetch,
      now: NOW,
    });
    assert.equal(issuerCalls, 1);
    assert.equal(r.cleared, true);
    assert.equal(r.paid, true);
  }

  {
    let issuerCalls = 0;
    const x402Fetch = (async () => {
      issuerCalls += 1;
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const r = await evaluateClearanceSku({
      policy: {
        hard: true,
        issuerUrl: "https://intel.twzrd.xyz/v1/intel/payment-decision",
        publicKeyPem: PEM,
      },
      challenge: CHALLENGE,
      x402Fetch,
      now: NOW,
    });
    assert.equal(issuerCalls, 1);
    assert.equal(r.cleared, false);
    assert.match(r.reason, /clearance_issuer_http_404/);
  }

  // Hook: missing record aborts before sign. Policy allow is not enough.
  {
    const { client, fire } = mockClient();
    let last: { approved?: boolean; clearanceDenied?: boolean } | undefined;
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: allowPreflight,
      requirePaymentDecision: { publicKeyPem: PEM },
      now: () => NOW,
      onDecision: (d) => {
        last = d;
      },
    });
    const result = await fire({ selectedRequirements: CHALLENGE });
    assert.ok(result && "abort" in result && result.abort === true);
    assert.match(String((result as { reason: string }).reason), /clearance_required_missing_record/);
    assert.equal(last?.approved, false);
    assert.equal(last?.clearanceDenied, true);
  }

  // Hook: verified allow for this hash proceeds.
  {
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: allowPreflight,
      requirePaymentDecision: { record: allowRec, publicKeyPem: PEM },
      now: () => NOW,
    });
    const result = await fire({ selectedRequirements: CHALLENGE });
    assert.ok(result === undefined || result === null || !("abort" in result && result.abort));
  }

  // Hook: policy block never buys clearance (the save is free).
  {
    let issuerCalls = 0;
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: blockPreflight,
      requirePaymentDecision: {
        issuerUrl: "https://issuer.example/v1/intel/payment-decision",
        publicKeyPem: PEM,
      },
      x402Fetch: (async () => {
        issuerCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      now: () => NOW,
    });
    const result = await fire({ selectedRequirements: CHALLENGE });
    assert.ok(result && "abort" in result && result.abort === true);
    assert.equal(issuerCalls, 0, "do not x402 a block");
  }

  // Hook unset: policy allow still proceeds (AutoGate default unchanged).
  {
    const { client, fire } = mockClient();
    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: allowPreflight,
    });
    const result = await fire({ selectedRequirements: CHALLENGE });
    assert.ok(result === undefined || result === null || !("abort" in result && result.abort));
  }

  console.log("clearance.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("clearance.test.ts FAILED:", e);
  process.exit(1);
});
