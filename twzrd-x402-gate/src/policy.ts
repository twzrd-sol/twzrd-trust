import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import { CLIENT_VERSION } from "./version.js";
import {
  applyWashFlaggedPolicy,
  fetchMerchantCard,
} from "./merchant-card.js";
import {
  amountBucket,
  classifyNetwork,
  decideUnsupportedNetwork,
  logUnsupportedNetwork,
} from "./network.js";
import { randomUUID } from "node:crypto";
import type {
  TwzrdApprovalResult,
  TwzrdApproveContext,
  TwzrdDecision,
  TwzrdGateDecision,
  TwzrdPreflightInput,
  TwzrdReadinessCard,
} from "./types.js";

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
export function evaluateReadinessCard(input: PolicyEvaluateInput): TwzrdCardEvaluation {
  const { card, preflightMinScore, blockDecisions, gateOnCanSpend } = input;
  const decision = card.decision ?? "warn";
  const score = card.trust_score ?? 0;

  if (blockDecisions.has(decision)) {
    return { approved: false, verdict: decision as TwzrdDecision, score: card.trust_score ?? null, card, reason: `twzrd_decision_${decision}` };
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
 * Only tightens; fail-open when the card is unreachable (no invent).
 */
async function tightenWithMerchantCardWash(input: {
  seller: string | undefined;
  approved: boolean;
  reason: string;
  verdict: TwzrdGateDecision;
  priceUsdc?: number;
  cfg: ResolvedTwzrdGateConfig;
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
    const mcard = await fetchMerchantCard(input.seller, {
      intelBase: input.cfg.intelBase,
      fetch: input.cfg.fetch,
    });
    if (mcard && typeof mcard.wash_flagged === "boolean") {
      washFlagged = mcard.wash_flagged;
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
      void cfg.onWarnUpsell({
        sellerWallet: seller,
        trustScore: card.trust_score ?? null,
        upsellUrl: seller ? `/v1/intel/trust/${seller}` : "/v1/intel/trust/unknown",
        priceUsdc: card.full_report_price_usdc ?? 0.05,
      });
    }

    // Trustless step 3: free merchant_card wash refuse (default on).
    // Only tightens; fail-open when card is unreachable (washFlagged=null).
    const wash = await tightenWithMerchantCardWash({
      seller: card.seller_wallet ?? context.sellerWallet ?? context.payTo,
      approved: result.approved,
      reason: result.reason,
      verdict: result.verdict,
      priceUsdc: context.priceUsdc,
      cfg,
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
