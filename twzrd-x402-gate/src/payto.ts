import type { X402PaymentRequirements } from "./types.js";

export function payToFromRequirements(req: X402PaymentRequirements): {
  payTo: string | undefined;
  amountMicro: string | undefined;
  resource: string | undefined;
} {
  const payTo = req.payTo ?? req.pay_to;
  const amountMicro = req.maxAmountRequired ?? req.amount;
  return { payTo, amountMicro, resource: req.resource };
}

export function priceUsdcFromAmountMicro(
  amountMicro: string | undefined,
): number | undefined {
  if (amountMicro == null || amountMicro === "") return undefined;
  const n = Number(amountMicro);
  if (!Number.isFinite(n)) return undefined;
  return n / 1_000_000;
}
