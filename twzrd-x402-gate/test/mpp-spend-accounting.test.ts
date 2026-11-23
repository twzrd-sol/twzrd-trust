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

  const failedCharge = accounting.reserveCharge({ scope: "charge", amount: "1234567", decimals: 6, holdId: "charge-failed" });
  assert.equal(failedCharge.amountMicro, 1_234_567n);
  accounting.markSigned(failedCharge);
  assert.equal(accounting.recordResponse(failedCharge, response(503)), "released");
  assert.equal(createFileSpendLedger(file).spentMicro("charge", 3_600_000, Date.now()), 0n);

  const paidCharge = accounting.reserveCharge({ scope: "charge", amount: "12", decimals: 7, holdId: "charge-paid" });
  accounting.markSigned(paidCharge);
  assert.equal(paidCharge.amountMicro, 2n, "actual decimals use ceiling micro-USD conversion");
  assert.equal(accounting.recordResponse(paidCharge, response(500, { reference: "charge-ref" })), "committed");
  assert.equal(accounting.recordResponse(paidCharge, response(200, { reference: "charge-ref" })), "duplicate");
  assert.equal(createFileSpendLedger(file).spentMicro("charge", 3_600_000, Date.now()), 2n);

  const first = accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "100", decimals: 6, holdId: "sess-1" });
  assert.equal(first.amountMicro, 100n);
  accounting.markSigned(first);
  assert.equal(accounting.recordResponse(first, response(200, { channelId: "chan-A", spent: "40", reference: "sess-ref-1" })), "committed");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-A"), 40n);

  const rejected = accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "100", decimals: 6, holdId: "sess-replay" });
  assert.equal(rejected.amountMicro, 60n, "hold only new voucher delta");
  accounting.markSigned(rejected);
  assert.equal(accounting.recordResponse(rejected, response(409)), "released");
  assert.equal(createFileSpendLedger(file).spentMicro("session", 3_600_000, Date.now()), 40n);

  const second = accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "100", decimals: 6, holdId: "sess-2" });
  accounting.markSigned(second);
  assert.equal(accounting.recordResponse(second, response(200, { channelId: "chan-A", spent: "80", reference: "sess-ref-2" })), "committed");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-A"), 80n);
  assert.equal(createFileSpendLedger(file).spentMicro("session", 3_600_000, Date.now()), 80n);

  const lower = accounting.reserveSession({ scope: "session", channelId: "chan-A", voucherTotalBaseUnits: "90", decimals: 6, holdId: "sess-lower" });
  assert.equal(lower.amountMicro, 10n);
  accounting.markSigned(lower);
  assert.equal(accounting.recordResponse(lower, response(200, { channelId: "chan-A", spent: "70", reference: "sess-lower-ref" })), "committed");
  assert.equal(accounting.ledger.highestSpentMicroByChannel("chan-A"), 80n, "high-water never reconciles downward");
  assert.equal(createFileSpendLedger(file).spentMicro("session", 3_600_000, Date.now()), 80n, "no negative reconciliation rows");

  const concurrent = createMppSpendAccounting({ spendLedgerFile: `${file}.concurrent` });
  concurrent.reserveSession({ scope: "capped", channelId: "chan-C", voucherTotalBaseUnits: "10", decimals: 6, capMicro: 20n, holdId: "cap-1" });
  assert.throws(() => concurrent.reserveSession({ scope: "capped", channelId: "chan-C", voucherTotalBaseUnits: "15", decimals: 6, capMicro: 20n, holdId: "cap-2" }), /mpp_spend_cap_exceeded/);
} finally { rmSync(dir, { recursive: true, force: true }); }
