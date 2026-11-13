/**
 * A resource-scoped mandate is checked against the URL the buyer fetches.
 *
 * The intent's resource used to come from the seller's 402 (`accepts[].resource`)
 * ahead of the URL actually requested. A seller outside the mandate's scope only
 * had to name an in-scope URL in its 402 to be paid under the mandate.
 *
 * Run: npx tsx --test test/mandate-resource-scope.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalDecisionSigner, type PaymentDecision } from "../src/decision-token.js";
import { x402RequirementsToIntent } from "../src/intent-adapters.js";
import { createTwzrdPolicyFetch, TwzrdPolicyAbortError } from "../src/policy-fetch.js";
import {
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
} from "../src/x402-client-hook.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const ALLOWED = "https://allowed.example/paid";
const OUT_OF_SCOPE = "https://seller.example/paid";
const MANDATE = { mandateId: "m1", resourceAllow: [ALLOWED] };
const HOOK_SECRET = "c70a5f31e9b248d6ac1e05397fb82d4610c93e7a25bf40d81639ae52c807b4f9";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offer = (resource?: string) => ({ payTo: SELLER, amount: "10000", network: "solana", asset: USDC, ...(resource ? { resource } : {}) });

/** createTwzrdPolicyFetch against a seller whose 402 declares `declared` as its resource. */
function policyFetch(declared: string | undefined) {
  let paid = 0;
  const audits: PaymentDecision[] = [];
  const pay = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner({ keyId: "scope" }),
    fetch: (async () => json({ wash_flagged: false, wash_confidence: "full" })) as unknown as typeof fetch,
    rawFetch: (async () => json({ accepts: [offer(declared)] }, 402)) as unknown as typeof fetch,
    wrapPay: (gated) => async (input, init) => {
      const r = await gated(input, init);
      if (r.status !== 402) return r;
      paid += 1;
      return new Response("paid", { status: 200 });
    },
    policy: { maxAmountUsd: "1.00" },
    mandate: MANDATE,
    onAudit: (d: PaymentDecision) => audits.push(d),
  });
  return { pay, paid: () => paid, audits };
}

test("the adapter takes the caller's URL ahead of the requirement's own", () => {
  assert.equal(x402RequirementsToIntent(offer(ALLOWED), { resourceUrl: OUT_OF_SCOPE }).resource?.url, OUT_OF_SCOPE);
  // With no caller URL the requirement's field is used as given.
  assert.equal(x402RequirementsToIntent(offer(ALLOWED)).resource?.url, ALLOWED);
  assert.equal(x402RequirementsToIntent(offer(), { resourceUrl: OUT_OF_SCOPE }).resource?.url, OUT_OF_SCOPE);
});

test("policy fetch: a request outside the mandate's scope is refused whatever URL the 402 names", async () => {
  for (const declared of [undefined, "https://evil.example/paid", ALLOWED, `${ALLOWED}?x=1`]) {
    const rig = policyFetch(declared);
    await assert.rejects(
      () => rig.pay(OUT_OF_SCOPE),
      (e: unknown) => e instanceof TwzrdPolicyAbortError && e.decision.reasonCodes.includes("MANDATE_RESOURCE_SCOPE"),
      `402 declares ${declared}`,
    );
    assert.equal(rig.paid(), 0, `402 declares ${declared}: nothing is paid`);
  }
});

test("policy fetch: a request inside the scope is paid whatever URL the 402 names", async () => {
  for (const declared of [undefined, ALLOWED, "https://evil.example/paid"]) {
    const rig = policyFetch(declared);
    const resp = await rig.pay(ALLOWED);
    assert.equal(resp.status, 200, `402 declares ${declared}`);
    assert.equal(rig.paid(), 1);
    assert.equal(rig.audits.at(-1)?.decision, "allow");
  }
});

function hookRig(paymentControl: Record<string, unknown>) {
  let hook: ((ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>) | undefined;
  const client: X402ClientLike = {
    onBeforePaymentCreation(h) {
      hook = h;
      return client;
    },
  };
  const decisions: Array<{ approved: boolean; reason?: string; decision?: PaymentDecision }> = [];
  installTwzrdX402ClientHook(client, {
    paymentControl: { secret: HOOK_SECRET, ...paymentControl } as never,
    gateOnCanSpend: false,
    refuseWashFlagged: false,
    fetch: (async () => json({ readiness_card: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER } })) as unknown as typeof fetch,
    onDecision: (d) => decisions.push(d as never),
  });
  const fire = (declared: string | undefined) =>
    hook!({ selectedRequirements: { payTo: SELLER, network: SOL, amount: "10000", asset: USDC, ...(declared ? { resource: declared } : {}) } });
  return { fire, decisions };
}
const aborted = (r: BeforePaymentCreationResult) => Boolean(r && "abort" in r && r.abort);

test("hook: a resource-scoped mandate with no buyer URL is refused, not checked against the seller's", async () => {
  for (const declared of [ALLOWED, undefined]) {
    const rig = hookRig({ mandate: MANDATE });
    const result = await rig.fire(declared);
    assert.equal(aborted(result), true, `402 declares ${declared}`);
    assert.match(String(result && result.reason), /mandate_resource_unverifiable/);
    assert.equal(rig.decisions.at(-1)?.approved, false);
  }
  // A callback that throws or returns nothing is no URL.
  for (const requestUrl of [() => undefined, () => "", () => { throw new Error("no store"); }]) {
    const result = await hookRig({ mandate: MANDATE, requestUrl }).fire(ALLOWED);
    assert.match(String(result && result.reason), /mandate_resource_unverifiable/);
  }
});

test("hook: the scope is checked against the buyer's URL", async () => {
  const outside = hookRig({ mandate: MANDATE, requestUrl: () => OUT_OF_SCOPE });
  const refused = await outside.fire(ALLOWED);
  assert.equal(aborted(refused), true);
  assert.ok(outside.decisions.at(-1)?.decision?.reasonCodes.includes("MANDATE_RESOURCE_SCOPE"));

  const inside = hookRig({ mandate: MANDATE, requestUrl: () => ALLOWED });
  const allowed = await inside.fire("https://evil.example/paid");
  assert.equal(aborted(allowed), false, JSON.stringify(allowed));
  assert.equal(inside.decisions.at(-1)?.decision?.decision, "allow");
});

test("hook: a mandate with no resource scope needs no buyer URL", async () => {
  const rig = hookRig({ mandate: { mandateId: "m2", monthlyCeilingUsd: "5.00" } });
  assert.equal(aborted(await rig.fire(ALLOWED)), false);
  assert.equal(aborted(await hookRig({}).fire(undefined)), false);
});
