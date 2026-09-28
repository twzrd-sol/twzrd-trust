/**
 * Edge-safe Base x402 preflight gate.
 *
 * This module is intentionally standalone: it imports no package code and uses
 * only Fetch/Web-standard APIs, so Workers can import `twzrd-x402-gate/cloudflare-base`
 * without bringing Node modules or Solana adapters into their bundle.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = `eip155:${BASE_CHAIN_ID}`;

export type CloudflareBaseRequirements = {
  resource?: string;
  accepts?: Array<Record<string, unknown>>;
};

export type BasePreflightVerdict = {
  decision: "allow" | "warn" | "block";
  /** TWZRD's current preflight calls this trust_score; normalized here for callers. */
  riskScore: number | null;
  reasons: string[];
  /** Free preflight fields the signing rules below read (0.11.2). */
  nullReason?: string | null;
  scoreIsNull?: boolean;
  recommendedCapUsdc?: number | null;
  washFlagged?: boolean | null;
};

/** Base mainnet USDC. The only asset this module signs for. */
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export type CloudflareBaseGateOptions = {
  intelBase?: string;
  fetch?: typeof fetch;
  /**
   * Ignored for the signing decision since 0.11.2: the price is read from the
   * Base USDC entry's own `amount`, so a caller cannot understate it.
   * @deprecated
   */
  priceUsdc?: number;
  /** Refuse an evaluated seller scoring below this (default 40, same as the package). */
  preflightMinScore?: number;
  /** Refuse every seller intel has never evaluated (same as the package option). */
  refuseUnevaluated?: boolean;
  resourceName?: string;
  agentIntent?: string;
  /** Default false: an unavailable or malformed preflight does not permit signing. */
  failOpen?: boolean;
};

export class TwzrdBasePaymentBlockedError extends Error {
  readonly verdict: BasePreflightVerdict;

  constructor(verdict: BasePreflightVerdict) {
    super(`[twzrd] Base payment blocked: ${verdict.reasons.join(",") || "PREFLIGHT_BLOCK"}`);
    this.name = "TwzrdBasePaymentBlockedError";
    this.verdict = verdict;
  }
}

/**
 * Calls the live TWZRD preflight with an exact Base mainnet payTo.
 *
 * Both lowercase and checksummed EVM addresses are valid inputs. The address is
 * preserved as received; the endpoint evaluates the exact recipient the client
 * is about to authorize.
 */
export async function twzrdBasePreflight(
  requirements: CloudflareBaseRequirements,
  options: CloudflareBaseGateOptions = {},
): Promise<BasePreflightVerdict> {
  const { payTo, priceUsdc } = baseOffer(requirements);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("[twzrd] Worker fetch is unavailable");

  const intelBase = (options.intelBase ?? "https://intel.twzrd.xyz").replace(/\/+$/, "");
  const response = await fetchFn(`${intelBase}/v1/intel/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resource_name: options.resourceName ?? requirements.resource ?? "cloudflare_base_x402",
      resource_url: requirements.resource,
      seller_wallet: payTo,
      price_usdc: priceUsdc,
      agent_intent: options.agentIntent ?? "cloudflare_base_x402_preflight",
      chain: "base",
      chain_id: BASE_CHAIN_ID,
    }),
  });
  if (!response.ok) throw new Error(`[twzrd] Base preflight HTTP ${response.status}`);
  return normalizePreflight(await response.json());
}

/** Cloudflare `withX402Client` callback: true permits the retry; false aborts it. */
export function createTwzrdCloudflareBaseApproval(
  options: CloudflareBaseGateOptions = {},
): (requirements: CloudflareBaseRequirements) => Promise<boolean> {
  return async (requirements) => {
    let offer: { payTo: string; priceUsdc: number };
    try {
      offer = baseOffer(requirements);
    } catch {
      // A malformed or non-USDC offer is not an outage: failOpen never signs it.
      return false;
    }
    try {
      const verdict = await twzrdBasePreflight(requirements, options);
      return baseRefusal(verdict, offer.priceUsdc, options) === undefined;
    } catch {
      return options.failOpen === true;
    }
  };
}

/**
 * Minimal signing interceptor for a Worker or Viem account. The callback is
 * invoked only when the Base USDC offer passes the package's signing rules:
 * not blocked, not wash-flagged, a never-evaluated seller within its cap, an
 * evaluated seller at or above the score floor and within its cap (0.11.2).
 */
export async function withTwzrdBasePreflight<T>(
  requirements: CloudflareBaseRequirements,
  options: CloudflareBaseGateOptions,
  signOrSend: () => Promise<T>,
): Promise<T> {
  // Offer shape first: a malformed amount or non-USDC asset is refused before
  // intel and is never an outage for failOpen to wave through (0.11.2).
  let offer: { payTo: string; priceUsdc: number };
  try {
    offer = baseOffer(requirements);
  } catch (error) {
    throw new TwzrdBasePaymentBlockedError({
      decision: "block",
      riskScore: null,
      reasons: [refusalCode(error)],
    });
  }
  let verdict: BasePreflightVerdict;
  try {
    verdict = await twzrdBasePreflight(requirements, options);
  } catch (error) {
    if (options.failOpen === true) return signOrSend();
    throw error;
  }
  const refusal = baseRefusal(verdict, offer.priceUsdc, options);
  if (refusal) {
    throw new TwzrdBasePaymentBlockedError({ ...verdict, reasons: [refusal, ...verdict.reasons] });
  }
  return signOrSend();
}

class OfferRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function refusalCode(error: unknown): string {
  return error instanceof OfferRefusal ? error.code : "invalid_base_offer";
}

/**
 * The Base entry the Worker will sign, with its price. Same rules as the rest
 * of the package, restated here because this module imports nothing:
 * the amount is an ASCII base-unit integer, the asset is Base USDC (or unnamed,
 * which the exact EVM scheme resolves to USDC), and v1/v2 duplicates agree.
 */
function baseOffer(requirements: CloudflareBaseRequirements): { payTo: string; priceUsdc: number } {
  const accepts = Array.isArray(requirements.accepts) ? requirements.accepts : [];
  const accept = accepts.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const network = candidate.network;
    const chainId = candidate.chainId ?? candidate.chain_id;
    return network === BASE_NETWORK || chainId === BASE_CHAIN_ID || chainId === String(BASE_CHAIN_ID);
  });
  const payTo = accept?.payTo ?? accept?.pay_to;
  if (typeof payTo !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new OfferRefusal("twzrd_unidentifiable_payment_recipient", "[twzrd] Base x402 requirements lack a valid eip155:8453 payTo");
  }
  const a = accept?.amount;
  const m = accept?.maxAmountRequired;
  if (a != null && m != null && String(a) !== String(m)) {
    throw new OfferRefusal("amount_field_conflict", "[twzrd] Base offer amount and maxAmountRequired disagree");
  }
  const amount = a ?? m;
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) {
    throw new OfferRefusal("amount_malformed", "[twzrd] Base offer amount is not a base-unit integer");
  }
  const asset = accept?.asset;
  if (asset != null && String(asset).toLowerCase() !== BASE_USDC) {
    throw new OfferRefusal("twzrd_non_usdc_asset", "[twzrd] Base offer names an asset other than USDC");
  }
  return { payTo, priceUsdc: Number(amount) / 1_000_000 };
}

/**
 * The package's signing rules applied to a Base preflight card (0.11.2).
 * Before 0.11.2 this module signed on any non-block verdict.
 */
export function baseRefusal(
  verdict: BasePreflightVerdict,
  priceUsdc: number,
  options: Pick<CloudflareBaseGateOptions, "preflightMinScore" | "refuseUnevaluated"> = {},
): string | undefined {
  if (verdict.decision === "block") return "twzrd_decision_block";
  if (verdict.washFlagged === true) return "twzrd_wash_flagged";
  const cap =
    typeof verdict.recommendedCapUsdc === "number" && Number.isFinite(verdict.recommendedCapUsdc) && verdict.recommendedCapUsdc >= 0
      ? verdict.recommendedCapUsdc
      : null;
  const unevaluated = (typeof verdict.nullReason === "string" && verdict.nullReason.trim() !== "") || verdict.scoreIsNull === true;
  if (unevaluated) {
    const nr = verdict.nullReason || "score_null";
    if (options.refuseUnevaluated === true) return `twzrd_unevaluated_subject_${nr}`;
    if (cap === null) return `twzrd_unevaluated_no_cap_${nr}`;
    if (priceUsdc > cap) return `twzrd_unevaluated_over_cap_${priceUsdc}_gt_${cap}`;
    return undefined;
  }
  const min = options.preflightMinScore ?? 40;
  const score = verdict.riskScore ?? 0;
  if (score < min) return `twzrd_score_${score}_below_${min}`;
  if (cap !== null && priceUsdc > cap) return `twzrd_over_recommended_cap_${priceUsdc}_gt_${cap}`;
  return undefined;
}

function normalizePreflight(value: unknown): BasePreflightVerdict {
  const response = asRecord(value);
  if (!response) throw new Error("[twzrd] Base preflight returned a non-object response");
  const card = asRecord(response.readiness_card) ?? response;
  const decision = card.decision;
  if (decision !== "allow" && decision !== "warn" && decision !== "block") {
    throw new Error("[twzrd] Base preflight returned no valid decision");
  }
  const riskScore = numberOrNull(card.risk_score) ?? numberOrNull(card.trust_score);
  const reasons = strings(card.reasons ?? card.reason_codes ?? asRecord(card.decision_envelope)?.reason_codes);
  return {
    decision,
    riskScore,
    reasons,
    nullReason: typeof card.null_reason === "string" ? card.null_reason : null,
    scoreIsNull: "score" in card && card.score === null,
    recommendedCapUsdc: numberOrNull(card.recommended_cap_usdc),
    washFlagged: typeof card.wash_flagged === "boolean" ? card.wash_flagged : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
