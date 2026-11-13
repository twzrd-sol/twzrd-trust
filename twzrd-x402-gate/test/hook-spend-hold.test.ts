/**
 * Pre-sign hook + Payment Control: budget is booked for a payment the client
 * is told to sign, and for nothing else.
 *
 * Payment Control used to record the spend as soon as its own decision
 * allowed, before the gates that run after it: the paid clearance, the
 * required receipt, the last halt read. When one of those refused, the hook
 * aborted and the record stayed. A seller that answers with offers which pass
 * policy and fail clearance could use up the daily ceiling, the mandate and
 * the new-counterparty cap without one payment being signed.
 *
 * Run: npx tsx --test test/hook-spend-hold.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLocalDecisionSigner, createSeededDecisionSigner } from "../src/decision-token.js";
import { issuePaymentDecisionRecord } from "../src/payment-decision.js";
import { createMemorySpendLedger, type Mandate, type SpendLedger, type SpendPolicy } from "../src/policy-runtime.js";
import { evaluateBeforePaymentCreation, type InstallX402ClientHookOptions } from "../src/x402-client-hook.js";

const VECTOR_SECRET = createHash("sha256")
  .update("twzrd.payment_decision.v1 test vectors — NOT A DEPLOYMENT KEY")
  .digest("hex");
const issuer = createSeededDecisionSigner(VECTOR_SECRET, "twzrd-pd-v1-vectors");
const PEM = issuer.publicKeyPem;
const NOW = Date.parse("2026-09-20T00:00:00.000Z");
const DAY = 24 * 3_600_000;

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
/** $0.02. */
const CHALLENGE = {
  scheme: "exact",
  network: "solana",
  payTo: SELLER,
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "20000",
  resource: "https://deskcrew.example/api/x402/paid/ping",
};
const PRICE = 20_000n;

const allowPreflight = (async () =>
  new Response(
    JSON.stringify({
      readiness_card: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

async function clearanceRecord() {
  return issuePaymentDecisionRecord(
    {
      challenge: CHALLENGE,
      decision: "allow",
      reason_code: "ALLOW",
      evidence_id: "spend-hold-allow-1",
      expires_at: "2030-01-01T00:00:00.000Z",
    },
    issuer,
  );
}

type Control = { policy?: SpendPolicy; mandate?: Mandate; ledger: SpendLedger };

function hookOptions(
  control: Control,
  extra: Partial<InstallX402ClientHookOptions>,
): InstallX402ClientHookOptions {
  return {
    gateOnCanSpend: false,
    refuseWashFlagged: false,
    fetch: allowPreflight,
    now: () => NOW,
    paymentControl: { signer: createLocalDecisionSigner(), ...control },
    ...extra,
  } as InstallX402ClientHookOptions;
}

/** Hard clearance with no record and no issuer: policy allows, clearance refuses. */
const DENIED = { requirePaymentDecision: { publicKeyPem: PEM } };

const aborted = (r: unknown): string | undefined =>
  r && typeof r === "object" && (r as { abort?: boolean }).abort === true
    ? String((r as { reason?: string }).reason)
    : undefined;

const spent = (ledger: SpendLedger, scope: string) => ledger.spentMicro(scope, DAY, NOW);

test("a clearance-denied offer books nothing, and the next real payment still fits the daily ceiling", async () => {
  const control: Control = { policy: { dailyCeilingUsd: "0.02" }, ledger: createMemorySpendLedger() };

  for (let i = 0; i < 3; i += 1) {
    const refusal = aborted(await evaluateBeforePaymentCreation(CHALLENGE, hookOptions(control, DENIED)));
    assert.match(String(refusal), /clearance_required_missing_record/);
  }
  assert.equal(spent(control.ledger, "policy:global"), 0n);
  assert.equal(spent(control.ledger, `counterparty:${SELLER}`), 0n);
  assert.equal(control.ledger.firstSeen(`counterparty:${SELLER}`), undefined);

  const cleared = hookOptions(control, { requirePaymentDecision: { record: await clearanceRecord(), publicKeyPem: PEM } });
  assert.equal(await evaluateBeforePaymentCreation(CHALLENGE, cleared), undefined, "the cleared offer proceeds");
  assert.equal(spent(control.ledger, "policy:global"), PRICE);
  assert.equal(spent(control.ledger, `counterparty:${SELLER}`), PRICE);

  // The ceiling still works: the same offer a second time is over it.
  assert.match(String(aborted(await evaluateBeforePaymentCreation(CHALLENGE, cleared))), /POLICY_DAILY_CEILING/);
  assert.equal(spent(control.ledger, "policy:global"), PRICE);
});

test("a clearance-denied offer does not use up the mandate or the new-counterparty cap", async () => {
  const mandate: Mandate = { mandateId: "m-spend-hold", monthlyCeilingUsd: "0.02" };
  const control: Control = {
    mandate,
    policy: { newCounterpartyCap: { capUsd: "0.02", windowHours: 24 } },
    ledger: createMemorySpendLedger(),
  };

  assert.ok(aborted(await evaluateBeforePaymentCreation(CHALLENGE, hookOptions(control, DENIED))));
  assert.equal(spent(control.ledger, `mandate:${mandate.mandateId}`), 0n);
  assert.equal(spent(control.ledger, `counterparty:${SELLER}`), 0n);

  const cleared = hookOptions(control, { requirePaymentDecision: { record: await clearanceRecord(), publicKeyPem: PEM } });
  assert.equal(await evaluateBeforePaymentCreation(CHALLENGE, cleared), undefined);
  assert.equal(spent(control.ledger, `mandate:${mandate.mandateId}`), PRICE);
});

test("a halt that lands after the decision books nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-spend-hold-"));
  try {
    const control: Control = { policy: { dailyCeilingUsd: "0.02" }, ledger: createMemorySpendLedger() };
    // Soft clearance: the issuer hop runs after the Payment Control decision,
    // and the kill file appears while it is in flight.
    const options = hookOptions(control, {
      stateDir: dir,
      requirePaymentDecision: { hard: false, issuerUrl: "https://issuer.example/decision" },
      x402Fetch: (async () => {
        writeFileSync(join(dir, ".kill"), "");
        return new Response("no record", { status: 503 });
      }) as unknown as typeof fetch,
    });
    assert.match(String(aborted(await evaluateBeforePaymentCreation(CHALLENGE, options))), /twzrd_kill_switch/);
    assert.equal(spent(control.ledger, "policy:global"), 0n);
    assert.equal(control.ledger.firstSeen(`counterparty:${SELLER}`), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held decision still counts against the ceiling while its gates run", async () => {
  // One ceiling's worth of headroom, two offers in flight together: the second
  // sees the first one's hold and is refused, so the ceiling cannot be passed
  // by racing. When the first is then denied, its hold is gone.
  const control: Control = { policy: { dailyCeilingUsd: "0.02" }, ledger: createMemorySpendLedger() };
  let issuerReached = (): void => {};
  let releaseIssuer = (): void => {};
  const reached = new Promise<void>((resolve) => { issuerReached = resolve; });
  const released = new Promise<void>((resolve) => { releaseIssuer = resolve; });
  const slow = hookOptions(control, {
    requirePaymentDecision: { issuerUrl: "https://issuer.example/decision", publicKeyPem: PEM },
    x402Fetch: (async () => {
      issuerReached();
      await released;
      return new Response("no record", { status: 503 });
    }) as unknown as typeof fetch,
  });
  const first = evaluateBeforePaymentCreation(CHALLENGE, slow);
  await reached;

  const cleared = hookOptions(control, { requirePaymentDecision: { record: await clearanceRecord(), publicKeyPem: PEM } });
  assert.match(
    String(aborted(await evaluateBeforePaymentCreation(CHALLENGE, cleared))),
    /POLICY_DAILY_CEILING/,
    "the in-flight hold is visible to a concurrent evaluation",
  );
  assert.equal(spent(control.ledger, "policy:global"), 0n, "a hold is not a ledger record");

  releaseIssuer();
  assert.ok(aborted(await first), "the first offer is denied by clearance");
  assert.equal(spent(control.ledger, "policy:global"), 0n);

  assert.equal(await evaluateBeforePaymentCreation(CHALLENGE, cleared), undefined, "the hold was released");
  assert.equal(spent(control.ledger, "policy:global"), PRICE);
});

test("two offers approved together cannot both pass one ceiling", async () => {
  const control: Control = { policy: { dailyCeilingUsd: "0.02" }, ledger: createMemorySpendLedger() };
  const cleared = hookOptions(control, { requirePaymentDecision: { record: await clearanceRecord(), publicKeyPem: PEM } });
  const results = await Promise.all([
    evaluateBeforePaymentCreation(CHALLENGE, cleared),
    evaluateBeforePaymentCreation(CHALLENGE, cleared),
  ]);
  assert.equal(results.filter((r) => r === undefined).length, 1);
  assert.equal(results.filter((r) => aborted(r) !== undefined).length, 1);
  assert.equal(spent(control.ledger, "policy:global"), PRICE);
});
