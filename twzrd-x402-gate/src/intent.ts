/**
 * TWZRD Payment Control — PaymentIntent v1 (FROZEN).
 *
 * The canonical, protocol-neutral description of one autonomous payment,
 * evaluated exactly once at the last deterministic checkpoint before signing.
 *
 * Defining invariant (honest scope): a signer path that calls
 * assertIntentApproved will not sign an intent that differs from what TWZRD
 * evaluated. TWZRD does not own third-party wallets - the binding holds
 * exactly where the check runs before the signer. Everything that
 * identifies the transaction — payee, resource, amount, asset, network,
 * facilitator, method, mandate, recurrence context — is bound into ONE
 * canonical intent hash. `hash(intent being signed) === decision.intentHash`
 * or the wallet refuses.
 *
 * v1 is frozen: field additions require a new hash prefix (tiv2:), never a
 * silent change to canonicalization.
 */

import { createHash } from "node:crypto";

export type PaymentProtocol = "x402" | "ap2" | "ucp" | "mpp" | "direct";

export type PaymentIntent = {
  protocol: PaymentProtocol;
  /** CAIP-2 where applicable (e.g. "solana:5eykt4...", "eip155:8453"). */
  network: string;
  /** Asset identifier (mint / contract / ISO code for fiat-denominated mandates). */
  asset: string;
  /** Decimal string. Money is NEVER a float. */
  amount: string;
  /** Receiving counterparty (wallet, contract, merchant account). */
  payTo: string;

  resource?: {
    url?: string;
    method?: string;
    operation?: string;
    /** Hash of the exact request body when the resource is request-bound. */
    requestHash?: string;
  };

  facilitator?: string;

  agent?: {
    id?: string;
    organization?: string;
    mandateId?: string;
  };

  context?: {
    purpose?: string;
    recurring?: boolean;
    /** Prior charge for this recurring counterparty, decimal string. */
    priorSpend?: string;
    /** ISO-8601 expiry of the intent itself. */
    expiresAt?: string;
  };
};

export const INTENT_HASH_PREFIX = "tiv1:";
const INTENT_DOMAIN = "twzrd-intent-v1\n";

/**
 * Canonical JSON (frozen with v1):
 * - object keys sorted lexicographically (code-unit order)
 * - `undefined` and `null` members omitted
 * - arrays keep order; `undefined`/`null` elements are rejected
 * - numbers must be finite (money fields are strings by type)
 * - no insignificant whitespace
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error("[twzrd] canonicalJson: top-level null/undefined");
  }
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error("[twzrd] canonicalJson: null/undefined array element");
  }
  const t = typeof value;
  if (t === "string" || t === "boolean") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("[twzrd] canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`[twzrd] canonicalJson: unsupported type ${t}`);
}

/** sha256 over the domain-separated canonical form, `tiv1:`-prefixed hex. */
export function intentHash(intent: PaymentIntent): string {
  const canonical = canonicalJson(intent);
  const digest = createHash("sha256")
    .update(INTENT_DOMAIN)
    .update(canonical)
    .digest("hex");
  return `${INTENT_HASH_PREFIX}${digest}`;
}

/**
 * Parse a decimal money string into micro-units (6dp) as bigint.
 * Rejects floats-by-stealth: only `[digits].[<=6 digits]` accepted.
 */
export function toMicroUsd(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new Error(`[twzrd] bad decimal amount: ${JSON.stringify(amount)}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return whole * 1_000_000n + frac;
}

/**
 * Micro-units (6dp) → decimal string. Trims trailing fractional zeros so
 * `1000000n` → `"1"` and `10000n` → `"0.01"` (stable for budget remaining).
 */
export function fromMicroUsd(micro: bigint): string {
  if (micro < 0n) {
    throw new Error(`[twzrd] fromMicroUsd: negative micro ${micro}`);
  }
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}
