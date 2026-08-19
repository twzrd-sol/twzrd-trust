/**
 * Free merchant card client — wash refuse default for buyer agents.
 *
 * GET /v1/intel/merchant_card/{wallet} is free, no auth. Fail-open: network /
 * non-2xx / invalid JSON → null (do not invent wash_flagged).
 */

export type TwzrdMerchantCard = {
  merchant?: string;
  wash_flagged?: boolean;
  wash_label?: string | null;
  provider_reputation_tier?: string | null;
  in_corpus?: boolean;
  catalog_enriched?: boolean;
  [key: string]: unknown;
};

export async function fetchMerchantCard(
  wallet: string,
  opts: { intelBase: string; fetch: typeof fetch },
): Promise<TwzrdMerchantCard | null> {
  const w = (wallet || "").trim();
  if (!w) return null;
  try {
    const url = `${opts.intelBase.replace(/\/+$/, "")}/v1/intel/merchant_card/${encodeURIComponent(w)}`;
    const resp = await opts.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as TwzrdMerchantCard;
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  }
}

export type WashPolicyInput = {
  /** Prior approval from readiness / preflight policy */
  approved: boolean;
  reason: string;
  /** From free merchant_card.wash_flagged; null/undefined = signal unavailable */
  washFlagged: boolean | null | undefined;
  /** Resource price in USDC when known */
  priceUsdc?: number | null;
  /**
   * When true (default), refuse payment if washFlagged === true.
   * When false, ignore the wash signal.
   */
  refuseWashFlagged: boolean;
  /**
   * Soft alternative to hard refuse: if wash_flagged and priceUsdc <= washMaxUsdc,
   * allow with reason twzrd_wash_capped. If wash_flagged and price above cap (or
   * price unknown), refuse. Only applies when refuseWashFlagged is true and
   * washMaxUsdc is a finite number >= 0.
   */
  washMaxUsdc?: number | null;
};

export type WashPolicyResult = {
  approved: boolean;
  reason: string;
  washFlagged: boolean | null;
  washCapped?: boolean;
};

/**
 * Pure wash policy. Only tightens: never turns a prior deny into allow.
 * Fail-open on missing wash signal (null/undefined) — no invent.
 */
export function applyWashFlaggedPolicy(input: WashPolicyInput): WashPolicyResult {
  const washFlagged =
    typeof input.washFlagged === "boolean" ? input.washFlagged : null;

  if (!input.approved) {
    return { approved: false, reason: input.reason, washFlagged };
  }
  if (!input.refuseWashFlagged || washFlagged !== true) {
    return { approved: true, reason: input.reason, washFlagged };
  }

  const cap =
    typeof input.washMaxUsdc === "number" && Number.isFinite(input.washMaxUsdc)
      ? input.washMaxUsdc
      : null;

  if (cap != null) {
    const price =
      typeof input.priceUsdc === "number" && Number.isFinite(input.priceUsdc)
        ? input.priceUsdc
        : null;
    if (price != null && price <= cap) {
      return {
        approved: true,
        reason: `twzrd_wash_capped_${price}_le_${cap}`,
        washFlagged: true,
        washCapped: true,
      };
    }
    return {
      approved: false,
      reason:
        price == null
          ? `twzrd_wash_flagged_above_cap_unknown_price_max_${cap}`
          : `twzrd_wash_flagged_above_cap_${price}_gt_${cap}`,
      washFlagged: true,
    };
  }

  return {
    approved: false,
    reason: "twzrd_wash_flagged",
    washFlagged: true,
  };
}
