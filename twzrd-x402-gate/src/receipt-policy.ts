/**
 * Host-configurable Path A receipt policy (V6 / $0.05 trust endpoint).
 *
 * Free preflight still decides allow|warn|block. This policy only decides when
 * the host should auto-purchase a paid portable receipt, and whether failure
 * of that purchase should harden into a deny (true incentive loop).
 */

import type { TwzrdDecision } from "./types.js";

/** Default spend threshold (USD) above which Path A is required when enabled. */
export const DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC = 10;

export type RequireReceiptPolicy = {
  /**
   * Auto-require Path A when resource `priceUsdc` is strictly greater than this.
   * Default: 10. Set to 0 to treat any positive price as high-value.
   */
  minSpendUsdc?: number;
  /**
   * When true (default), also require Path A on free preflight `decision === "warn"`.
   * Never requires on `block` (free refuse stays free).
   */
  onWarn?: boolean;
  /**
   * When true (default), deny/abort the merchant payment if Path A cannot be
   * obtained. When false, soft upsell: attempt purchase but allow proceed.
   */
  hard?: boolean;
};

export type ResolvedRequireReceiptPolicy = {
  minSpendUsdc: number;
  onWarn: boolean;
  hard: boolean;
};

/**
 * Normalize host config: `true` → defaults; object → merge defaults; false/omit → null.
 */
export function resolveRequireReceiptPolicy(
  raw: boolean | RequireReceiptPolicy | undefined,
): ResolvedRequireReceiptPolicy | null {
  if (raw === undefined || raw === false) return null;
  if (raw === true) {
    return {
      minSpendUsdc: DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC,
      onWarn: true,
      hard: true,
    };
  }
  return {
    minSpendUsdc:
      typeof raw.minSpendUsdc === "number" && Number.isFinite(raw.minSpendUsdc)
        ? raw.minSpendUsdc
        : DEFAULT_REQUIRE_RECEIPT_MIN_SPEND_USDC,
    onWarn: raw.onWarn !== false,
    hard: raw.hard !== false,
  };
}

/**
 * Whether Path A should run for this free decision + resource price.
 * Never for `block` (and not for non-proceeding unknown/block paths).
 */
export function shouldRequirePathAReceipt(input: {
  policy: ResolvedRequireReceiptPolicy | null;
  decision: TwzrdDecision | "unknown" | string | null | undefined;
  priceUsdc?: number | null;
}): boolean {
  const { policy } = input;
  if (!policy) return false;
  const decision = input.decision ?? "unknown";
  if (decision === "block") return false;

  const price =
    typeof input.priceUsdc === "number" && Number.isFinite(input.priceUsdc)
      ? input.priceUsdc
      : null;

  if (price !== null && price > policy.minSpendUsdc) return true;
  if (policy.onWarn && decision === "warn") return true;
  return false;
}

/**
 * Whether to attempt Path A purchase (explicit autoReceipt or threshold trigger).
 * Still never on block.
 */
export function shouldAttemptPathAReceipt(input: {
  autoReceipt?: boolean;
  requireReceipt?: boolean | RequireReceiptPolicy;
  decision: TwzrdDecision | "unknown" | string | null | undefined;
  priceUsdc?: number | null;
}): boolean {
  const decision = input.decision ?? "unknown";
  if (decision === "block") return false;

  if (input.autoReceipt) return true;

  const policy = resolveRequireReceiptPolicy(input.requireReceipt);
  return shouldRequirePathAReceipt({
    policy,
    decision,
    priceUsdc: input.priceUsdc,
  });
}
