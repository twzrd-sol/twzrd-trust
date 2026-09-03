/**
 * AUDIT: Payment Control must be evaluated, or the payment must not proceed.
 *
 * evaluateBeforePaymentCreation used to skip the whole Payment Control block
 * when `amount`/`maxAmountRequired` was missing or empty: the guard read
 * `options.paymentControl && payTo && amountMicro`, so a falsy amount made the
 * block vanish. The legacy gate denies a missing payTo (policy.ts:148) but has
 * NO amount check, so a preflight `allow` fell through to the proceed path —
 * which emits onDecision({approved:true}) with intent/decision undefined,
 * byte-identical to "paymentControl was never configured". Every ceiling
 * (allowlist, maxAmountUsd, mandate, cumulative, newCounterparty) went
 * unevaluated straight to a signature.
 *
 * Fixed by aborting with `payment_control_unevaluable` whenever paymentControl
 * is configured and the payment cannot be evaluated (missing payTo or amount).
 *
 * Cases:
 *   2a  x402-client seat, amount undefined, allowlist []  -> abort, approved:false
 *   2b  x402-solana seat, amount "", maxAmountUsd "0"     -> abort, approved:false
 *   2c  CONTROL: no paymentControl + amount missing       -> still proceeds
 *       (the guard must not fire when Payment Control was never configured)
 *   2d  CONTROL: paymentControl + evaluable payment       -> still proceeds
 *       (the guard must not fire when the payment CAN be evaluated)
 *
 * Offline, deterministic. Run: npx tsx test/audit-paymentcontrol-unevaluable.test.ts
 */
import assert from "node:assert/strict";

import { installTwzrdAutoGate } from "../src/auto-gate.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import type {
  BeforePaymentCreationContext,
  BeforePaymentCreationResult,
  X402ClientLike,
} from "../src/x402-client-hook.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const allowIntel: typeof fetch = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? new Response("{}", { status: 404 })
    : new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } }), { status: 200 })
) as unknown as typeof fetch;

type Hook = (ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>;
type Decision = Record<string, unknown>;

function clientHarness() {
  const hooks: Hook[] = [];
  const client: X402ClientLike = {
    onBeforePaymentCreation(h: Hook) { hooks.push(h); return client; },
  } as X402ClientLike;
  return {
    client,
    fire: async (c: BeforePaymentCreationContext) => {
      for (const h of hooks) return await h(c);
      return undefined;
    },
  };
}

const ctx = (over: Record<string, unknown> = {}): BeforePaymentCreationContext => ({
  selectedRequirements: { payTo: SELLER, network: SOL, amount: "1000", resource: "https://m.example/p", ...over },
});

async function run() {
  // 2a. x402-client seat: Payment Control configured, amount undefined.
  // The empty allowlist makes the failure loud in both directions: skip ->
  // proceed to sign, evaluate -> block, fixed -> payment_control_unevaluable.
  {
    const h = clientHarness();
    const seen: Decision[] = [];
    installTwzrdAutoGate(h.client, {
      fetch: allowIntel,
      paymentControl: { signer: createLocalDecisionSigner(), policy: { allowlist: [] } },
      onDecision: (d) => seen.push(d as Decision),
    });
    const r = await h.fire(ctx({ amount: undefined }));
    assert.ok(r && "abort" in r, "amount=undefined with paymentControl configured proceeded to sign");
    assert.match(r.reason, /payment_control_unevaluable/);
    const last = seen.at(-1);
    assert.ok(last, "no onDecision emitted for the unevaluable payment");
    assert.equal(last.approved, false, "onDecision claimed approval for an unevaluable payment");
    assert.equal(last.intent, undefined, "unevaluable payment must not carry an intent");
  }

  // 2b. x402-solana seat (same shared evaluator): amount "" must not skip a
  // maxAmountUsd:"0" policy — the cheapest 402 on the wire would have passed.
  {
    const seen: Decision[] = [];
    const hook = installTwzrdAutoGate("x402-solana", {
      fetch: allowIntel,
      paymentControl: { signer: createLocalDecisionSigner(), policy: { maxAmountUsd: "0" } },
      onDecision: (d) => seen.push(d as Decision),
    }) as (r: Record<string, unknown>) => Promise<BeforePaymentCreationResult>;
    const r = await hook({ payTo: SELLER, network: SOL, amount: "", resource: "https://m.example/p" });
    assert.ok(r && "abort" in r, 'amount="" with paymentControl configured proceeded to sign');
    assert.match(r.reason, /payment_control_unevaluable/);
    const last = seen.at(-1);
    assert.equal(last?.approved, false, "onDecision claimed approval for an unevaluable payment");
  }

  // 2c. CONTROL: without paymentControl a missing amount is legacy territory —
  // the guard must stay silent. Without this case, a mutant that aborts every
  // missing-amount payment passes 2a/2b while breaking unconfigured installs.
  {
    const h = clientHarness();
    installTwzrdAutoGate(h.client, { fetch: allowIntel });
    const r = await h.fire(ctx({ amount: undefined }));
    assert.equal(r, undefined, "guard fired without paymentControl configured");
  }

  // 2d. CONTROL: Payment Control configured and the payment IS evaluable —
  // the unevaluable guard must stay out of the way (policy allows, so proceed).
  {
    const h = clientHarness();
    installTwzrdAutoGate(h.client, {
      fetch: allowIntel,
      paymentControl: { signer: createLocalDecisionSigner(), policy: { maxAmountUsd: "1000" } },
    });
    const r = await h.fire(ctx());
    assert.equal(r, undefined, "guard fired on an evaluable payment");
  }

  console.log("audit-paymentcontrol-unevaluable.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("audit-paymentcontrol-unevaluable.test.ts FAILED:", e);
  process.exit(1);
});
