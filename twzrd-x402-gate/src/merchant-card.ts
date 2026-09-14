/**
 * Free merchant card client — wash refuse default for buyer agents.
 *
 * GET /v1/intel/merchant_card/{wallet} is free, no auth.
 *
 * `fetchMerchantCard` returns null for BOTH "intel answered and carries no
 * wash signal" and "intel was unreachable". Those are different facts and the
 * caller needs to tell them apart: the first is a genuine unknown that must
 * fail open (we do not invent wash_flagged), the second is an outage, which is
 * precisely what `failOpen` exists to decide. Collapsing them made the
 * configured `failOpen` unreachable on this path — the error was caught here
 * and turned into an allow before the caller's fail-closed branch could ever
 * see it (BlockRunAI/ClawRouter v0.12.278 removal notes, 2026-09-07:
 * "converts a fast lookup failure into allow internally, and ignores the
 * failOpen we pass").
 *
 * `fetchMerchantCardResult` reports which of the two happened.
 * `fetchMerchantCard` keeps its original signature and is unchanged for
 * existing callers.
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

/**
 * `reachable: true` means intel answered — a JSON object, or a 4xx that is the
 * service saying "nothing for this wallet". `card` may still carry no
 * wash_flagged, which is a real unknown and fails open.
 * `reachable: false` means the lookup itself did not complete: 5xx, 429, a
 * body that is not a JSON object, or a thrown fetch (network, abort, timeout).
 */
export type MerchantCardLookup =
  | { reachable: true; card: TwzrdMerchantCard | null }
  | { reachable: false; card: null; error: string };

export async function fetchMerchantCardResult(
  wallet: string,
  opts: { intelBase: string; fetch: typeof fetch },
): Promise<MerchantCardLookup> {
  const w = (wallet || "").trim();
  // No wallet to ask about is not an outage — there is nothing to look up.
  if (!w) return { reachable: true, card: null };
  try {
    const url = `${opts.intelBase.replace(/\/+$/, "")}/v1/intel/merchant_card/${encodeURIComponent(w)}`;
    const resp = await opts.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      // Only a SERVICE failure is an outage. 5xx/429 mean intel could not
      // answer; failOpen decides those. A 4xx means it DID answer and has
      // nothing for us (or we asked badly) -- live intel returns 200 +
      // wash_flagged:null + decision:"insufficient_evidence" for a wallet with
      // no observed demand, and 400 for a malformed address, so a 4xx is never
      // "the gate is down". Treating it as one would refuse every unscored
      // recipient under the default, which is the over-refusal that got the
      // gate removed downstream, not the outage failOpen exists for.
      if (resp.status >= 500 || resp.status === 429) {
        return { reachable: false, card: null, error: `http_${resp.status}` };
      }
      return { reachable: true, card: null };
    }
    let body: TwzrdMerchantCard;
    try {
      body = (await resp.json()) as TwzrdMerchantCard;
    } catch {
      // 200 with a non-JSON body (captive portal, proxy error page).
      return { reachable: false, card: null, error: "bad_json" };
    }
    if (!body || typeof body !== "object") {
      return { reachable: false, card: null, error: "bad_json" };
    }
    return { reachable: true, card: body };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 80);
    return { reachable: false, card: null, error: `fetch_failed (${msg})` };
  }
}

/** Unchanged signature: null for both an unreachable lookup and no card. */
export async function fetchMerchantCard(
  wallet: string,
  opts: { intelBase: string; fetch: typeof fetch },
): Promise<TwzrdMerchantCard | null> {
  return (await fetchMerchantCardResult(wallet, opts)).card;
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
