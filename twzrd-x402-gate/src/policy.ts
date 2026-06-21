import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import type {
  TwzrdApprovalResult,
  TwzrdApproveContext,
  TwzrdPreflightInput,
  TwzrdReadinessCard,
} from "./types.js";

export type PolicyEvaluateInput = {
  card: TwzrdReadinessCard;
  preflightMinScore: number;
  blockDecisions: Set<string>;
  /** Deny on can_spend=false. Default true when omitted. */
  gateOnCanSpend?: boolean;
};

/**
 * Pure policy — no network. Mirrors scripts/twzrd_gate_agentcash_fetch.sh semantics.
 */
export function evaluateReadinessCard(input: PolicyEvaluateInput): TwzrdApprovalResult {
  const { card, preflightMinScore, blockDecisions, gateOnCanSpend } = input;
  const decision = card.decision ?? "warn";
  const score = card.trust_score ?? 0;

  if (blockDecisions.has(decision)) {
    return { approved: false, card, reason: `twzrd_decision_${decision}` };
  }
  if (gateOnCanSpend !== false && card.can_spend === false) {
    return { approved: false, card, reason: "twzrd_can_spend_false" };
  }
  if (score < preflightMinScore) {
    return {
      approved: false,
      card,
      reason: `twzrd_score_${score}_below_${preflightMinScore}`,
    };
  }
  return {
    approved: true,
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
  };
}

export async function twzrdPreflight(
  input: TwzrdPreflightInput,
  config?: ResolvedTwzrdGateConfig,
): Promise<TwzrdReadinessCard> {
  const cfg = config ?? resolveConfig();
  const resp = await cfg.fetch(`${cfg.intelBase}/v1/intel/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    throw new Error(`[twzrd] preflight HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    readiness_card?: TwzrdReadinessCard;
  } & TwzrdReadinessCard;
  return data.readiness_card ?? data;
}

export async function twzrdApprovePayment(
  context: TwzrdApproveContext,
  config?: ResolvedTwzrdGateConfig,
): Promise<TwzrdApprovalResult> {
  const cfg = config ?? resolveConfig();
  try {
    const card = await twzrdPreflight(buildPreflightInput(context), cfg);
    return evaluateReadinessCard({
      card,
      preflightMinScore: cfg.preflightMinScore,
      blockDecisions: cfg.blockDecisions,
      gateOnCanSpend: cfg.gateOnCanSpend,
    });
  } catch (err) {
    if (!cfg.failOpen) throw err;
    // fail-open: preflight unreachable must not hard-block the agent's payment
    return {
      approved: true,
      card: {},
      reason: "twzrd_fail_open",
      failOpen: true,
    };
  }
}
