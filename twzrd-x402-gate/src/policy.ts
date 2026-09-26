import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import { CLIENT_VERSION } from "./version.js";
import {
  applyWashFlaggedPolicy,
  fetchMerchantCard,
  fetchMerchantCardResult,
} from "./merchant-card.js";
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
 * An unevaluated subject is unknown, and unknown is never approval.
 */
export function isUnevaluatedCard(card: TwzrdReadinessCard): boolean {
  if (typeof card.null_reason === "string" && card.null_reason.trim() !== "") return true;
  // `score` present-and-null is an explicit not-evaluated marker. Absent
  // entirely means a server that does not emit the field, which is not a claim.
  return "score" in card && card.score === null;
}

export function evaluateReadinessCard(input: PolicyEvaluateInput): TwzrdCardEvaluation {
  const { card, preflightMinScore, blockDecisions, gateOnCanSpend } = input;
  const decision = card.decision ?? "warn";
  const score = card.trust_score ?? 0;

  if (blockDecisions.has(decision)) {
    return { approved: false, verdict: decision as TwzrdDecision, score: card.trust_score ?? null, card, reason: `twzrd_decision_${decision}` };
  }
  // Not evaluated is not a low score. Checked before the numeric threshold,
  // because the floor trust_score would otherwise clear it.
  if (isUnevaluatedCard(card)) {
    return {
      approved: false,
      verdict: "unknown",
      score: null,
      card,
      reason: `twzrd_unevaluated_subject_${card.null_reason ?? "score_null"}`,
    };
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

  // Fail closed on an unidentifiable recipient — a 402 whose payment requirements
  // don't yield a seller wallet is not "an unknown seller" (which the free-tier
  // preflight already treats as a proceeding `warn`); it's evidence the gate has
  // nothing to evaluate at all. This is independent of failOpen: failOpen is about
  // the TWZRD *service* being unreachable, not about the caller failing to supply
  // who they're paying.
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

  // Path E: classify network before any Solana reputation call.
  // Base/EVM → explicit unknown (never a fabricated score). Solana → full preflight.
  // Observe is "don't claim Solana reputation", not "skip wash". Wash is
  // wallet-keyed; a wash_flagged payTo on Base must still refuse-before-sign.
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

  try {
    const card = await twzrdPreflight(buildPreflightInput(context), cfg);
    const result = evaluateReadinessCard({
      card,
      preflightMinScore: cfg.preflightMinScore,
      blockDecisions: cfg.blockDecisions,
      gateOnCanSpend: cfg.gateOnCanSpend,
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
