/**
 * A cumulative cap with no spend ledger refuses.
 *
 * `dailyCeilingUsd`, `monthlyCeilingUsd` and `newCounterpartyCap` are read
 * from a spend ledger. Through 0.22.1 a caller that set one and passed no
 * ledger got an allow on every intent: the check returned early and nothing
 * said the cap was off. Each now blocks with SPEND_CAP_NEEDS_LEDGER and a
 * reason naming the cap.
 *
 * Run: npx tsx --test test/cap-needs-ledger.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalDecisionSigner, type PaymentDecision } from "../src/decision-token.js";
import type { PaymentIntent } from "../src/intent.js";
import { createTwzrdPolicyFetch, TwzrdPolicyAbortError } from "../src/policy-fetch.js";
import {
  createMemorySpendLedger,
  evaluateIntent,
  SPEND_CAP_NEEDS_LEDGER,
  type Mandate,
  type SpendPolicy,
} from "../src/policy-runtime.js";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SELLER = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";
const signer = createLocalDecisionSigner({ keyId: "cap-needs-ledger" });

const intent = (amount = "0.01"): PaymentIntent => ({
  protocol: "x402",
  network: NETWORK,
  asset: USDC,
  amount,
  payTo: SELLER,
  resource: { url: "https://store.example/item", method: "GET" },
});

const CASES: Array<{ name: string; code: string; policy?: SpendPolicy; mandate?: Mandate }> = [
  { name: "dailyCeilingUsd", code: "NEEDS_LEDGER_DAILY_CEILING", policy: { dailyCeilingUsd: "1.00" } },
  { name: "monthlyCeilingUsd", code: "NEEDS_LEDGER_MONTHLY_CEILING", mandate: { mandateId: "m", monthlyCeilingUsd: "5.00" } },
  {
    name: "newCounterpartyCap",
    code: "NEEDS_LEDGER_NEW_COUNTERPARTY_CAP",
    policy: { newCounterpartyCap: { capUsd: "1.00", windowHours: 24 } },
  },
];

for (const c of CASES) {
  test(`${c.name} without a ledger blocks a payment far under the cap`, async () => {
    const d = await evaluateIntent(intent(), { signer, policy: c.policy, mandate: c.mandate });
    assert.equal(d.decision, "block");
    assert.deepEqual(d.reasonCodes, [c.code, SPEND_CAP_NEEDS_LEDGER]);
    // A configuration refusal, not a budget refusal: no headroom is claimed.
    assert.equal(d.reasonCodes.includes("twzrd_budget_exceeded"), false);
    assert.equal(d.budgetRemainingUsdc, undefined);
  });

  test(`${c.name} with a ledger allows the same payment and enforces the cap`, async () => {
    const ledger = createMemorySpendLedger();
    const opts = { signer, ledger, policy: c.policy, mandate: c.mandate };
    assert.equal((await evaluateIntent(intent(), opts)).decision, "allow");
    const over = await evaluateIntent(intent("9.00"), opts);
    assert.equal(over.decision, "block");
    assert.equal(over.reasonCodes.includes(SPEND_CAP_NEEDS_LEDGER), false);
  });
}

test("three caps without a ledger list each cap once and the shared code once", async () => {
  const d = await evaluateIntent(intent(), {
    signer,
    policy: { dailyCeilingUsd: "1.00", newCounterpartyCap: { capUsd: "1.00", windowHours: 24 } },
    mandate: { mandateId: "m", monthlyCeilingUsd: "5.00" },
  });
  assert.equal(d.decision, "block");
  assert.deepEqual([...d.reasonCodes].sort(), [
    "NEEDS_LEDGER_DAILY_CEILING",
    "NEEDS_LEDGER_MONTHLY_CEILING",
    "NEEDS_LEDGER_NEW_COUNTERPARTY_CAP",
    SPEND_CAP_NEEDS_LEDGER,
  ]);
});

test("caps that need no ledger are unchanged without one", async () => {
  const under = await evaluateIntent(intent("0.50"), { signer, policy: { maxAmountUsd: "1.00" } });
  assert.equal(under.decision, "allow");
  const over = await evaluateIntent(intent("2.00"), { signer, policy: { maxAmountUsd: "1.00" } });
  assert.ok(over.reasonCodes.includes("POLICY_MAX_AMOUNT"));
  assert.equal((await evaluateIntent(intent(), { signer })).decision, "allow");
});

test("the fetch wrapper refuses before paying when a daily ceiling has no ledger", async () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  let paid = 0;
  const audits: PaymentDecision[] = [];
  const pay = createTwzrdPolicyFetch({
    signer,
    fetch: (async () => json({ wash_flagged: false, wash_confidence: "full" })) as unknown as typeof fetch,
    rawFetch: (async () =>
      json({ accepts: [{ payTo: SELLER, amount: "10000", network: "solana", asset: USDC }] }, 402)) as unknown as typeof fetch,
    wrapPay: (gated) => async (input, init) => {
      const r = await gated(input, init);
      if (r.status !== 402) return r;
      paid += 1;
      return new Response("paid", { status: 200 });
    },
    policy: { dailyCeilingUsd: "0.05" },
    onAudit: (d: PaymentDecision) => audits.push(d),
  });
  await assert.rejects(pay("https://store.example/item"), TwzrdPolicyAbortError);
  assert.equal(paid, 0);
  assert.ok(audits.at(-1)?.reasonCodes.includes(SPEND_CAP_NEEDS_LEDGER));
});

/* ---- The ledger is there but cannot be read or written ---------------- */

test("a ledger file that is unreadable, corrupt or chain-broken is refused at open", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createFileSpendLedger } = await import("../src/spend-ledger-file.js");
  const dir = mkdtempSync(join(tmpdir(), "twzrd-cap-ledger-"));

  const corrupt = join(dir, "corrupt.jsonl");
  writeFileSync(corrupt, "{not json\n");
  assert.throws(() => createFileSpendLedger(corrupt), /spend ledger corrupt row/);

  const broken = join(dir, "broken.jsonl");
  writeFileSync(broken, JSON.stringify({ at: 1, scope: "policy:global", micro: "1", prev: "not-the-genesis" }) + "\n");
  assert.throws(() => createFileSpendLedger(broken), /spend ledger chain broken/);

  // A directory where the file should be: not ENOENT, so not a fresh ledger.
  const isDir = join(dir, "is-a-directory");
  mkdirSync(isDir);
  assert.throws(() => createFileSpendLedger(isDir));
});

test("a ledger that fails while a cap is read or the spend is recorded yields no decision", async () => {
  const policy = { dailyCeilingUsd: "1.00" };
  const unreadable = {
    spentMicro: () => { throw new Error("ledger read failed"); },
    firstSeen: () => undefined,
    record: () => {},
  };
  await assert.rejects(evaluateIntent(intent(), { signer, policy, ledger: unreadable }), /ledger read failed/);

  const inner = createMemorySpendLedger();
  const unwritable = { ...inner, record: () => { throw new Error("ledger write failed"); } };
  await assert.rejects(evaluateIntent(intent(), { signer, policy, ledger: unwritable }), /ledger write failed/);
  // Nothing was counted, and no allow token exists for the failed write.
  assert.equal(inner.spentMicro("policy:global", 86_400_000, Date.now()), 0n);
});

/* ---- Budget exhausted -------------------------------------------------- */

test("an exhausted budget refuses with the budget code and zero headroom", async () => {
  const ledger = createMemorySpendLedger();
  const opts = { signer, ledger, policy: { dailyCeilingUsd: "0.05" } };
  for (let i = 0; i < 5; i += 1) assert.equal((await evaluateIntent(intent("0.01"), opts)).decision, "allow");
  const d = await evaluateIntent(intent("0.01"), opts);
  assert.equal(d.decision, "block");
  assert.ok(d.reasonCodes.includes("POLICY_DAILY_CEILING"));
  assert.ok(d.reasonCodes.includes("twzrd_budget_exceeded"));
  assert.equal(d.budgetRemainingUsdc, "0");
  assert.equal(d.reasonCodes.includes(SPEND_CAP_NEEDS_LEDGER), false);
});

/* ---- Concurrency ------------------------------------------------------- */

test("concurrent intents on one ledger never allow more than the daily ceiling", async () => {
  const ledger = createMemorySpendLedger();
  // Intelligence resolves after a turn of the event loop, so every intent
  // passes the early cap check against the same empty ledger.
  const intelligence = async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { known: true, decision: "allow" as const };
  };
  const decisions = await Promise.all(
    Array.from({ length: 20 }, () =>
      evaluateIntent(intent("0.01"), {
        signer,
        ledger,
        policy: { dailyCeilingUsd: "0.05" },
        intelligence,
      }),
    ),
  );
  const allowed = decisions.filter((d) => d.decision !== "block").length;
  assert.equal(allowed, 5);
  assert.equal(ledger.spentMicro("policy:global", 86_400_000, Date.now()), 50_000n);
  for (const d of decisions.filter((x) => x.decision === "block")) {
    assert.ok(d.reasonCodes.includes("POLICY_DAILY_CEILING"), JSON.stringify(d.reasonCodes));
  }
});

/* ---- The two hooks ------------------------------------------------------ */

test("x402 client hook aborts a payment when a cumulative cap has no ledger, and pays with one", async () => {
  const { installTwzrdX402ClientHook } = await import("../src/x402-client-hook.js");
  type Hook = (ctx: { selectedRequirements: Record<string, unknown> }) => Promise<unknown>;
  const rig = (paymentControl: Record<string, unknown>) => {
    let hook: Hook | undefined;
    const client = {
      onBeforePaymentCreation(h: Hook) {
        hook = h;
        return client;
      },
    };
    const decisions: Array<{ approved: boolean; reason?: string }> = [];
    installTwzrdX402ClientHook(client as never, {
      paymentControl: { secret: "c70a5f31e9b248d6ac1e05397fb82d4610c93e7a25bf40d81639ae52c807b4f9", ...paymentControl } as never,
      gateOnCanSpend: false,
      refuseWashFlagged: false,
      fetch: (async () =>
        new Response(JSON.stringify({ readiness_card: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      onDecision: (d) => decisions.push(d as never),
    });
    const fire = () => hook!({ selectedRequirements: { payTo: SELLER, network: NETWORK, amount: "10000", asset: USDC } });
    return { fire, decisions };
  };
  const aborted = (r: unknown) => Boolean(r && typeof r === "object" && "abort" in r && (r as { abort?: unknown }).abort);

  for (const c of CASES) {
    const bare = rig({ policy: c.policy, mandate: c.mandate });
    const result = (await bare.fire()) as { reason?: string };
    assert.equal(aborted(result), true, c.name);
    assert.match(String(result.reason), new RegExp(c.code), c.name);
    assert.equal(bare.decisions.at(-1)?.approved, false, c.name);

    const withLedger = rig({ policy: c.policy, mandate: c.mandate, ledger: createMemorySpendLedger() });
    assert.equal(aborted(await withLedger.fire()), false, c.name);
  }
});

test("MPP hook refuses before a credential is created when a daily ceiling has no ledger", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createTwzrdMppOnChallenge, TwzrdMppBlockError } = await import("../src/mpp-hook.js");
  const decisionFile = join(mkdtempSync(join(tmpdir(), "twzrd-cap-mpp-")), "decisions.jsonl");
  const challenge = {
    id: "chal_cap",
    realm: "api.example.com",
    method: "solana",
    intent: "charge",
    request: { amount: "10000", currency: USDC, decimals: 6, recipient: SELLER },
  };
  const run = async (ledger?: ReturnType<typeof createMemorySpendLedger>) => {
    let credentials = 0;
    const guard = createTwzrdMppOnChallenge({
      signer,
      decisionFile,
      policy: { dailyCeilingUsd: "0.05" },
      ledger,
      intelligence: () => ({ known: true, decision: "allow" as const }),
    });
    const helpers = {
      createCredential: async () => {
        credentials += 1;
        return "Payment credential=stub";
      },
    };
    try {
      await guard(challenge as never, helpers as never);
      return { credentials, error: undefined };
    } catch (error) {
      return { credentials, error };
    }
  };

  const bare = await run();
  assert.ok(bare.error instanceof TwzrdMppBlockError, String(bare.error));
  assert.ok((bare.error.reasonCodes ?? []).includes(SPEND_CAP_NEEDS_LEDGER), JSON.stringify(bare.error.reasonCodes));
  assert.equal(bare.credentials, 0);

  const ok = await run(createMemorySpendLedger());
  assert.equal(ok.error, undefined, String(ok.error));
  assert.equal(ok.credentials, 1);
});

/* ---- Decision records --------------------------------------------------- */

test("the refusal is not a payment_decision.v1 reason: projecting the token throws", async () => {
  const { primaryReasonCode, TwzrdPaymentDecisionError } = await import("../src/payment-decision.js");
  const d = await evaluateIntent(intent(), { signer, policy: { dailyCeilingUsd: "1.00" } });
  assert.throws(() => primaryReasonCode("block", d.reasonCodes), TwzrdPaymentDecisionError);
});
