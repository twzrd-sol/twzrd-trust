/**
 * An approval covers one payment: the requirement the pre-sign checks saw.
 *
 * @x402/core lets a scheme answer a failed payment creation with a "recovered"
 * payload and returns it without running the pre-sign hooks again. A scheme
 * may build that payload for a different accepts[] entry. The paying wrappers
 * used to mark the whole attempt approved, so the swapped payment (another
 * recipient, another amount) was sent under the first entry's approval.
 *
 * The `batch-settlement` scheme is the published case: its client falls back
 * to another accepts[] entry when it refuses a server-signed channel, and it
 * escrows a deposit sized by `extra.minDeposit` or a multiple of `amount`,
 * which no cap on `amount` bounds. The scheme is refused outright; the swap
 * itself is replayed here with the real x402 client and an `exact` scheme
 * that recovers the same way, so the binding is tested for any scheme.
 *
 * Run: npx tsx --test test/payment-binding.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";

import { BuyerFetchBlockedError, createBuyerFetch } from "../src/buyer-fetch.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";
import { x402RequirementsToIntent } from "../src/intent-adapters.js";
import {
  PAYMENT_DIFFERS_FROM_APPROVAL,
  PAYMENT_PAYLOAD_UNREADABLE,
  approvedRequirementOf,
  paymentBindingRefusal,
} from "../src/payment-binding.js";
import { BATCH_SETTLEMENT_REFUSED, isBatchSettlement, resolveRequirementFields } from "../src/payto.js";
import { createTwzrdPolicyFetch } from "../src/policy-fetch.js";
import { spendControlSafeFetch } from "../src/spend-control.js";
import { evaluateWashOnlyBeforePayment } from "../src/wash-default.js";
import { createTwzrdBeforePaymentHook } from "../src/x402-client-hook.js";
import type { X402PaymentRequirements } from "../src/types.js";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const OTHER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const PAID_URL = "https://merchant.example/paid";

type Accept = PaymentRequired["accepts"][number];
const accept = (over: Partial<Accept> = {}): Accept => ({
  scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: SELLER,
  maxTimeoutSeconds: 60, extra: {}, ...over,
});

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const unb64 = (value: string): Record<string, unknown> => JSON.parse(Buffer.from(value, "base64").toString("utf8"));

type Recovery = "none" | "scheme" | "manual";

/**
 * A real x402 client whose `exact` scheme refuses the first accepts[] entry
 * and, when asked to recover, signs `swapTo` instead. `scheme` recovery is the
 * scheme's own hook (as a batch client's fallback is); `manual` is a
 * client-level hook registered before the guard, so it runs before the
 * guard's own failure hook.
 */
function harness(options: { recovery: Recovery; swapTo?: Accept; accepts?: Accept[] }) {
  const accepts = options.accepts ?? [accept(), accept({ payTo: OTHER, amount: "1000" })];
  const swapTo = options.swapTo ?? accepts[1];
  const state = { signs: 0, recoveries: 0, paid: [] as Array<Record<string, unknown>>, preflights: 0 };
  const client = new x402Client();
  client.setSpendControls(false);
  const recovered = (ctx: { paymentRequired: PaymentRequired }) => {
    state.signs++;
    state.recoveries++;
    return {
      recovered: true as const,
      payload: { x402Version: 2, payload: { signedFor: swapTo.payTo }, accepted: swapTo, resource: ctx.paymentRequired.resource },
    };
  };
  const scheme = {
    scheme: "exact",
    async createPaymentPayload(version: number, requirements: Accept) {
      if (options.recovery !== "none") throw new Error("scheme refused the selected entry");
      state.signs++;
      return { x402Version: version, payload: { signedFor: requirements.payTo } };
    },
    ...(options.recovery === "scheme" ? { schemeHooks: { onPaymentCreationFailure: async (ctx: never) => recovered(ctx) } } : {}),
  } as unknown as SchemeNetworkClient;
  client.register(NETWORK, scheme);
  if (options.recovery === "manual") client.onPaymentCreationFailure((async (ctx: never) => recovered(ctx)) as never);

  const payment: PaymentRequired = { x402Version: 2, resource: { url: PAID_URL }, accepts } as PaymentRequired;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("/v1/intel/preflight")) {
      state.preflights++;
      return Response.json({ readiness_card: { decision: "allow", trust_score: 90, seller_wallet: SELLER, recommended_cap_usdc: 1 } });
    }
    if (request.url.includes("/v1/intel/merchant_card/")) return Response.json({ wash_flagged: false, wash_confidence: "full" });
    if (request.url !== PAID_URL) throw new Error(`unexpected request ${request.url}`);
    const header = request.headers.get("payment-signature");
    if (header !== null) {
      state.paid.push(unb64(header));
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 402, headers: { "payment-required": b64(payment) } });
  };
  return { state, client, transport };
}

function buyer(h: ReturnType<typeof harness>) {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-binding-test-"));
  const decisionFile = join(dir, "decisions.jsonl");
  const fetchPaid = createBuyerFetch({
    client: h.client, maxPricePerCall: "0.01", allowedRecipients: [SELLER],
    decisionFile, spendLedgerFile: join(dir, "spend.jsonl"), intelTimeoutMs: 200, fetch: h.transport,
  });
  const rows = () => readFileSync(decisionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { fetchPaid, rows };
}

function guarded(h: ReturnType<typeof harness>) {
  return createGuardedX402Fetch({
    client: h.client, fetch: h.transport, maxPricePerCall: "0.01", hourlyBudgetCap: "0.05",
    allowedRecipients: [SELLER], twzrd: { disabled: true },
  });
}

const paidTo = (payload: Record<string, unknown>): unknown => (payload.accepted as Record<string, unknown> | undefined)?.payTo;

test("control: an ordinary payment is sent, and names the approved entry", async () => {
  const forBuyer = harness({ recovery: "none" });
  assert.equal((await buyer(forBuyer).fetchPaid(PAID_URL)).status, 200);
  assert.deepEqual(forBuyer.state.paid.map(paidTo), [SELLER]);

  const forGuard = harness({ recovery: "none" });
  assert.equal((await guarded(forGuard)(PAID_URL)).status, 200);
  assert.deepEqual(forGuard.state.paid.map(paidTo), [SELLER]);
});

test("buyer fetch: a scheme's recovery cannot pay another accepts[] entry", async () => {
  const h = harness({ recovery: "scheme" });
  const { fetchPaid } = buyer(h);
  await assert.rejects(() => fetchPaid(PAID_URL));
  assert.deepEqual(h.state.paid, [], "no payment left for the entry that was never approved");
  assert.equal(h.state.recoveries, 0, "the scheme's recovery did not run, so nothing was signed");
});

test("guarded fetch: a scheme's recovery cannot pay another accepts[] entry", async () => {
  const h = harness({ recovery: "scheme" });
  await assert.rejects(() => guarded(h)(PAID_URL));
  assert.deepEqual(h.state.paid, []);
  assert.equal(h.state.recoveries, 0);
});

test("buyer fetch: a recovered payload for another recipient is refused before it is sent", async () => {
  // The recovery hook was registered before the guard, so it runs first and returns its payload.
  const h = harness({ recovery: "manual" });
  const { fetchPaid, rows } = buyer(h);
  await assert.rejects(() => fetchPaid(PAID_URL), (error: unknown) => {
    assert.ok(error instanceof BuyerFetchBlockedError, String(error));
    assert.equal(error.reason, PAYMENT_DIFFERS_FROM_APPROVAL);
    return true;
  });
  assert.equal(h.state.recoveries, 1, "the earlier hook did produce a payload");
  assert.deepEqual(h.state.paid, [], "and it never reached the seller");
  const last = rows().at(-1);
  assert.equal(last.outcome, "block");
  assert.deepEqual(last.reason_codes, [PAYMENT_DIFFERS_FROM_APPROVAL]);
});

test("guarded fetch: a recovered payload for another recipient or amount is refused before it is sent", async () => {
  const recipient = harness({ recovery: "manual" });
  await assert.rejects(() => guarded(recipient)(PAID_URL), new RegExp(PAYMENT_DIFFERS_FROM_APPROVAL));
  assert.deepEqual(recipient.state.paid, []);

  // Same recipient, a thousand times the approved amount.
  const amount = harness({ recovery: "manual", swapTo: accept({ amount: "1000000" }) });
  await assert.rejects(() => guarded(amount)(PAID_URL), new RegExp(PAYMENT_DIFFERS_FROM_APPROVAL));
  assert.deepEqual(amount.state.paid, []);

  // A different asset or network on the same recipient and amount.
  const asset = harness({ recovery: "manual", swapTo: accept({ asset: "So11111111111111111111111111111111111111112" }) });
  await assert.rejects(() => guarded(asset)(PAID_URL), new RegExp(PAYMENT_DIFFERS_FROM_APPROVAL));
  assert.deepEqual(asset.state.paid, []);
});

test("a recovered payload for the approved entry itself still goes out", async () => {
  // The binding is to the requirement, not to how the payload was built.
  const first = accept();
  const forBuyer = harness({ recovery: "manual", accepts: [first], swapTo: first });
  assert.equal((await buyer(forBuyer).fetchPaid(PAID_URL)).status, 200);
  assert.deepEqual(forBuyer.state.paid.map(paidTo), [SELLER]);

  const forGuard = harness({ recovery: "manual", accepts: [first], swapTo: first });
  assert.equal((await guarded(forGuard)(PAID_URL)).status, 200);
  assert.deepEqual(forGuard.state.paid.map(paidTo), [SELLER]);
});

test("paymentBindingRefusal compares every approved field", () => {
  const approved = approvedRequirementOf(accept());
  const header = (over: Record<string, unknown>) => b64({ x402Version: 2, payload: {}, accepted: accept(), ...over });
  assert.equal(paymentBindingRefusal(approved, header({})), undefined);
  for (const [label, change] of [
    ["recipient", { payTo: OTHER }],
    ["amount", { amount: "1001" }],
    ["lower amount", { amount: "999" }],
    ["asset", { asset: "So11111111111111111111111111111111111111112" }],
    ["network", { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }],
    ["scheme", { scheme: "upto" }],
    ["a second recipient field", { pay_to: OTHER }],
    ["array recipient", { payTo: [SELLER] }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(
      paymentBindingRefusal(approved, header({ accepted: { ...accept(), ...change } })),
      PAYMENT_DIFFERS_FROM_APPROVAL,
      label,
    );
  }
  assert.equal(paymentBindingRefusal(approved, header({ accepted: undefined })), PAYMENT_DIFFERS_FROM_APPROVAL, "v2 with no accepted");
  assert.equal(paymentBindingRefusal(approved, header({ accepted: [accept()] })), PAYMENT_DIFFERS_FROM_APPROVAL, "array accepted");
  assert.equal(paymentBindingRefusal(approved, "not base64 json"), PAYMENT_PAYLOAD_UNREADABLE);
  assert.equal(paymentBindingRefusal(approved, b64(["x"])), PAYMENT_PAYLOAD_UNREADABLE);

  // v1 payloads carry scheme and network only.
  const v1 = (over: Record<string, unknown>) => b64({ x402Version: 1, scheme: "exact", network: NETWORK, payload: {}, ...over });
  assert.equal(paymentBindingRefusal(approved, v1({})), undefined);
  assert.equal(paymentBindingRefusal(approved, v1({ network: "base" })), PAYMENT_DIFFERS_FROM_APPROVAL);
  assert.equal(paymentBindingRefusal(approved, v1({ scheme: "batch-settlement" })), PAYMENT_DIFFERS_FROM_APPROVAL);

  // EVM addresses differ only by checksum case.
  const evm = { scheme: "exact", network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000" };
  const lower = { ...evm, payTo: evm.payTo.toLowerCase(), asset: evm.asset.toLowerCase() };
  assert.equal(paymentBindingRefusal(approvedRequirementOf(evm), b64({ x402Version: 2, payload: {}, accepted: lower })), undefined);
});

// ---------------------------------------------------------------------------
// batch-settlement: the deposit is not the amount, so the scheme is refused.
// ---------------------------------------------------------------------------

const BATCH = { scheme: "batch-settlement", network: NETWORK, asset: USDC, amount: "1000", payTo: SELLER,
  maxTimeoutSeconds: 60, extra: { minDeposit: "1000000" } };

const allowIntel = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? Response.json({ wash_flagged: false, wash_confidence: "full" })
    : Response.json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } })) as unknown as typeof fetch;

test("the reader refuses batch-settlement, however the scheme is spelled", () => {
  assert.equal(resolveRequirementFields(BATCH).conflict, BATCH_SETTLEMENT_REFUSED);
  assert.equal(resolveRequirementFields({ ...BATCH, extra: {} }).conflict, BATCH_SETTLEMENT_REFUSED, "no minDeposit: the deposit is still a multiple");
  assert.equal(resolveRequirementFields({ ...BATCH, scheme: " Batch-Settlement " }).conflict, BATCH_SETTLEMENT_REFUSED);
  assert.equal(resolveRequirementFields({ ...BATCH, scheme: ["batch-settlement"] }).conflict, BATCH_SETTLEMENT_REFUSED);
  assert.equal(isBatchSettlement({ ...BATCH, scheme: "exact" }), false);
  assert.equal(resolveRequirementFields({ ...BATCH, scheme: "exact" }).conflict, undefined);
  assert.equal(resolveRequirementFields({ ...BATCH, scheme: undefined }).conflict, undefined);
  assert.equal(resolveRequirementFields({ ...BATCH, scheme: "upto" }).conflict, undefined);
});

test("every capped seat refuses a batch-settlement offer before intel and before the payer", async () => {
  // twzrd.safeFetch with maxSpend: the 0.001 USDC amount is under the 0.01 cap; the deposit is 1 USDC.
  let paid = 0;
  const safe = await spendControlSafeFetch(PAID_URL, {
    fetch: (async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{ ...BATCH, resource: PAID_URL }] }), { status: 402 })) as unknown as typeof fetch,
    maxSpend: "0.01",
    pay: async () => { paid += 1; return {}; },
  });
  assert.equal(safe.verdict, "block");
  assert.equal(safe.reason, BATCH_SETTLEMENT_REFUSED);
  assert.equal(safe.signerInvocations, 0);
  assert.equal(paid, 0);

  // createTwzrdPolicyFetch with maxAmountUsd and no allowlist.
  let handedToPayer = 0;
  const policyFetch = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner(),
    fetch: allowIntel,
    rawFetch: (async () => new Response(JSON.stringify({ accepts: [BATCH] }), { status: 402, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    wrapPay: (gated) => async (input, init) => {
      const r = await gated(input, init);
      if (r.status === 402) handedToPayer += 1;
      return r.status === 402 ? new Response("paid", { status: 200 }) : r;
    },
    policy: { maxAmountUsd: "0.01" },
  });
  await assert.rejects(() => policyFetch(PAID_URL));
  assert.equal(handedToPayer, 0, "the payer never saw the batch-settlement offer");

  // The pre-sign hooks.
  let intelCalls = 0;
  const countingIntel = (async (url: unknown) => { intelCalls += 1; return allowIntel(url as never); }) as unknown as typeof fetch;
  const hook = await createTwzrdBeforePaymentHook({ fetch: countingIntel })({ ...BATCH, resource: PAID_URL });
  assert.equal(Boolean(hook && hook.abort), true);
  assert.match(String(hook && hook.reason), new RegExp(BATCH_SETTLEMENT_REFUSED));
  const wash = await evaluateWashOnlyBeforePayment(BATCH, { fetch: countingIntel });
  assert.equal(Boolean(wash && wash.abort), true);
  assert.match(String(wash && wash.reason), new RegExp(BATCH_SETTLEMENT_REFUSED));
  assert.equal(intelCalls, 0, "refused before intel");

  const evaluated = await evaluate_x402_resource(PAID_URL, { ...BATCH, resource: PAID_URL } as unknown as X402PaymentRequirements, { fetch: countingIntel });
  assert.equal(evaluated.approved, false);
  assert.equal(evaluated.reason, BATCH_SETTLEMENT_REFUSED);
  assert.throws(() => x402RequirementsToIntent(BATCH, { resourceUrl: PAID_URL }), new RegExp(BATCH_SETTLEMENT_REFUSED));
});

test("the paying wrappers refuse a batch-settlement entry before the scheme runs", async () => {
  const build = () => {
    const state = { signs: 0, paid: 0, preflights: 0 };
    const client = new x402Client();
    client.setSpendControls(false);
    client.register(NETWORK, {
      scheme: "batch-settlement",
      async createPaymentPayload(version: number) {
        state.signs++;
        return { x402Version: version, payload: { type: "deposit", deposit: { amount: "1000000" } } };
      },
    } as unknown as SchemeNetworkClient);
    const payment = { x402Version: 2, resource: { url: PAID_URL }, accepts: [BATCH] };
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/v1/intel/")) { state.preflights++; return Response.json({ readiness_card: { decision: "allow", trust_score: 90 } }); }
      if (request.headers.has("payment-signature")) { state.paid++; return Response.json({ ok: true }); }
      return new Response(null, { status: 402, headers: { "payment-required": b64(payment) } });
    };
    return { state, client, transport };
  };

  const forBuyer = build();
  const dir = mkdtempSync(join(tmpdir(), "twzrd-binding-test-"));
  const fetchPaid = createBuyerFetch({
    client: forBuyer.client, maxPricePerCall: "0.01", allowedRecipients: [SELLER],
    decisionFile: join(dir, "decisions.jsonl"), spendLedgerFile: join(dir, "spend.jsonl"),
    intelTimeoutMs: 200, fetch: forBuyer.transport,
  });
  await assert.rejects(() => fetchPaid(PAID_URL), (error: unknown) => {
    assert.ok(error instanceof BuyerFetchBlockedError, String(error));
    assert.equal(error.reason, BATCH_SETTLEMENT_REFUSED);
    return true;
  });
  assert.deepEqual(forBuyer.state, { signs: 0, paid: 0, preflights: 0 });

  const forGuard = build();
  const guard = createGuardedX402Fetch({
    client: forGuard.client, fetch: forGuard.transport, maxPricePerCall: "0.01", hourlyBudgetCap: "0.05",
    allowedRecipients: [SELLER], twzrd: { disabled: true },
  });
  await assert.rejects(() => guard(PAID_URL), new RegExp(BATCH_SETTLEMENT_REFUSED));
  assert.deepEqual(forGuard.state, { signs: 0, paid: 0, preflights: 0 });
});
