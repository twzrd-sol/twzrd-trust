import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import { CLIENT_VERSION } from "./version.js";
import {
  applyWashFlaggedPolicy,
  fetchMerchantCard,
  fetchMerchantCardResult,
} from "./merchant-card.js";
import { isUsdcRequirement } from "./payto.js";
import {
  amountBucket,
  classifyNetwork,
  decideUnsupportedNetwork,
  logUnsupportedNetwork,
} from "./network.js";
import { randomUUID } from "node:crypto";
import { QUICK_PRICE_USDC } from "./quick.js";
import type {
  TwzrdApprovalResult,
  TwzrdApproveContext,
  TwzrdDecision,
  TwzrdGateDecision,
  TwzrdPreflightInput,
  TwzrdReadinessCard,
} from "./types.js";

/** First paid hop on warn. Ignore live paid_trust_endpoint ($0.05 V7). */
function warnUpsellHop(
  card: TwzrdReadinessCard,
  seller: string | undefined,
): { upsellUrl: string; priceUsdc: number } {
  const teaser = card.paid_teaser ?? card.paid_quick_endpoint;
  if (typeof teaser === "string" && teaser.includes("/quick")) {
    return { upsellUrl: teaser, priceUsdc: card.paid_teaser_usdc ?? QUICK_PRICE_USDC };
  }
  return {
    upsellUrl: seller ? `/v1/intel/quick/${seller}` : "/v1/intel/quick/unknown",
    priceUsdc: card.paid_teaser_usdc ?? QUICK_PRICE_USDC,
  };
}

export type PolicyEvaluateInput = {
  card: TwzrdReadinessCard;
  preflightMinScore: number;
  blockDecisions: Set<string>;
  /** Deny on can_spend=false. Default FALSE when omitted (decision-only gating). */
  gateOnCanSpend?: boolean;
  /**
   * Refuse every unevaluated seller (the 0.9.9–0.9.16 behaviour). Default FALSE
   * when omitted: an unevaluated seller is allowed up to the card's
   * recommended_cap_usdc when `priceUsdc` is known and within it.
   */
  refuseUnevaluated?: boolean;
  /** Price of this payment in USDC. Required to allow an unevaluated seller. */
  priceUsdc?: number;
};

/** Pure card evaluation has no request lifecycle, therefore no decision ID. */
export type TwzrdCardEvaluation = Omit<TwzrdApprovalResult, "decisionId">;

/**
 * Pure policy — no network. Mirrors scripts/twzrd_gate_agentcash_fetch.sh semantics.
 */
/**
 * True when the server says it did not evaluate this subject.
 *
 * The preflight answers an unknown seller with `score: null` plus a
 * `null_reason` such as "unknown_subject", while still returning a floor
 * `trust_score` (45 today). That floor clears the default `preflightMinScore`
 * of 40, so reading `trust_score` alone turns "never seen" into "approved".
 * An unevaluated subject is never scored as if it were evaluated: it gets no
 * trust score, and it is only allowed up to the card's own
 * `recommended_cap_usdc` (see evaluateReadinessCard).
 */
export function isUnevaluatedCard(card: TwzrdReadinessCard): boolean {
  if (typeof card.null_reason === "string" && card.null_reason.trim() !== "") return true;
  // `score` present-and-null is an explicit not-evaluated marker. Absent
  // entirely means a server that does not emit the field, which is not a claim.
  return "score" in card && card.score === null;
}

export function evaluateReadinessCard(input: PolicyEvaluateInput): TwzrdCardEvaluation {
  const { card, preflightMinScore, blockDecisions, gateOnCanSpend, refuseUnevaluated } = input;
  const decision = card.decision ?? "warn";
  const score = card.trust_score ?? 0;

  if (blockDecisions.has(decision)) {
    // decision "block" returns twzrd_decision_block. That string is not "block"
    // and it is not twzrd_fail_closed.
    return { approved: false, verdict: decision as TwzrdDecision, score: card.trust_score ?? null, card, reason: `twzrd_decision_${decision}` };
  }
  // Not evaluated is not a low score. Checked before the numeric threshold,
  // because the floor trust_score would otherwise clear it, and a card that
  // omits trust_score would otherwise read as score 0.
  if (isUnevaluatedCard(card)) {
    return evaluateUnevaluatedCard(card, decision, input.priceUsdc, {
      refuseUnevaluated: refuseUnevaluated === true,
      gateOnCanSpend: gateOnCanSpend === true,
    });
  }

  // Decision-only by default: deny on can_spend=false ONLY when the caller
  // explicitly opts in (gateOnCanSpend === true). Matches the documented default
  // (FALSE when omitted) and policy.test.ts. The wrapped integration path
  // (twzrdApprovePayment -> resolveConfig) still passes the resolved config default,
  // so live gating strictness is governed there, not here.
  if (gateOnCanSpend === true && card.can_spend === false) {
    return { approved: false, verdict: decision as TwzrdDecision, score: card.trust_score ?? null, card, reason: "twzrd_can_spend_false" };
  }
  if (score < preflightMinScore) {
    return {
      approved: false,
      verdict: decision as TwzrdDecision,
      score: card.trust_score ?? null,
      card,
      reason: `twzrd_score_${score}_below_${preflightMinScore}`,
    };
  }
  return {
    approved: true,
    verdict: (decision === "warn" ? "warn" : "allow") as TwzrdDecision,
    score: card.trust_score ?? null,
    card,
    reason: decision === "warn" ? "twzrd_warn_allowed" : "twzrd_allow",
    recommendedCapUsdc:
      typeof card.recommended_cap_usdc === "number" && Number.isFinite(card.recommended_cap_usdc)
        ? card.recommended_cap_usdc
        : undefined,
  };
}

/**
 * A seller the server has not evaluated (0.11.0+).
 *
 * The server still answers with a decision and a ceiling (`recommended_cap_usdc`).
 * For a seller it has never seen, live intel (2026-09-28) grades the floor score
 * to its lowest warn tier, $0.10, and reports min($0.10, requested price). Refusing every such seller stopped agents from paying anyone new,
 * including when the server itself said "warn, within cap". So by default the
 * gate follows the server: allow at or under the cap, refuse above it. Every
 * case where the bound cannot be checked still refuses:
 *
 *   refuseUnevaluated: true         -> twzrd_unevaluated_subject_<null_reason>
 *   decision not allow / warn       -> twzrd_unevaluated_subject_<null_reason>
 *   can_spend false + gateOnCanSpend -> twzrd_can_spend_false
 *   no finite recommended_cap_usdc  -> twzrd_unevaluated_no_cap_<null_reason>
 *   price unknown                   -> twzrd_unevaluated_unknown_price_<null_reason>
 *   price above the cap             -> twzrd_unevaluated_over_cap_<price>_gt_<cap>
 *   price at or under the cap       -> approved, twzrd_unevaluated_within_cap_<price>_le_<cap>
 *
 * The approval carries `unevaluated: true`, `verdict: "warn"` and `score: null`:
 * 45 is a floor, not a score. The wash tighten still runs after this, so a
 * wash-flagged unevaluated seller is refused.
 */
function evaluateUnevaluatedCard(
  card: TwzrdReadinessCard,
  decision: string,
  priceUsdc: number | undefined,
  opts: { refuseUnevaluated: boolean; gateOnCanSpend: boolean },
): TwzrdCardEvaluation {
  const nullReason = card.null_reason ?? "score_null";
  const refuse = (reason: string, extra?: Partial<TwzrdCardEvaluation>): TwzrdCardEvaluation => ({
    approved: false,
    verdict: "unknown",
    score: null,
    card,
    reason,
    unevaluated: true,
    ...extra,
  });

  // null_reason unknown_subject returns twzrd_unevaluated_subject_unknown_subject.
  if (opts.refuseUnevaluated) return refuse(`twzrd_unevaluated_subject_${nullReason}`);
  if (decision !== "allow" && decision !== "warn") {
    return refuse(`twzrd_unevaluated_subject_${nullReason}`);
  }
  if (opts.gateOnCanSpend && card.can_spend === false) return refuse("twzrd_can_spend_false");

  const cap =
    typeof card.recommended_cap_usdc === "number" &&
    Number.isFinite(card.recommended_cap_usdc) &&
    card.recommended_cap_usdc >= 0
      ? card.recommended_cap_usdc
      : null;
  if (cap === null) return refuse(`twzrd_unevaluated_no_cap_${nullReason}`);

  const price =
    typeof priceUsdc === "number" && Number.isFinite(priceUsdc) ? priceUsdc : null;
  if (price === null) return refuse(`twzrd_unevaluated_unknown_price_${nullReason}`);
  if (price > cap) {
    return refuse(`twzrd_unevaluated_over_cap_${price}_gt_${cap}`, {
      overRecommendedCap: true,
      recommendedCapUsdc: cap,
    });
  }
  return {
    approved: true,
    verdict: "warn",
    score: null,
    card,
    reason: `twzrd_unevaluated_within_cap_${price}_le_${cap}`,
    recommendedCapUsdc: cap,
    unevaluated: true,
  };
}

export function buildPreflightInput(context: TwzrdApproveContext): TwzrdPreflightInput {
  const seller = context.sellerWallet ?? context.payTo;
  return {
    resource_name:
      context.resourceName ?? context.resourceUrl ?? "unknown_x402_resource",
    seller_wallet: seller,
    resource_url: context.resourceUrl,
    price_usdc: context.priceUsdc,
    buyer_wallet: context.buyerWallet,
    agent_intent: context.agentIntent ?? "x402_payment_gate",
    chain: context.chain,
  };
}

export async function twzrdPreflight(
  input: TwzrdPreflightInput,
  config?: ResolvedTwzrdGateConfig,
): Promise<TwzrdReadinessCard> {
  const cfg = config ?? resolveConfig();
  // Seat identity is ALWAYS stamped on preflight (fork-1 metric: gate installs
  // that hit intel) — and, since the caller_id gap fix, on the paid /trust and
  // /quick receipt fetches too (x402-client-hook.ts, evaluate.ts, quick.ts).
  // The generic resource/merchant fetch never gets these headers — only
  // TWZRD's own intel.twzrd.xyz endpoints are stamped.
  // Opt-in attribution (integration+runId) adds correlatable run IDs on top.
  const clientTag = `twzrd-x402-gate/${CLIENT_VERSION}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-TWZRD-Client": clientTag,
    // Maps to preflight_requests.caller_id (intel server). Default seat label.
    "X-Twzrd-Caller": clientTag,
  };
  if (cfg.attribution) {
    headers["X-TWZRD-Integration"] = cfg.attribution.integration;
    headers["X-TWZRD-Run-Id"] = cfg.attribution.runId;
    // Prefer explicit integration as caller when provided (e.g. partner name).
    headers["X-Twzrd-Caller"] = `${cfg.attribution.integration}@${CLIENT_VERSION}`;
  }
  const resp = await cfg.fetch(`${cfg.intelBase}/v1/intel/preflight`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    throw new Error(`[twzrd] preflight HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    readiness_card?: TwzrdReadinessCard;
  } & TwzrdReadinessCard;
  const card = data.readiness_card ?? data;
  // Surface the server-issued preflight_id (a sibling of readiness_card) onto the card so
  // the verify->act funnel link can be echoed on the paid /v1/intel/trust call.
  if (card.preflight_id == null && typeof data.preflight_id === "number") {
    card.preflight_id = data.preflight_id;
  }
  return card;
}

/**
 * Trustless wash tighten (merchant_card). Wallet-keyed, chain-neutral.
 * Only tightens; never invents wash_flagged.
 *
 * An UNREACHABLE card (5xx/429, non-JSON body, thrown/aborted fetch) is an
 * outage and is decided by `cfg.failOpen`, exactly like a preflight outage:
 * fail-closed by default, allow only when the caller opted into failOpen —
 * subject to `failClosedOnOutage` and to only-ever-tightening (see below).
 * A REACHABLE card carrying no wash_flagged is a genuine unknown and still fails
 * open — that is the no-invent rule and is unchanged. A 4xx is the service
 * answering, not an outage; see fetchMerchantCardResult.
 *
 * These were previously the same thing. fetchMerchantCard caught its own fetch
 * errors and returned null, so an outage arrived here indistinguishable from
 * "no signal" and always allowed, while the surrounding try/catch that honours
 * failOpen never saw the error. `failOpen: false` therefore documented a
 * guarantee this path could not give (BlockRunAI/ClawRouter v0.12.278 removal
 * notes, 2026-09-07).
 */
async function tightenWithMerchantCardWash(input: {
  seller: string | undefined;
  approved: boolean;
  reason: string;
  verdict: TwzrdGateDecision;
  priceUsdc?: number;
  cfg: ResolvedTwzrdGateConfig;
  /**
   * Whether a card OUTAGE on this path may refuse under `failOpen: false`.
   *
   * True only on the reputation-scored path, where the gate claims a verdict and
   * "could not evaluate" is the failure `failOpen` exists to decide. False on the
   * unsupported-network `observe` path: there the operator has already said
   * "allow what you cannot score" for a chain that gets no trust signal at all,
   * so refusing it on a wash-lookup hiccup is over-refusal, not fail-closed
   * safety (`strict` blocks that path before intel is ever called).
   */
  failClosedOnOutage: boolean;
}): Promise<{
  approved: boolean;
  reason: string;
  verdict: TwzrdGateDecision;
  washFlagged: boolean | null;
  washCapped?: boolean;
}> {
  let washFlagged: boolean | null = null;
  let approved = input.approved;
  let reason = input.reason;
  let verdict = input.verdict;

  if (input.cfg.refuseWashFlagged && input.seller) {
    const lookup = await fetchMerchantCardResult(input.seller, {
      intelBase: input.cfg.intelBase,
      fetch: input.cfg.fetch,
    });
    // Only TIGHTENS, like applyWashFlaggedPolicy below: an outage may refuse a
    // payment that was otherwise going through, but must never relabel a
    // payment already refused for a more specific reason (`input.approved`) —
    // the caller needs to see WHY it was blocked, and a denied payment is
    // denied either way.
    if (!lookup.reachable && !input.cfg.failOpen && input.failClosedOnOutage && input.approved) {
      // Outage, and the caller did not opt into failOpen. Refuse before the
      // signer, and say which of the two unknowns this was.
      console.warn(
        `[twzrd-x402-gate] payment BLOCKED: merchant_card unreachable (fail-closed) — ${lookup.error}. Set TWZRD_FAIL_OPEN=true to allow payments when the gate is down.`,
      );
      return {
        approved: false,
        reason: `twzrd_card_unreachable_fail_closed (${lookup.error})`,
        verdict: "block",
        washFlagged: null,
      };
    }
    if (lookup.card && typeof lookup.card.wash_flagged === "boolean") {
      washFlagged = lookup.card.wash_flagged;
    }
  }

  const wash = applyWashFlaggedPolicy({
    approved,
    reason,
    washFlagged,
    priceUsdc: input.priceUsdc,
    refuseWashFlagged: input.cfg.refuseWashFlagged,
    washMaxUsdc: input.cfg.washMaxUsdc,
  });
  approved = wash.approved;
  reason = wash.reason;
  washFlagged = wash.washFlagged;
  if (!approved && wash.washFlagged === true) {
    verdict = "block";
  }
  return {
    approved,
    reason,
    verdict,
    washFlagged,
    washCapped: wash.washCapped,
  };
}

export async function twzrdApprovePayment(
  context: TwzrdApproveContext,
  config?: ResolvedTwzrdGateConfig,
): Promise<TwzrdApprovalResult> {
  const cfg = config ?? resolveConfig();
  const decisionId = randomUUID();

  // Missing payTo is not approved. The reason is
  // twzrd_unidentifiable_payment_recipient, not twzrd_missing_payTo.
  // That is not an unknown_subject card: on Solana mainnet and Base mainnet,
  // null_reason unknown_subject is also not approved (isUnevaluatedCard),
  // even when trust_score is the floor 45.
  // failOpen is only the buyer preflight outage switch. Unset, that outage
  // does not sign. It does not approve a missing payTo.
  if (!(context.sellerWallet ?? context.payTo)) {
    return {
      decisionId,
      approved: false,
      verdict: "block",
      score: null,
      card: {},
      reason: "twzrd_unidentifiable_payment_recipient",
    };
  }

  // Classify before the scored preflight. Solana mainnet and Base mainnet
  // (eip155:8453) are scored. Other EVM networks are not: they do not run
  // twzrdPreflight. Observe still runs wash. A wash_flagged payTo on an
  // unscored network still refuses before sign.
  const netCls = classifyNetwork(context.chain, context.payTo ?? context.sellerWallet);
  if (!netCls.reputationScored) {
    const undecided = decideUnsupportedNetwork(netCls, cfg.unsupportedNetworkMode);
    const unsupportedLog = (policyAction: "allow" | "block") =>
      logUnsupportedNetwork({
        network: netCls.network,
        payTo: context.payTo ?? context.sellerWallet,
        amountBucket: amountBucket(
          context.priceUsdc != null && Number.isFinite(context.priceUsdc)
            ? String(Math.round(context.priceUsdc * 1_000_000))
            : undefined,
        ),
        policyMode: cfg.unsupportedNetworkMode,
        policyAction,
        adapter: context.agentIntent,
      });
    // Strict: block before intel. Wash opt-out: keep the observe allow.
    // Observe + refuseWashFlagged (default): still GET merchant_card.
    if (undecided.policyAction === "block" || !cfg.refuseWashFlagged) {
      unsupportedLog(undecided.policyAction);
      return {
        decisionId,
        approved: undecided.approved,
        verdict: "unknown",
        score: null,
        card: {},
        reason: undecided.reason,
        network: undecided.network,
        networkSupported: undecided.networkSupported,
        reputationScored: false,
        policyAction: undecided.policyAction,
      };
    }
    const wash = await tightenWithMerchantCardWash({
      seller: context.sellerWallet ?? context.payTo,
      approved: undecided.approved,
      reason: undecided.reason,
      verdict: "unknown",
      priceUsdc: context.priceUsdc,
      cfg,
      // observe on an unscored chain: a wash_flagged=true payTo still refuses,
      // but a card OUTAGE keeps the observe allow. See failClosedOnOutage.
      failClosedOnOutage: false,
    });
    unsupportedLog(wash.approved ? "allow" : "block");
    return {
      decisionId,
      approved: wash.approved,
      verdict: wash.verdict,
      score: null,
      card: {},
      reason: wash.reason,
      washFlagged: wash.washFlagged,
      washCapped: wash.washCapped,
      network: undecided.network,
      networkSupported: undecided.networkSupported,
      reputationScored: false,
      policyAction: wash.approved ? "allow" : "block",
    };
  }

  // A USDC gate that cannot price the asset has nothing to evaluate. Every cap
  // here (recommended_cap_usdc, washMaxUsdc, the unevaluated-seller ceiling) is
  // in USDC, and `amount` is in the named asset's base units: an 8-decimal mint
  // at amount 100000 reads as $0.10 while it moves 0.001 of that token. Refused
  // before intel, and not an outage, so failOpen does not apply. Scored networks
  // only: an unscored network's observe policy never priced anything (0.11.1).
  if (context.asset && !isUsdcRequirement({ network: context.chain ?? netCls.network, asset: context.asset })) {
    return {
      decisionId,
      approved: false,
      verdict: "block",
      score: null,
      card: {},
      reason: "twzrd_non_usdc_asset",
      network: netCls.network,
      networkSupported: true,
      reputationScored: true,
      policyAction: "block",
    };
  }

  try {
    const card = await twzrdPreflight(buildPreflightInput(context), cfg);
    const result = evaluateReadinessCard({
      card,
      preflightMinScore: cfg.preflightMinScore,
      blockDecisions: cfg.blockDecisions,
      gateOnCanSpend: cfg.gateOnCanSpend,
      refuseUnevaluated: cfg.refuseUnevaluated,
      priceUsdc: context.priceUsdc,
    });
    // Fire upsell hook on warn (unknown/low-corpus seller) — fire-and-forget
    if (result.verdict === "warn" && cfg.onWarnUpsell) {
      const seller = card.seller_wallet ?? context.sellerWallet ?? context.payTo;
      const hop = warnUpsellHop(card, seller);
      void cfg.onWarnUpsell({
        sellerWallet: seller,
        trustScore: card.trust_score ?? null,
        upsellUrl: hop.upsellUrl,
        priceUsdc: hop.priceUsdc,
      });
    }

    // The card can carry a per-seller ceiling. Honour it: an approval that
    // ignores the bound it was given is not the decision the server made.
    // Applied before the wash tighten so a refusal here is reported as a cap
    // breach rather than as a wash outcome.
    if (
      result.approved &&
      typeof result.recommendedCapUsdc === "number" &&
      typeof context.priceUsdc === "number" &&
      Number.isFinite(context.priceUsdc) &&
      context.priceUsdc > result.recommendedCapUsdc
    ) {
      // Reason starts with twzrd_over_recommended_cap_.
      return {
        ...result,
        decisionId,
        approved: false,
        verdict: "block",
        reason: `twzrd_over_recommended_cap_${context.priceUsdc}_gt_${result.recommendedCapUsdc}`,
        overRecommendedCap: true,
        preflightId: card.preflight_id,
        network: netCls.network,
        networkSupported: true,
        reputationScored: true,
        policyAction: "block",
      };
    }

    // Trustless step 3: free merchant_card wash refuse (default on).
    // Only tightens. A card that ANSWERS with no wash signal fails open
    // (washFlagged stays null — never invented); a card that is UNREACHABLE is
    // decided by failOpen, fail-closed by default.
    const wash = await tightenWithMerchantCardWash({
      seller: card.seller_wallet ?? context.sellerWallet ?? context.payTo,
      approved: result.approved,
      reason: result.reason,
      verdict: result.verdict,
      priceUsdc: context.priceUsdc,
      cfg,
      // Scored path: the gate claims a verdict here, so a card outage is the
      // "could not evaluate" that failOpen:false is documented to refuse.
      failClosedOnOutage: true,
    });

    return {
      ...result,
      decisionId,
      approved: wash.approved,
      reason: wash.reason,
      verdict: wash.verdict,
      preflightId: card.preflight_id,
      washFlagged: wash.washFlagged,
      washCapped: wash.washCapped,
      network: netCls.network,
      networkSupported: true,
      reputationScored: true,
      policyAction: wash.approved ? "allow" : "block",
    };
  } catch (err) {
    // Buyer outage, TWZRD_FAIL_OPEN unset: twzrdApprovePayment returns
    // approved false, reason twzrd_fail_closed, and the wallet does not sign.
    // That reason is not twzrd_preflight_fetch_error.
    // This is not createTwzrdSettleGuard. An omitted settle failOpen returns
    // without abort.
    if (!cfg.failOpen) {
      const msg = String((err as Error)?.message ?? err).slice(0, 120);
      console.warn(`[twzrd-x402-gate] payment BLOCKED: gate unreachable (fail-closed) — ${msg}. Set TWZRD_FAIL_OPEN=true to allow payments when the gate is down.`);
      return {
        decisionId,
        approved: false,
        verdict: "block",
        score: null,
        card: {},
        reason: `twzrd_fail_closed (${msg})`,
        failOpen: false,
        network: netCls.network,
        networkSupported: true,
        reputationScored: true,
        policyAction: "block",
      };
    }
    // fail-open: preflight unreachable must not hard-block the agent's payment
    return {
      decisionId,
      approved: true,
      verdict: "warn",
      score: null,
      card: {},
      reason: "twzrd_fail_open",
      failOpen: true,
      network: netCls.network,
      networkSupported: true,
      reputationScored: true,
      policyAction: "allow",
    };
  }
}
