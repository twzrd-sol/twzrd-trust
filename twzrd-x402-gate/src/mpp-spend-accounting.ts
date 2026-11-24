import { randomUUID } from "node:crypto";
import { toMicroUsd } from "./intent.js";
import { DEFAULT_SPEND_LEDGER_FILE, sharedFileSpendLedger, tokenAmountToMicroUsdCeil, type FileSpendLedger } from "./spend-ledger-file.js";

export type MppSpendKind = "charge" | "session";
export type MppSpendHold = { holdId: string; scope: string; amountMicro: bigint; decimals: number; kind: MppSpendKind; channelId?: string; voucherTotalMicro?: bigint; previousHighWaterMicro?: bigint };
/**
 * `committed`: a receipt settled the hold. `duplicate`: the hold was already resolved, or its
 * receipt reused a counted reference (the hold is then counted at its own amount).
 * `released`: a hold never marked signed was freed by a failed response. `pending`: the hold
 * stays held and counted. A signed hold is never released: whatever the seller answers, it can
 * still settle a signed credential.
 */
export type MppSpendOutcome = "committed" | "released" | "pending" | "duplicate";
/**
 * Every method writes the shared spend ledger under its cross-process file lock
 * and resolves once the row is durable. Each rejects if the lock stays busy for
 * 3 s; `reserveCharge`/`reserveSession` also reject with `mpp_spend_cap_exceeded`.
 */
export type MppSpendAccounting = {
  reserveCharge(input: { scope?: string; amount: string; decimals: number; capMicro?: bigint; holdId?: string }): Promise<MppSpendHold>;
  reserveSession(input: { scope?: string; channelId: string; voucherTotalBaseUnits: string; decimals: number; capMicro?: bigint; holdId?: string }): Promise<MppSpendHold>;
  markSigned(hold: MppSpendHold): Promise<boolean>;
  recordResponse(hold: MppSpendHold, response: Response): Promise<MppSpendOutcome>;
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
  const DAY_MS = 24 * 60 * 60 * 1000;
  const makeHold = async (scope: string, amountMicro: bigint, decimals: number, capMicro: bigint | undefined, holdId: string, kind: MppSpendKind, channelId?: string, voucherTotalMicro?: bigint, previousHighWaterMicro?: bigint): Promise<MppSpendHold> => {
    const reserved = channelId && voucherTotalMicro !== undefined
      ? await ledger.reserveChannelAsync(scope, amountMicro, holdId, capMicro, DAY_MS, now(), channelId, voucherTotalMicro)
      : await ledger.reserveAsync(scope, amountMicro, holdId, capMicro, DAY_MS, now());
    if (!reserved) throw new Error("mpp_spend_cap_exceeded");
    return { holdId, scope, amountMicro, decimals, kind, ...(channelId ? { channelId } : {}), ...(voucherTotalMicro !== undefined ? { voucherTotalMicro } : {}), ...(previousHighWaterMicro !== undefined ? { previousHighWaterMicro } : {}) };
  };
  return {
    ledger,
    async reserveCharge({ scope = defaultScope, amount, decimals, capMicro, holdId = randomUUID() }) {
      if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) throw new TypeError("invalid MPP charge amount/decimals");
      return makeHold(scope, tokenAmountToMicroUsdCeil(BigInt(amount), decimals), decimals, capMicro, holdId, "charge");
    },
    async reserveSession({ scope = defaultScope, channelId, voucherTotalBaseUnits, decimals, capMicro, holdId = randomUUID() }) {
      if (!channelId || !/^\d+$/.test(voucherTotalBaseUnits) || !Number.isInteger(decimals) || decimals < 0) throw new TypeError("invalid MPP session voucher amount/decimals");
      // Compute against settled high-water. Concurrent uncommitted vouchers
      // reserve conservatively from the same settled point; if one is rejected,
      // another cannot have under-reserved its eventual cumulative spend. The
      // commit re-derives the delta from the high-water under the lock.
      const previous = ledger.highestSpentMicroByChannel(channelId);
      const total = tokenAmountToMicroUsdCeil(BigInt(voucherTotalBaseUnits), decimals);
      const delta = total > previous ? total - previous : 0n;
      return makeHold(scope, delta, decimals, capMicro, holdId, "session", channelId, total, previous);
    },
    markSigned(hold) { return ledger.markSignedAsync(hold.holdId); },
    async recordResponse(hold, response) {
      const receipt = headerReceipt(response);
      if (hold.kind === "charge") {
        const ref = receipt && receiptRef(receipt);
        if (receipt && ref) return await ledger.commitAsync(hold.holdId, ref) ? "committed" : "duplicate";
        if (!response.ok && !receipt) return await ledger.releaseAsync(hold.holdId) ? "released" : "pending";
        return "pending";
      }
      if (receipt) {
        const rawSpent = receipt.spent;
        const receiptChannel = receipt.channelId;
        if (receiptChannel !== undefined && receiptChannel !== hold.channelId) return "pending";
        let spentMicro: bigint;
        try {
          if (typeof rawSpent !== "string" || !/^\d+$/.test(rawSpent)) return "pending";
          spentMicro = tokenAmountToMicroUsdCeil(BigInt(rawSpent), hold.decimals);
        } catch { return "pending"; }
        if (hold.voucherTotalMicro !== undefined && spentMicro > hold.voucherTotalMicro) return "pending";
        // The seller can redeem the whole signed voucher, so the channel high-water is the larger of
        // the signed total and the receipt's `spent`: a receipt reporting less cannot lower the
        // spend other channels and charges in the same cap see.
        const counted = hold.voucherTotalMicro !== undefined && hold.voucherTotalMicro > spentMicro ? hold.voucherTotalMicro : spentMicro;
        const prev = hold.previousHighWaterMicro ?? 0n;
        const delta = counted > prev ? counted - prev : 0n;
        // Session receipts are cumulative. Their idempotency key is the hold
        // resolution plus channel high-water, not a potentially channel-wide
        // `reference` reused across vouchers.
        return await ledger.commitAsync(hold.holdId, undefined, delta, hold.channelId, counted) ? "committed" : "duplicate";
      }
      if ([409, 410, 429].includes(response.status)) return await ledger.releaseAsync(hold.holdId) ? "released" : "pending";
      return "pending";
    },
  };
}

/** Exact decimal-to-micro conversion for PaymentIntent amounts. */
export function mppUsdAmountToMicro(amount: string): bigint { return decimalToMicro(amount); }
