/**
 * Schemes the gate refuses because their payment is not "amount to payTo".
 *
 * - `auth-capture` (EVM): the offer's `extra.feeRecipient` can take up to
 *   `extra.maxFeeBps` of the captured amount, and `extra.captureAuthorizer`
 *   decides when it is captured. The gate scores payTo only.
 * - `upto` on Solana: the x402 client opens a payment channel. The deposit is
 *   `amount`, the channel's payee is `extra.feePayer`, its signer is
 *   `extra.receiverAuthorizer`, and `extra.splits` names recipients.
 * `upto` on EVM stays allowed: it is a Permit2 authorization to payTo capped at `amount`.
 *
 * Run: npx tsx --test test/scheme-refusals.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalDecisionSigner } from "../src/decision-token.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import {
  AUTH_CAPTURE_REFUSED, SVM_UPTO_REFUSED, isAuthCapture, isSvmUpto,
} from "../src/index.js";
import { x402RequirementsToIntent } from "../src/intent-adapters.js";
import { resolveRequirementFields } from "../src/payto.js";
import { createTwzrdPolicyFetch } from "../src/policy-fetch.js";
import { spendControlSafeFetch } from "../src/spend-control.js";
import { evaluateWashOnlyBeforePayment } from "../src/wash-default.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";
import type { X402PaymentRequirements } from "../src/types.js";

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL_OTHER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const BASE = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EVM_SELLER = "0x1111111111111111111111111111111111111111";
const EVM_OTHER = "0x2222222222222222222222222222222222222222";
const PAID_URL = "https://merchant.example/paid";

/** An auth-capture offer whose fee recipient may take the whole payment. */
const AUTH_CAPTURE = {
  scheme: "auth-capture", network: BASE, asset: BASE_USDC, amount: "1000", payTo: EVM_SELLER, maxTimeoutSeconds: 60,
  extra: { feeRecipient: EVM_OTHER, maxFeeBps: 10000, captureAuthorizer: EVM_OTHER },
};
/** A Solana upto offer: a channel paid to feePayer, signed for by receiverAuthorizer. */
const SVM_UPTO = {
  scheme: "upto", network: SOLANA, asset: SOL_USDC, amount: "1000", payTo: SOL_SELLER, maxTimeoutSeconds: 60,
  extra: { feePayer: SOL_OTHER, receiverAuthorizer: SOL_OTHER, withdrawDelay: 1 },
};
const EVM_UPTO = { scheme: "upto", network: BASE, asset: BASE_USDC, amount: "1000", payTo: EVM_SELLER, maxTimeoutSeconds: 60 };

const allowIntel = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? Response.json({ wash_flagged: false, wash_confidence: "full" })
    : Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } })) as unknown as typeof fetch;

test("the reader refuses auth-capture, however the scheme is spelled and whatever extra says", () => {
  assert.equal(resolveRequirementFields(AUTH_CAPTURE).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, extra: {} }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, extra: undefined }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, scheme: " Auth-Capture " }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, scheme: ["auth-capture"] }).conflict, AUTH_CAPTURE_REFUSED);
  // The name is refused on any network: no client the gate knows pays it as amount-to-payTo.
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, network: SOLANA, payTo: SOL_SELLER, asset: SOL_USDC }).conflict, AUTH_CAPTURE_REFUSED);
  assert.equal(isAuthCapture({ ...AUTH_CAPTURE, scheme: "exact" }), false);
  assert.equal(isAuthCapture(null), false);
  assert.equal(resolveRequirementFields({ ...AUTH_CAPTURE, scheme: "exact" }).conflict, undefined);
});

test("the reader refuses upto on Solana, on every way the gate recognises Solana", () => {
  assert.equal(resolveRequirementFields(SVM_UPTO).conflict, SVM_UPTO_REFUSED);
  assert.equal(resolveRequirementFields({ ...SVM_UPTO, extra: {} }).conflict, SVM_UPTO_REFUSED);
  assert.equal(resolveRequirementFields({ ...SVM_UPTO, scheme: " Upto " }).conflict, SVM_UPTO_REFUSED);
  assert.equal(resolveRequirementFields({ ...SVM_UPTO, scheme: ["upto"] }).conflict, SVM_UPTO_REFUSED);
  for (const network of ["solana", "solana-devnet", "mainnet-beta", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]) {
    assert.equal(resolveRequirementFields({ ...SVM_UPTO, network }).conflict, SVM_UPTO_REFUSED, network);
  }
  // No network and a base58 recipient is read as Solana, as the splits check reads it.
  assert.equal(resolveRequirementFields({ ...SVM_UPTO, network: undefined }).conflict, SVM_UPTO_REFUSED);
  assert.equal(resolveRequirementFields({ ...SVM_UPTO, network: undefined, payTo: undefined, pay_to: SOL_SELLER }).conflict, SVM_UPTO_REFUSED);
  assert.equal(isSvmUpto({ ...SVM_UPTO, scheme: "exact" }), false);
  assert.equal(isSvmUpto(null), false);
  assert.equal(resolveRequirementFields({ ...SVM_UPTO, scheme: "exact" }).conflict, undefined);
});

test("upto on an EVM network is still read as amount to payTo", () => {
  assert.equal(isSvmUpto(EVM_UPTO), false);
  const f = resolveRequirementFields(EVM_UPTO);
  assert.equal(f.conflict, undefined);
  assert.equal(f.payTo, EVM_SELLER);
  assert.equal(f.amount, "1000");
  assert.equal(resolveRequirementFields({ ...EVM_UPTO, network: undefined }).conflict, undefined, "no network and a 0x recipient is not Solana");
});

for (const [name, offer, code] of [
  ["auth-capture", AUTH_CAPTURE, AUTH_CAPTURE_REFUSED],
  ["Solana upto", SVM_UPTO, SVM_UPTO_REFUSED],
] as const) {
  test(`every seat refuses a ${name} offer before intel and before the payer`, async () => {
    let paid = 0;
    const safe = await spendControlSafeFetch(PAID_URL, {
      fetch: (async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{ ...offer, resource: PAID_URL }] }), { status: 402 })) as unknown as typeof fetch,
      maxSpend: "0.01",
      pay: async () => { paid += 1; return {}; },
    });
    assert.equal(safe.verdict, "block");
    assert.equal(safe.reason, code);
    assert.equal(safe.signerInvocations, 0);
    assert.equal(paid, 0);

    let handedToPayer = 0;
    const policyFetch = createTwzrdPolicyFetch({
      signer: createLocalDecisionSigner(),
      fetch: allowIntel,
      rawFetch: (async () => new Response(JSON.stringify({ accepts: [offer] }), { status: 402, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      wrapPay: (gated) => async (input, init) => {
        const r = await gated(input, init);
        if (r.status === 402) handedToPayer += 1;
        return r.status === 402 ? new Response("paid", { status: 200 }) : r;
      },
      policy: { maxAmountUsd: "0.01" },
    });
    await assert.rejects(() => policyFetch(PAID_URL));
    assert.equal(handedToPayer, 0, "the payer never saw the offer");

    let intelCalls = 0;
    const countingIntel = (async (url: unknown) => { intelCalls += 1; return allowIntel(url as never); }) as unknown as typeof fetch;
    const hook = await createTwzrdBeforePaymentHook({ fetch: countingIntel })({ ...offer, resource: PAID_URL });
    assert.equal(Boolean(hook && hook.abort), true);
    assert.match(String(hook && hook.reason), new RegExp(code));
    const wash = await evaluateWashOnlyBeforePayment(offer, { fetch: countingIntel });
    assert.equal(Boolean(wash && wash.abort), true);
    assert.match(String(wash && wash.reason), new RegExp(code));
    assert.equal(intelCalls, 0, "refused before intel");

    const evaluated = await evaluate_x402_resource(PAID_URL, { ...offer, resource: PAID_URL } as unknown as X402PaymentRequirements, { fetch: countingIntel });
    assert.equal(evaluated.approved, false);
    assert.equal(evaluated.reason, code);
    assert.throws(() => x402RequirementsToIntent(offer, { resourceUrl: PAID_URL }), new RegExp(code));
  });
}

test("an allowed exact offer beside a refused scheme does not rescue the refused one", async () => {
  // The policy fetch reads every offer the payer could pick: one refused entry stops the call.
  let handedToPayer = 0;
  const exact = { ...SVM_UPTO, scheme: "exact", extra: {} };
  const policyFetch = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner(),
    fetch: allowIntel,
    rawFetch: (async () => new Response(JSON.stringify({ accepts: [exact, SVM_UPTO] }), { status: 402, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    wrapPay: (gated) => async (input, init) => {
      const r = await gated(input, init);
      if (r.status === 402) handedToPayer += 1;
      return r.status === 402 ? new Response("paid", { status: 200 }) : r;
    },
    policy: { maxAmountUsd: "0.01" },
  });
  await assert.rejects(() => policyFetch(PAID_URL), new RegExp(SVM_UPTO_REFUSED));
  assert.equal(handedToPayer, 0);
});
