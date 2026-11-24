/**
 * A signed payment stays counted against the buyer's caps, whatever the seller answers.
 *
 * Whoever holds a signed payment can settle it. A failure status, a `success: false`
 * settlement header, a missing header and a reused settlement reference all come from the
 * seller, so none of them may free the spend hold of a signature already sent. These tests
 * play a seller that takes every signature and never delivers, through the real
 * @x402/fetch client and a fake signer (no keys, no network, no intel), and count signatures:
 * with a $0.005 hour at $0.001 a call, the answer is 5, however many times the agent retries.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { x402Client } from "@x402/fetch";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";
import { createTwzrdMppOnChallenge, type MppChallenge } from "../src/mpp-hook.js";
import { createMppSpendAccounting, type MppSpendAccounting } from "../src/mpp-spend-accounting.js";
import { createFileSpendLedger } from "../src/spend-ledger-file.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const URL = "https://merchant.example/paid";
const HOUR = 3_600_000;
const SCOPE = "guarded:default";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const tx = (n: number) => String(n).padStart(8, "1") + "1".repeat(80);
const challengeFor = (amount: string): PaymentRequired => ({
  x402Version: 2,
  resource: { url: URL },
  accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount, payTo: SELLER, maxTimeoutSeconds: 60, extra: {} }],
});
const asksAgain = () => new Response(null, { status: 402, headers: { "payment-required": b64(challengeFor("1000")) } });
const settled = (body: Record<string, unknown>, status = 200) =>
  new Response("{}", { status, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64(body) } });
const tempDir = () => mkdtempSync(join(tmpdir(), "signed-hold-"));
const tempLedger = () => join(tempDir(), "spend-v2.jsonl");

/** A guarded fetch whose paid leg the test answers; it counts signatures and paid requests. */
function rig(paid: (n: number) => Response, options: { recover?: boolean; file?: string; maxPricePerCall?: string } = {}) {
  let signs = 0;
  let paidRequests = 0;
  const quote = { amount: "1000" };
  const client = x402Client.fromConfig({ schemes: [], spendControls: false as const });
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload(version, requirements) {
      signs++;
      return { x402Version: version, payload: { signature: `fake-signature-${signs}`, amount: requirements.amount } };
    },
  };
  client.register(NETWORK, scheme);
  if (options.recover) client.onPaymentResponse(async () => ({ recovered: true as const }));
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.has("payment-signature") || request.headers.has("x-payment")) return paid(++paidRequests);
    return new Response(null, { status: 402, headers: { "payment-required": b64(challengeFor(quote.amount)) } });
  };
  const file = options.file ?? tempLedger();
  const guarded = createGuardedX402Fetch({
    client, fetch: transport, hourlyBudgetCap: "0.005", spendLedgerFile: file, twzrd: { disabled: true },
    ...(options.maxPricePerCall ? { maxPricePerCall: options.maxPricePerCall } : {}),
  });
  return { guarded, file, quote, get signs() { return signs; }, get paid() { return paidRequests; } };
}

/** The agent's outer loop: call the same paid URL again after every failure. */
async function retry(fetchImpl: typeof fetch, times: number) {
  const statuses: number[] = [];
  const errors: string[] = [];
  for (let i = 0; i < times; i++) {
    try {
      const response = await fetchImpl(URL);
      statuses.push(response.status);
      await response.arrayBuffer();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { statuses, errors, overBudget: errors.filter(e => e.includes("hourly_budget_exceeded")).length };
}

const spent = (file: string, scope = SCOPE) => createFileSpendLedger(file).spentMicro(scope, HOUR, Date.now());

test("a seller that answers every paid request with another 402 gets cap/price signatures", async () => {
  const h = rig(asksAgain);
  const run = await retry(h.guarded, 100);
  assert.equal(h.signs, 5);
  assert.equal(h.paid, 5);
  assert.deepEqual(run.statuses, [402, 402, 402, 402, 402]);
  assert.equal(run.overBudget, 95);
  assert.equal(spent(h.file), 5000n, "every signed hold is still counted");
});

for (const [name, answer] of [
  ["a 402 with success: false in the settlement header", () => settled({ success: false, errorReason: "insufficient_funds" }, 402)],
  ["a 200 OK with success: false in the settlement header", () => settled({ success: false, errorReason: "settlement_failed" }, 200)],
  ["a 200 OK with no settlement header", () => new Response("{}", { status: 200 })],
  ["a 500 with no settlement header", () => new Response("down", { status: 500 })],
  ["a 403 with no settlement header", () => new Response("no", { status: 403 })],
  ["an unreadable settlement header", () => new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": "%%%" } })],
] as const) {
  test(`${name}: 100 calls, 5 signatures, every hold still counted`, async () => {
    const h = rig(answer);
    const run = await retry(h.guarded, 100);
    assert.equal(h.signs, 5);
    assert.equal(run.overBudget, 95);
    assert.equal(spent(h.file), 5000n);
  });
}

test("one settlement reference reused for every signature counts every signature", async () => {
  const h = rig(() => settled({ success: true, transaction: tx(1), network: NETWORK }));
  const run = await retry(h.guarded, 100);
  assert.equal(h.signs, 5);
  assert.deepEqual(run.statuses, [200, 200, 200, 200, 200]);
  assert.equal(run.overBudget, 95);
  assert.equal(spent(h.file), 5000n);
});

test("an onPaymentResponse recovery hook: each recovery signature is held too", async () => {
  const h = rig(asksAgain, { recover: true });
  const run = await retry(h.guarded, 100);
  assert.equal(h.signs, 5, "initial and recovery signatures share the one cap");
  assert.equal(h.paid, 5);
  assert.equal(run.errors.length + run.statuses.length, 100);
  assert.equal(spent(h.file), 5000n);
});

test("an honest seller settles each payment once: five paid calls, then the hour is spent", async () => {
  const h = rig(n => settled({ success: true, transaction: tx(n), network: NETWORK }));
  const run = await retry(h.guarded, 8);
  assert.equal(h.signs, 5);
  assert.deepEqual(run.statuses, [200, 200, 200, 200, 200]);
  assert.equal(run.overBudget, 3);
  assert.equal(spent(h.file), 5000n);
});

test("100 refusals before signing sign nothing and leave the hour intact", async () => {
  const h = rig(n => settled({ success: true, transaction: tx(n), network: NETWORK }), { maxPricePerCall: "0.002" });
  h.quote.amount = "5000"; // $0.005: over the per-call cap
  const refused = await retry(h.guarded, 100);
  assert.equal(h.signs, 0);
  assert.equal(refused.errors.filter(e => e.includes("price_cap_exceeded")).length, 100);
  assert.equal(spent(h.file), 0n, "a refusal before signing holds nothing");
  h.quote.amount = "1000";
  const valid = await retry(h.guarded, 6);
  assert.equal(h.signs, 5, "the whole hour is still available");
  assert.equal(valid.overBudget, 1);
});

test("the ledger releases only holds that never signed", async () => {
  const file = tempLedger();
  const ledger = createFileSpendLedger(file);
  assert.equal(await ledger.reserveAsync("s", 10n, "unsigned", 100n, HOUR, Date.now()), true);
  assert.equal(await ledger.releaseAsync("unsigned"), true);
  assert.equal(await ledger.reserveAsync("s", 10n, "signed", 100n, HOUR, Date.now()), true);
  assert.equal(await ledger.markSignedAsync("signed"), true);
  assert.equal(await ledger.releaseAsync("signed"), false, "a signed hold is not released");
  assert.equal(spent(file, "s"), 10n);
  assert.equal(await ledger.commitAsync("signed", "late-settlement"), true, "a late settlement still commits it");
  assert.equal(spent(file, "s"), 10n);

  assert.equal(await ledger.reserveAsync("s", 10n, "reused", 100n, HOUR, Date.now()), true);
  assert.equal(await ledger.markSignedAsync("reused"), true);
  assert.equal(await ledger.commitAsync("reused", "late-settlement"), false, "the reference was already counted");
  assert.equal(spent(file, "s"), 20n, "but this signature is counted at its own amount");
  assert.equal(createFileSpendLedger(file).settlementReferenceSeen("late-settlement"), true);
});

/** A caller-capped accounting: the MPP hook has no cumulative cap of its own; a rail adds one through capMicro. */
function capped(accounting: MppSpendAccounting, capMicro: bigint): MppSpendAccounting {
  return { ...accounting, reserveCharge: (input) => accounting.reserveCharge({ ...input, capMicro }) };
}

test("MPP hook: 100 hostile calls (402, 403, timeout) under a $0.005 cap create 5 credentials", async () => {
  const dir = tempDir();
  const file = join(dir, "spend-v2.jsonl");
  const accounting = createMppSpendAccounting({ spendLedgerFile: file });
  let credentials = 0;
  let record: ((response: Response) => Promise<string>) | undefined;
  const guard = createTwzrdMppOnChallenge({
    signer: createLocalDecisionSigner(),
    decisionFile: join(dir, "decisions.jsonl"),
    policy: { maxAmountUsd: "1.00" },
    intelligence: () => ({ known: true, washFlagged: false, decision: "allow" }),
    spendAccounting: capped(accounting, 5000n),
    onSpendHold: ({ recordResponse }) => { record = recordResponse; },
  });
  const charge = (n: number): MppChallenge => ({
    id: `chal_${n}`, realm: "api.example.com", method: "solana", intent: "charge",
    request: { amount: "1000", currency: USDC, decimals: 6, recipient: SELLER },
  });
  const helpers = { createCredential: async () => { credentials++; return "Payment credential=stub"; } };
  const hostile = [() => new Response("pay again", { status: 402 }), () => new Response("no", { status: 403 }), undefined];
  let refused = 0;
  for (let n = 0; n < 100; n++) {
    record = undefined;
    try { await guard(charge(n), helpers); }
    catch (error) { if (String((error as Error).message).includes("mpp_spend_cap_exceeded")) { refused++; continue; } throw error; }
    const answer = hostile[n % hostile.length];
    if (answer) assert.equal(await record!(answer()), "pending", "a signed charge stays held on a failed response");
    // undefined: the request timed out and no response is ever recorded.
  }
  assert.equal(credentials, 5);
  assert.equal(refused, 95);
  assert.equal(createFileSpendLedger(file).spentMicro("mpp:default", HOUR, Date.now()), 5000n);
});

test("MPP: a failed charge or a rejected voucher keeps its signed hold; an unsigned one is released", async () => {
  const file = tempLedger();
  const accounting = createMppSpendAccounting({ spendLedgerFile: file });
  const failed = (status: number) => new Response("no", { status });
  const receipt = (value: unknown) => new Response("ok", { status: 200, headers: { "Payment-Receipt": Buffer.from(JSON.stringify(value)).toString("base64url") } });

  const signedCharge = await accounting.reserveCharge({ scope: "charge", amount: "1000", decimals: 6 });
  await accounting.markSigned(signedCharge);
  assert.equal(await accounting.recordResponse(signedCharge, failed(503)), "pending");
  assert.equal(spent(file, "charge"), 1000n);
  const unsignedCharge = await accounting.reserveCharge({ scope: "charge", amount: "1000", decimals: 6 });
  assert.equal(await accounting.recordResponse(unsignedCharge, failed(503)), "released");
  assert.equal(spent(file, "charge"), 1000n);
  const reused = await accounting.reserveCharge({ scope: "charge", amount: "1000", decimals: 6 });
  await accounting.markSigned(reused);
  assert.equal(await accounting.recordResponse(reused, receipt({ reference: "charge-ref" })), "committed");
  const again = await accounting.reserveCharge({ scope: "charge", amount: "1000", decimals: 6 });
  await accounting.markSigned(again);
  assert.equal(await accounting.recordResponse(again, receipt({ reference: "charge-ref" })), "duplicate");
  assert.equal(spent(file, "charge"), 3000n, "a reused receipt reference does not free another signed charge");

  const opened = await accounting.reserveSession({ scope: "session", channelId: "chan", voucherTotalBaseUnits: "40", decimals: 6 });
  await accounting.markSigned(opened);
  assert.equal(await accounting.recordResponse(opened, receipt({ channelId: "chan", spent: "40" })), "committed");
  const rejected = await accounting.reserveSession({ scope: "session", channelId: "chan", voucherTotalBaseUnits: "100", decimals: 6 });
  await accounting.markSigned(rejected);
  assert.equal(await accounting.recordResponse(rejected, failed(409)), "pending");
  assert.equal(spent(file, "session"), 100n, "the rejected voucher (60 above the high-water) stays counted");
  const unsignedVoucher = await accounting.reserveSession({ scope: "session", channelId: "chan", voucherTotalBaseUnits: "120", decimals: 6 });
  assert.equal(await accounting.recordResponse(unsignedVoucher, failed(409)), "released");
  const retried = await accounting.reserveSession({ scope: "session", channelId: "chan", voucherTotalBaseUnits: "100", decimals: 6 });
  await accounting.markSigned(retried);
  assert.equal(spent(file, "session"), 160n, "two signed vouchers in flight are both held");
  assert.equal(await accounting.recordResponse(retried, receipt({ channelId: "chan", spent: "100" })), "committed");
  assert.equal(spent(file, "session"), 100n, "a committed voucher that covers the rejected one's total supersedes it");
  assert.equal(await accounting.recordResponse(rejected, receipt({ channelId: "chan", spent: "100" })), "duplicate", "the superseded hold is resolved");
});

test("MPP session: a receipt reporting less than the signed voucher does not lower counted spend", async () => {
  const file = tempLedger();
  const accounting = createMppSpendAccounting({ spendLedgerFile: file });
  const receipt = (value: unknown) => new Response("ok", { status: 200, headers: { "Payment-Receipt": Buffer.from(JSON.stringify(value)).toString("base64url") } });
  const voucher = await accounting.reserveSession({ scope: "session", channelId: "chan-u", voucherTotalBaseUnits: "150", decimals: 6 });
  await accounting.markSigned(voucher);
  assert.equal(await accounting.recordResponse(voucher, receipt({ channelId: "chan-u", spent: "10" })), "committed");
  assert.equal(spent(file, "session"), 150n, "the seller can redeem the whole signed voucher");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-u"), 150n);
  const next = await accounting.reserveSession({ scope: "session", channelId: "chan-u", voucherTotalBaseUnits: "160", decimals: 6 });
  assert.equal(next.amountMicro, 10n, "the next voucher holds only what it adds above the signed high-water");
});
