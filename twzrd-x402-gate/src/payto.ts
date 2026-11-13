import { solanaCluster, type SolanaCluster } from "./network.js";
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
  // A seller controls this array: anything that is not a list of objects is
  // no offer at all, never a TypeError out of the gate.
  const list = offerObjects(accepts);
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
/**
 * An amount that is present but is not an ASCII base-unit integer. Schemes
 * build the transfer from this string (x402-solana: BigInt(amount); spl-token
 * encodes a u64), so a sign, decimal point, exponent, whitespace or non-ASCII
 * digit has no safe reading. Refused on every entry point before intel (0.11.2).
 */
export const AMOUNT_MALFORMED = "amount_malformed";
/**
 * An SVM `exact` requirement that carries `extra.splits` (0.18.0). The x402
 * spec lets a Solana exact offer name up to 8 extra recipients with absolute
 * amounts while payTo keeps the remainder. The gate scores payTo only, so a
 * split would route money to recipients nobody scored: refused before intel
 * and before any signature, on every entry point that reads the requirement
 * through resolveRequirementFields. Mirrors the MPP splits refusal in
 * mpp-hook.ts.
 */
export const SVM_SPLITS_REFUSED = "svm_splits_refused";
/**
 * A recipient, asset or network that is present but is not a string (0.20.2).
 * The gate used to read these with `String(value)` or skip a non-string, while
 * the Solana clients read the raw value as a public key: `payTo: []` was
 * "no recipient" here and the all-zero key there, `payTo: ["<clean>"]` was
 * scored as the clean seller and paid to the zero key, and an `asset` given
 * as a 32-number array was "no asset named" here (so priced as USDC) and a
 * real mint there. A mistyped field is refused on every entry point that
 * reads the requirement through resolveRequirementFields, before intel and
 * before any signature. An amount that is not a string or a number is
 * `amount_malformed`.
 */
export const PAYTO_MALFORMED = "payto_malformed";
export const ASSET_MALFORMED = "asset_malformed";
export const NETWORK_MALFORMED = "network_malformed";
/**
 * The `batch-settlement` scheme is refused. The gate prices, caps and budgets
 * a payment by the requirement's `amount`. A batch-settlement client signs a
 * channel deposit instead: the seller's `extra.minDeposit` when it announces
 * one, otherwise a multiple of `amount` set in the client's own scheme config,
 * escrowed until the channel closes. Neither figure is visible to a check on
 * `amount`, so a 0.001 USDC quote could escrow 1 USDC under a 0.01 cap. The
 * scheme can also answer a refused channel by paying a different accepts[]
 * entry. Refused on every entry point that reads the requirement through
 * resolveRequirementFields, before intel and before any signature.
 */
export const BATCH_SETTLEMENT_REFUSED = "batch_settlement_refused";
export type RequirementFieldConflict =
  | typeof AMOUNT_FIELD_CONFLICT
  | typeof PAYTO_FIELD_CONFLICT
  | typeof AMOUNT_MALFORMED
  | typeof PAYTO_MALFORMED
  | typeof ASSET_MALFORMED
  | typeof NETWORK_MALFORMED
  | typeof BATCH_SETTLEMENT_REFUSED
  | typeof SVM_SPLITS_REFUSED;

/**
 * Whether a requirement is on Solana, read through the shared
 * `solanaCluster` (network.ts) so the splits detector cannot disagree with
 * classifyNetwork and the USDC table. That covers CAIP-2 `solana:<genesis>`
 * and legacy v1 names, plus bare cluster names (`mainnet-beta`, `devnet`,
 * `testnet`), bare genesis ids, and a missing network with a base58 payTo
 * (legacy integrators; an EVM `payTo` stays out of scope).
 */
function isSvmNetwork(network: unknown, payTo?: unknown): boolean {
  return (
    solanaCluster(
      typeof network === "string" ? network : undefined,
      typeof payTo === "string" ? payTo : undefined,
    ) !== undefined
  );
}

/**
 * True when an SVM exact requirement names extra recipients.
 * - A non-empty `extra.splits` array is refused.
 * - `extra.splits` present but not an array is malformed: refused (fail closed).
 * - An empty array, or no `splits` key, names no extra recipient: allowed.
 * A missing scheme on an SVM entry is read as `exact` (fail closed).
 * EVM requirements are not checked: x402 defines no splits for EVM exact, and
 * the EVM exact clients pay payTo only.
 */
export function hasSvmExactSplits(req: unknown): boolean {
  if (req === null || typeof req !== "object") return false;
  const r = req as Record<string, unknown>;
  if (!isSvmNetwork(r.network, r.payTo ?? r.pay_to)) return false;
  if (r.scheme != null && String(r.scheme).trim().toLowerCase() !== "exact") return false;
  const extra = r.extra;
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) return false;
  if (!Object.hasOwn(extra, "splits")) return false;
  const splits = (extra as Record<string, unknown>).splits;
  if (!Array.isArray(splits)) return true;
  return splits.length > 0;
}

/**
 * True when a requirement names the `batch-settlement` scheme. The name is
 * compared trimmed and lowercased, and a non-string scheme is read through
 * String(), so a spelling this function misses is one no client registers.
 */
export function isBatchSettlement(req: unknown): boolean {
  if (req === null || typeof req !== "object") return false;
  const scheme = (req as Record<string, unknown>).scheme;
  if (scheme == null) return false;
  return String(scheme).trim().toLowerCase() === "batch-settlement";
}

const BASE_UNIT_AMOUNT = /^[0-9]+$/;

/** True for an ASCII base-unit integer string: digits only, no sign or spaces. */
export function isBaseUnitAmount(amount: unknown): amount is string {
  return typeof amount === "string" && BASE_UNIT_AMOUNT.test(amount);
}

/** Entries of a seller-supplied accepts value that are plain objects. */
export function offerObjects(accepts: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(accepts)) return [];
  return accepts.filter(
    (e): e is Record<string, unknown> => e !== null && typeof e === "object" && !Array.isArray(e),
  );
}

function sameRecipient(a: string, b: string): boolean {
  // EVM addresses are case-insensitive (EIP-55 case is a checksum only);
  // Solana base58 is case-sensitive.
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function resolvePair(
  a: unknown,
  b: unknown,
  same: (x: string, y: string) => boolean = (x, y) => x === y,
): { value?: string; conflict: boolean } {
  const hasA = a != null;
  const hasB = b != null;
  if (hasA && hasB) {
    return same(String(a), String(b))
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
  // Type first. String(["1000"]) is "1000" and String([]) is "", so a value
  // that is not the type the wire format names is never coerced.
  const named = (v: unknown): boolean => v !== undefined && v !== null;
  const amountTyped = (v: unknown): boolean =>
    !named(v) || typeof v === "string" || typeof v === "number";
  const textTyped = (v: unknown): boolean => !named(v) || typeof v === "string";
  const amountMistyped = !amountTyped(r.amount) || !amountTyped(r.maxAmountRequired);
  const payToMistyped = !textTyped(r.payTo) || !textTyped(r.pay_to);
  const assetMistyped = !textTyped(r.asset);
  const networkMistyped = !textTyped(r.network);
  const none: { value?: string; conflict: boolean } = { conflict: false };
  const amt = amountMistyped ? none : resolvePair(r.amount, r.maxAmountRequired);
  const pay = payToMistyped ? none : resolvePair(r.payTo, r.pay_to, sameRecipient);
  const malformed = amountMistyped || (amt.value !== undefined && !isBaseUnitAmount(amt.value));
  return {
    payTo: pay.value,
    amount: malformed ? undefined : amt.value,
    conflict: amt.conflict
      ? AMOUNT_FIELD_CONFLICT
      : malformed
        ? AMOUNT_MALFORMED
        : payToMistyped
          ? PAYTO_MALFORMED
          : pay.conflict
            ? PAYTO_FIELD_CONFLICT
            : assetMistyped
              ? ASSET_MALFORMED
              : networkMistyped
                ? NETWORK_MALFORMED
                : isBatchSettlement(r)
                  ? BATCH_SETTLEMENT_REFUSED
                  : hasSvmExactSplits(r)
                    ? SVM_SPLITS_REFUSED
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

// Solana mints are base58 and case-sensitive: stored and compared exactly.
// EVM contracts are hex: stored lowercase and compared case-insensitively.
const SOLANA_USDC: Record<SolanaCluster, ReadonlySet<string>> = {
  mainnet: new Set([
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet USDC
  ]),
  // A devnet mint named on mainnet is some other token, and vice versa.
  devnet: new Set([
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet USDC (Circle; the @x402/svm default)
    "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", // devnet USDC (spl-token-faucet)
  ]),
  testnet: new Set(),
};
const EVM_USDC: Record<string, ReadonlySet<string>> = {
  "eip155:8453": new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
  ]),
  "eip155:84532": new Set([
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia test USDC
  ]),
};

function evmUsdcTable(networkRaw: unknown): ReadonlySet<string> | undefined {
  const network = String(networkRaw ?? "").trim().toLowerCase();
  if (network === "base" || network === "base-mainnet" || network === "eip155:8453") {
    return EVM_USDC["eip155:8453"];
  }
  if (network === "base-sepolia" || network === "eip155:84532") {
    return EVM_USDC["eip155:84532"];
  }
  return undefined;
}

/** True when the network has a USDC set the gate knows (Solana clusters, Base, Base Sepolia). */
export function hasUsdcTable(requirement: { network?: unknown; payTo?: unknown; pay_to?: unknown }): boolean {
  return (
    solanaCluster(requirement.network as string | undefined, recipientOf(requirement)) !== undefined ||
    evmUsdcTable(requirement.network) !== undefined
  );
}

function recipientOf(requirement: { payTo?: unknown; pay_to?: unknown }): string | undefined {
  const p = requirement.payTo ?? requirement.pay_to;
  return typeof p === "string" ? p : undefined;
}

/**
 * True when the requirement names a USDC mint/contract on its own network.
 * Unknown networks and any other asset are false. The Solana cluster comes
 * from solanaCluster (network.ts), the same reading classifyNetwork uses, so
 * a missing network with a base58 payTo, "mainnet-beta" or a bare genesis id
 * resolve to the mainnet mint (0.11.2).
 */
export function isUsdcRequirement(requirement: Record<string, unknown>): boolean {
  const asset = String(requirement.asset ?? "").trim();
  if (!asset) return false;
  const cluster = solanaCluster(requirement.network as string | undefined, recipientOf(requirement));
  if (cluster) return SOLANA_USDC[cluster].has(asset);
  const evm = evmUsdcTable(requirement.network);
  return evm ? evm.has(asset.toLowerCase()) : false;
}

/** The requirement's named asset, or undefined when none is named. */
export function requirementAsset(req: unknown): string | undefined {
  const a = (req as { asset?: unknown } | null | undefined)?.asset;
  return typeof a === "string" && a.trim() !== "" ? a : undefined;
}

export function priceUsdcFromAmountMicro(
  amountMicro: string | undefined,
  requirement?: { network?: unknown; asset?: unknown; payTo?: unknown; pay_to?: unknown },
): number | undefined {
  // Only an ASCII base-unit integer has a price. A sign, decimal point,
  // exponent or non-ASCII digit has no safe reading (0.11.2).
  if (!isBaseUnitAmount(amountMicro)) return undefined;
  // `amount` is in the named asset's base units. Dividing by 1e6 is only a USD
  // price when that asset is USDC (6 decimals, ~$1). A requirement that names
  // any other asset on a network with a known USDC set has no USD price here
  // (0.11.1). With no asset named the old reading stays: neither x402-solana
  // nor @x402/svm can build a transfer without a mint, so such a payment fails
  // before signing anyway. Networks with no USDC set keep the best-effort
  // reading; nothing on them is capped in USDC by the approval policy.
  if (
    requirement &&
    typeof requirement.asset === "string" &&
    requirement.asset.trim() !== "" &&
    hasUsdcTable(requirement) &&
    !isUsdcRequirement(requirement as Record<string, unknown>)
  ) {
    return undefined;
  }
  return Number(amountMicro) / 1_000_000;
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
