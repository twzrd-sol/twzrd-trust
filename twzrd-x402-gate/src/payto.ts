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

/**
 * x402 v1 prices an offer with `maxAmountRequired`, v2 with `amount`, and a
 * client pays the field of ITS OWN version (@x402/svm exact v2 builds the
 * transfer from `requirements.amount`). The seller controls both fields and
 * `x402Version`, so an entry carrying both with different values has no single
 * price: a gate that caps one field approves what the client pays from the
 * other. Such an entry is refused, never resolved by precedence - this package
 * had both precedences at once (v1-first here, v2-first in resource-bind,
 * wash-default, payment-decision, intent-adapters, x402-client-hook).
 * Both present and equal (dual-emit, e.g. TWZRD's own 402s) is fine.
 * Same rule for `payTo` / `pay_to`.
 */
export const AMOUNT_FIELD_CONFLICT = "amount_field_conflict";
export const PAYTO_FIELD_CONFLICT = "payto_field_conflict";
export type RequirementFieldConflict =
  | typeof AMOUNT_FIELD_CONFLICT
  | typeof PAYTO_FIELD_CONFLICT;

function resolvePair(a: unknown, b: unknown): { value?: string; conflict: boolean } {
  const hasA = a != null;
  const hasB = b != null;
  if (hasA && hasB) {
    return String(a) === String(b)
      ? { value: String(a), conflict: false }
      : { conflict: true };
  }
  if (hasA) return { value: String(a), conflict: false };
  if (hasB) return { value: String(b), conflict: false };
  return { conflict: false };
}

/**
 * The one reader of an accepts[] entry's recipient and price. A conflicted
 * field comes back undefined AND `conflict` is set; callers must refuse on
 * `conflict` explicitly - some paths fail OPEN on a merely missing field.
 */
export function resolveRequirementFields(req: unknown): {
  payTo: string | undefined;
  amount: string | undefined;
  conflict: RequirementFieldConflict | undefined;
} {
  const r = (req ?? {}) as Record<string, unknown>;
  const amt = resolvePair(r.amount, r.maxAmountRequired);
  const pay = resolvePair(r.payTo, r.pay_to);
  return {
    payTo: pay.value,
    amount: amt.value,
    conflict: amt.conflict
      ? AMOUNT_FIELD_CONFLICT
      : pay.conflict
        ? PAYTO_FIELD_CONFLICT
        : undefined,
  };
}

export function payToFromRequirements(req: X402PaymentRequirements): {
  payTo: string | undefined;
  amountMicro: string | undefined;
  resource: string | undefined;
  conflict: RequirementFieldConflict | undefined;
} {
  const f = resolveRequirementFields(req);
  return { payTo: f.payTo, amountMicro: f.amount, resource: req.resource, conflict: f.conflict };
}

const USDC_ASSETS: Record<string, ReadonlySet<string>> = {
  // Mints are per cluster: a devnet mint address named on mainnet is some other
  // token, so it must not be priced against a USDC cap there.
  "solana-mainnet": new Set([
    "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // mainnet USDC
  ]),
  "solana-devnet": new Set([
    "4zmmc9srt5ri5x14gagxhahii3gnpaeerypjgzjdncdu", // devnet USDC (Circle; the @x402/svm default)
    "gh9zwemdlj8dsckntktqpbnwlnnbjuszag9vp2kgtkjr", // devnet USDC (spl-token-faucet)
  ]),
  "eip155:8453": new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
  ]),
  "eip155:84532": new Set([
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia test USDC
  ]),
};

/**
 * True when the requirement names a USDC mint/contract on its own network.
 * Unknown networks and any other asset are false. Exported so every path
 * prices a requirement the same way (0.11.1).
 */
export function isUsdcRequirement(requirement: Record<string, unknown>): boolean {
  const table = usdcTableFor(requirement.network);
  if (!table) return false;
  return table.has(String(requirement.asset ?? "").toLowerCase());
}

/**
 * The USDC set for a network the gate knows (Solana clusters, Base, Base
 * Sepolia), or undefined for any other network.
 */
function usdcTableFor(networkRaw: unknown): ReadonlySet<string> | undefined {
  const network = String(networkRaw ?? "").toLowerCase();
  if (network === "solana-devnet" || network === "solana:etwtrabzayq6imfeykouru166vu2xqa1") {
    return USDC_ASSETS["solana-devnet"];
  }
  if (network === "solana" || network.startsWith("solana")) {
    return USDC_ASSETS["solana-mainnet"];
  }
  if (network === "base" || network === "base-mainnet" || network === "eip155:8453") {
    return USDC_ASSETS["eip155:8453"];
  }
  if (network === "base-sepolia" || network === "eip155:84532") {
    return USDC_ASSETS["eip155:84532"];
  }
  return undefined;
}

/** The requirement's named asset, or undefined when none is named. */
export function requirementAsset(req: unknown): string | undefined {
  const a = (req as { asset?: unknown } | null | undefined)?.asset;
  return typeof a === "string" && a.trim() !== "" ? a : undefined;
}

export function priceUsdcFromAmountMicro(
  amountMicro: string | undefined,
  requirement?: { network?: unknown; asset?: unknown },
): number | undefined {
  if (amountMicro == null || amountMicro === "") return undefined;
  // `amount` is in the named asset's base units. Dividing by 1e6 is only a USD
  // price when that asset is USDC (6 decimals, ~$1). A requirement that names
  // any other asset has no known USD price: returning amount/1e6 let a seller
  // name an 8-decimal mint and have a real 0.001-token transfer read as $0.10,
  // inside the unevaluated-seller cap (0.11.1). No asset named keeps the old
  // reading, because the x402 schemes default an unnamed asset to USDC. Only
  // networks with a known USDC set are checked; other (unscored) networks keep
  // the old best-effort reading, since nothing there is capped in USDC.
  if (
    requirement &&
    typeof requirement.asset === "string" &&
    requirement.asset.trim() !== "" &&
    usdcTableFor(requirement.network) !== undefined &&
    !isUsdcRequirement(requirement as Record<string, unknown>)
  ) {
    return undefined;
  }
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
