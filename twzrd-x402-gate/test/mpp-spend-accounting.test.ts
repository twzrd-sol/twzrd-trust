import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMppSpendAccounting } from "../src/mpp-spend-accounting.js";
import { createFileSpendLedger, tokenAmountToMicroUsdCeil } from "../src/spend-ledger-file.js";

const dir = mkdtempSync(join(tmpdir(), "mpp-spend-"));
const file = join(dir, ".twzrd", "spend-v2.jsonl");
const receipt = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const response = (status: number, value?: unknown) => new Response("body", { status, headers: value === undefined ? {} : { "Payment-Receipt": receipt(value) } });
try {
  const accounting = createMppSpendAccounting({ spendLedgerFile: file });
  assert.equal(tokenAmountToMicroUsdCeil(1n, 7), 1n, "ceiling conversion prevents sub-micro undercount");

  const failedCharge = await accounting.reserveCharge({ scope: "charge-failed", amount: "1234567", decimals: 6, holdId: "charge-failed" });
  assert.equal(failedCharge.amountMicro, 1_234_567n);
  await accounting.markSigned(failedCharge);
  assert.equal(await accounting.recordResponse(failedCharge, response(503)), "pending", "a signed charge stays held on a failed response");
  assert.equal(createFileSpendLedger(file).spentMicro("charge-failed", 3_600_000, Date.now()), 1_234_567n);
  const unsignedCharge = await accounting.reserveCharge({ scope: "charge-unsigned", amount: "1234567", decimals: 6, holdId: "charge-unsigned" });
  assert.equal(await accounting.recordResponse(unsignedCharge, response(503)), "released", "a charge never signed is released");
  assert.equal(createFileSpendLedger(file).spentMicro("charge-unsigned", 3_600_000, Date.now()), 0n);

  const paidCharge = await accounting.reserveCharge({ scope: "charge", amount: "12", decimals: 7, holdId: "charge-paid" });
  await accounting.markSigned(paidCharge);
  assert.equal(paidCharge.amountMicro, 2n, "actual decimals use ceiling micro-USD conversion");
  assert.equal(await accounting.recordResponse(paidCharge, response(500, { reference: "charge-ref" })), "committed");
  assert.equal(await accounting.recordResponse(paidCharge, response(200, { reference: "charge-ref" })), "duplicate");
  assert.equal(createFileSpendLedger(file).spentMicro("charge", 3_600_000, Date.now()), 2n);

  const first = await accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "40", decimals: 6, holdId: "sess-1" });
  assert.equal(first.amountMicro, 40n);
  await accounting.markSigned(first);
  assert.equal(await accounting.recordResponse(first, response(200, { channelId: "chan-A", spent: "40", reference: "sess-ref-1" })), "committed");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-A"), 40n);

  const rejected = await accounting.reserveSession({ scope: "session-replay", channelId: "chan-A", voucherTotalBaseUnits: "100", decimals: 6, holdId: "sess-replay" });
  assert.equal(rejected.amountMicro, 60n, "hold only new voucher delta");
  await accounting.markSigned(rejected);
  assert.equal(await accounting.recordResponse(rejected, response(409)), "pending", "a signed voucher stays held when the seller rejects it");
  assert.equal(createFileSpendLedger(file).spentMicro("session-replay", 3_600_000, Date.now()), 60n);
  assert.equal(createFileSpendLedger(file).spentMicro("session", 3_600_000, Date.now()), 40n);

  const second = await accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "100", decimals: 6, holdId: "sess-2" });
  await accounting.markSigned(second);
  assert.equal(await accounting.recordResponse(second, response(200, { channelId: "chan-A", spent: "80", reference: "sess-ref-1" })), "committed", "cumulative session high-water is authoritative if a channel reference repeats");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-A"), 100n, "a receipt reporting less than the signed voucher does not lower the high-water");
  assert.equal(createFileSpendLedger(file).spentMicro("session", 3_600_000, Date.now()), 100n);
  assert.equal(createFileSpendLedger(file).spentMicro("session-replay", 3_600_000, Date.now()), 0n, "the rejected voucher is covered by the committed one");

  const lower = await accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "90", decimals: 6, holdId: "sess-lower" });
  assert.equal(lower.amountMicro, 0n, "a voucher below the high-water adds nothing");
  await accounting.markSigned(lower);
  assert.equal(await accounting.recordResponse(lower, response(200, { channelId: "chan-A", spent: "70", reference: "sess-lower-ref" })), "committed");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-A"), 100n, "high-water never reconciles downward");
  assert.equal(createFileSpendLedger(file).spentMicro("session", 3_600_000, Date.now()), 100n, "no negative reconciliation rows");

  const over = await accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "110", decimals: 6, holdId: "sess-over" });
  await accounting.markSigned(over);
  assert.equal(await accounting.recordResponse(over, response(200, { channelId: "chan-A", spent: "999" })), "pending", "a receipt claiming more than was signed leaves the hold held");

  const concurrent = createMppSpendAccounting({ spendLedgerFile: `${file}.concurrent` });
  await concurrent.reserveSession({ scope: "capped", channelId: "chan-C", voucherTotalBaseUnits: "10", decimals: 6, capMicro: 20n, holdId: "cap-1" });
  await assert.rejects(() => concurrent.reserveSession({ scope: "capped", channelId: "chan-C", voucherTotalBaseUnits: "15", decimals: 6, capMicro: 20n, holdId: "cap-2" }), /mpp_spend_cap_exceeded/);
} finally { rmSync(dir, { recursive: true, force: true }); }