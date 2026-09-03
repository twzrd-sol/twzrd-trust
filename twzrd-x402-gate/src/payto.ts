import type { X402PaymentRequiredBody, X402PaymentRequirements } from "./types.js";

/**
 * Pick the best payment requirements from an x402 accepts[] array.
 * Prefers the Solana-network entry when multiple networks are listed
 * (e.g. CDP 402 bodies list EVM first, Solana second).
 */
/**
 * TWZRD's own facilitator fee payer (== its GET /supported feePayer). Exported so
 * a caller can pass `preferFeePayer: TWZRD_FEE_PAYER`, or set the env alias
 * `TWZRD_PREFER_FEE_PAYER=twzrd`.
 */
export const TWZRD_FEE_PAYER =
  "4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE";

function feePayerOf(e: Record<string, unknown>): string | undefined {
  const extra = e.extra as Record<string, unknown> | undefined;
  const fp = extra?.feePayer ?? (e as Record<string, unknown>).feePayer;
  return typeof fp === "string" ? fp : undefined;
}

/**
 * Resolve the preferred fee payer: explicit option first, then the
 * `TWZRD_PREFER_FEE_PAYER` env var (the literal alias `twzrd` maps to
 * `TWZRD_FEE_PAYER`), else none.
 */
function resolvePreferFeePayer(explicit?: string): string | undefined {
  const raw =
    explicit ??
    (typeof process !== "undefined"
      ? process.env?.TWZRD_PREFER_FEE_PAYER
      : undefined);
  if (!raw) return undefined;
  return raw.toLowerCase() === "twzrd" ? TWZRD_FEE_PAYER : raw;
}

export function pickRequirements(
  accepts?: Array<Record<string, unknown>>,
  opts?: { preferFeePayer?: string },
): X402PaymentRequirements {
  const list = accepts ?? [];
  const isSolana = (e: Record<string, unknown>) =>
    String(e.network ?? "").toLowerCase().includes("solana");
  // Prefer mainnet: bare "solana", "mainnet" substring, or CAIP-2 with mainnet genesis prefix.
  const isMainnet = (e: Record<string, unknown>) => {
    const n = String(e.network ?? "").toLowerCase();
    return n === "solana" || n.includes("mainnet") || n.includes("5eykt4");
  };
  // Fee-payer preference (W2): when a seller multi-lists facilitators in accepts[]
  // (e.g. Dexter + TWZRD), route settlement to the preferred fee payer by SELECTING
  // the matching entry the seller already offers. This never adds, rewrites, or
  // forces an accepts entry onto the seller's 402 — if no offered entry matches, it
  // falls through to the normal network preference below. Only applies within
  // Solana mainnet, where the preferred fee payer is valid.
  const prefer = resolvePreferFeePayer(opts?.preferFeePayer);
  if (prefer) {
    const preferred = list.find(
      (e) => isSolana(e) && isMainnet(e) && feePayerOf(e) === prefer,
    );
    if (preferred) return preferred as X402PaymentRequirements;
  }
  const solanaMainnet = list.find((e) => isSolana(e) && isMainnet(e));
  const solanaAny = list.find(isSolana);
  return (solanaMainnet ?? solanaAny ?? list[0] ?? {}) as X402PaymentRequirements;
}

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

/**
 * AUDIT FIX: read the 402 challenge the way @x402/core's client does —
 * `PAYMENT-REQUIRED` header (base64 JSON, x402 v2) FIRST, then a JSON body.
 * The fetch adapters used to read only the body, so a header-carried
 * challenge (empty / decoy body) reached the payer unscored.
 *   - header present but undecodable -> throws (fail closed: the payer may
 *     still decode it; never hand it over unscored)
 *   - no header, unparseable body    -> null (caller decides; @x402/fetch
 *     itself throws "Invalid payment required response" on that shape)
 */
export async function paymentRequiredFromResponse(
  resp: Response,
): Promise<X402PaymentRequiredBody | null> {
  const header = resp.headers.get("PAYMENT-REQUIRED");
  if (header) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      throw new Error("[twzrd] payment blocked: undecodable PAYMENT-REQUIRED header");
    }
    if (!decoded || typeof decoded !== "object") {
      throw new Error("[twzrd] payment blocked: PAYMENT-REQUIRED header is not an object");
    }
    return decoded as X402PaymentRequiredBody;
  }
  try {
    return (await resp.clone().json()) as X402PaymentRequiredBody;
  } catch {
    return null;
  }
}
