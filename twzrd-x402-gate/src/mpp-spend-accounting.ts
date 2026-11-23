import { randomUUID } from "node:crypto";
import { toMicroUsd } from "./intent.js";
import { DEFAULT_SPEND_LEDGER_FILE, sharedFileSpendLedger, tokenAmountToMicroUsdCeil, type FileSpendLedger } from "./spend-ledger-file.js";

export type MppSpendKind = "charge" | "session";
export type MppSpendHold = { holdId: string; scope: string; amountMicro: bigint; decimals: number; kind: MppSpendKind; channelId?: string; voucherTotalMicro?: bigint; previousHighWaterMicro?: bigint };
export type MppSpendAccounting = {
  reserveCharge(input: { scope?: string; amount: string; decimals: number; capMicro?: bigint; holdId?: string }): MppSpendHold;
  reserveSession(input: { scope?: string; channelId: string; voucherTotalBaseUnits: string; decimals: number; capMicro?: bigint; holdId?: string }): MppSpendHold;
  markSigned(hold: MppSpendHold): boolean;
  recordResponse(hold: MppSpendHold, response: Response): "committed" | "released" | "pending" | "duplicate";
  ledger: FileSpendLedger;
};

function headerReceipt(response: Response): Record<string, unknown> | null {
  const raw = response.headers.get("Payment-Receipt");
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function decimalToMicro(amount: string): bigint { return toMicroUsd(amount); }
function receiptRef(receipt: Record<string, unknown>): string | undefined {
  if (typeof receipt.reference === "string" && receipt.reference) return receipt.reference;
  if (typeof receipt.txHash === "string" && receipt.txHash) return receipt.txHash;
  if (typeof receipt.transaction === "string" && receipt.transaction) return receipt.transaction;
  return undefined;
}

/**
 * Settlement accounting for MPP transports. The hold is written before signing;
 * callers invoke recordResponse only after the corresponding response/stream ends.
 */
export function createMppSpendAccounting(options: { spendLedgerFile?: string; scope?: string; now?: () => number } = {}): MppSpendAccounting {
  const ledger = sharedFileSpendLedger(options.spendLedgerFile ?? DEFAULT_SPEND_LEDGER_FILE);
  const defaultScope = `mpp:${options.scope ?? "default"}`;
  const now = options.now ?? Date.now;
  const makeHold = (scope: string, amountMicro: bigint, decimals: number, capMicro: bigint | undefined, holdId: string, kind: MppSpendKind, channelId?: string, voucherTotalMicro?: bigint, previousHighWaterMicro?: bigint): MppSpendHold => {
    const reserved = channelId && voucherTotalMicro !== undefined
      ? ledger.reserveChannel(scope, amountMicro, holdId, capMicro, 24 * 60 * 60 * 1000, now(), channelId, voucherTotalMicro)
      : ledger.reserve(scope, amountMicro, holdId, capMicro, 24 * 60 * 60 * 1000, now());
    if (!reserved) throw new Error("mpp_spend_cap_exceeded");
    return { holdId, scope, amountMicro, decimals, kind, ...(channelId ? { channelId } : {}), ...(voucherTotalMicro !== undefined ? { voucherTotalMicro } : {}), ...(previousHighWaterMicro !== undefined ? { previousHighWaterMicro } : {}) };
  };
  return {
    ledger,
    reserveCharge({ scope = defaultScope, amount, decimals, capMicro, holdId = randomUUID() }) {
      if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) throw new TypeError("invalid MPP charge amount/decimals");
      return makeHold(scope, tokenAmountToMicroUsdCeil(BigInt(amount), decimals), decimals, capMicro, holdId, "charge");
    },
    reserveSession({ scope = defaultScope, channelId, voucherTotalBaseUnits, decimals, capMicro, holdId = randomUUID() }) {
      if (!channelId || !/^\d+$/.test(voucherTotalBaseUnits) || !Number.isInteger(decimals) || decimals < 0) throw new TypeError("invalid MPP session voucher amount/decimals");
      // Compute against settled high-water. Concurrent uncommitted vouchers
      // reserve conservatively from the same settled point; if one is rejected,
      // another cannot have under-reserved its eventual cumulative spend.
      const previous = ledger.highestSpentMicroByChannel(channelId);
      const total = tokenAmountToMicroUsdCeil(BigInt(voucherTotalBaseUnits), decimals);
      const delta = total > previous ? total - previous : 0n;
      return makeHold(scope, delta, decimals, capMicro, holdId, "session", channelId, total, previous);
    },
    markSigned(hold) { return ledger.markSigned(hold.holdId); },
    recordResponse(hold, response) {
      const receipt = headerReceipt(response);
      if (hold.kind === "charge") {
        const ref = receipt && receiptRef(receipt);
        if (receipt && ref) return ledger.commit(hold.holdId, ref) ? "committed" : "duplicate";
        if (!response.ok && !receipt) { ledger.release(hold.holdId); return "released"; }
        return "pending";
      }
      if (receipt) {
        const rawSpent = receipt.spent;
        const receiptChannel = receipt.channelId;
        const ref = receiptRef(receipt) ?? `mpp-session:${hold.channelId}:${String(rawSpent)}`;
        if (receiptChannel !== undefined && receiptChannel !== hold.channelId) return "pending";
        let spentMicro: bigint;
        try {
          if (typeof rawSpent !== "string" || !/^\d+$/.test(rawSpent)) return "pending";
          const cumulative = BigInt(rawSpent);
          spentMicro = tokenAmountToMicroUsdCeil(cumulative, hold.decimals);
        } catch { return "pending"; }
        const prev = hold.previousHighWaterMicro ?? 0n;
        const delta = spentMicro > prev ? spentMicro - prev : 0n;
        if (hold.voucherTotalMicro !== undefined && spentMicro > hold.voucherTotalMicro) return "pending";
        return ledger.commit(hold.holdId, ref, delta, hold.channelId, spentMicro) ? "committed" : "duplicate";
      }
      if ([409, 410, 429].includes(response.status)) { ledger.release(hold.holdId); return "released"; }
      return "pending";
    },
  };
}

/** Exact decimal-to-micro conversion for PaymentIntent amounts. */
export function mppUsdAmountToMicro(amount: string): bigint { return decimalToMicro(amount); }
