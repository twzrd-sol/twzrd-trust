import { resolveConfig } from "./config.js";
import { twzrdApprovePayment } from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { quickCheck, type TwzrdTier } from "./quick.js";
import type {
  TwzrdDecision,
  TwzrdGateConfig,
  TwzrdReadinessCard,
  X402PaymentRequirements,
} from "./types.js";

export type EvaluateX402Options = TwzrdGateConfig & {
  /**
   * When true, automatically fetches the paid TWZRD trust receipt (via x402)
   * after a warn/allow decision. Requires x402Fetch to be provided.
   * Default: false.
   */
  autoReceipt?: boolean;
  /**
   * x402-capable fetch that can settle USDC payments. Used by autoReceipt (the
   * $0.05 receipt) and by escalateOnWarn (the $0.001 quick tier). The caller wires
   * in a Solana wallet + x402 payer.
   */
  x402Fetch?: typeof fetch;
  /**
   * Called immediately after a receipt is captured on-chain.
   * Provides the raw twzrd_receipt object and the settlement tx hash (if present).
   */
  onReceipt?: (receipt: unknown, tx: string | undefined) => void;
  /**
   * Autonomous risk-escalation. When the free preflight is inconclusive
   * (decision="warn" and otherwise proceeding), the gate autonomously settles the
   * cheap $0.001 quick tier and RE-DECIDES on the paid score: below `blockBelowScore`
   * (default: preflightMinScore) the payment is denied (approved=false); at/above it
   * proceeds. The paid call fires from the agent's own risk policy - no human - and
   * the paid signal actually gates the spend (unlike autoReceipt, which is upsell-only
   * and never changes the decision). Opt-in; requires x402Fetch. Fail-soft: if the
   * quick tier cannot answer, the base warn decision is preserved. Only tightens
   * (warn -> maybe block); never loosens a block or allow. Short-circuits the
   * autoReceipt path for the warn case (no double settle).
   */
  escalateOnWarn?: {
    /** Skip escalation when the resource price is below this - don't pay $0.001 to vet a sub-cent buy. Default 0. */
    minSpendUsdc?: number;
    /** Deny when the paid quick score is below this. Default: preflightMinScore (40). */
    blockBelowScore?: number;
  };
};

export type EvaluateX402Result = {
  decision: TwzrdDecision | "unknown";
  trustScore: number | null;
  approved: boolean;
  reason: string;
  card: TwzrdReadinessCard;
  /** true when the preflight was unreachable and fail-open allowed the resource */
  failOpen?: boolean;
  /** URL of the paid TWZRD trust endpoint for this seller (for manual upsell) */
  receiptUrl?: string;
  /** Present when autoReceipt=true and the x402 trust call succeeded */
  receipt?: unknown;
  /** On-chain settlement tx from the receipt payment */
  receiptTx?: string;
  /** true when a fee was captured on-chain */
  receiptFeeCaptured?: boolean;
  /** true when a `warn` triggered an autonomous paid quick-tier re-decision (escalateOnWarn) */
  escalated?: boolean;
  /** the paid quick-tier score that drove the escalated decision; null when the quick tier could not answer */
  escalatedScore?: number | null;
  /** the paid quick-tier label (Bronze/Silver/Gold/Platinum) from the escalation */
  escalatedTier?: TwzrdTier | null;
  network?: string;
  networkSupported?: boolean;
  reputationScored?: boolean;
  policyAction?: "allow" | "block";
};

/**
 * Evaluate an x402 resource before the buyer pays:
 *   1. Run free TWZRD preflight on the seller (no auth, no cost).
 *   2. Return decision + trust score.
 *   3. If escalateOnWarn is set and decision=warn: autonomously settle the cheap
 *      $0.001 quick tier and re-decide on the paid score (the autonomous risk loop).
 *   4. Else if autoReceipt=true and decision !== block: auto-fetch the paid TWZRD
 *      trust receipt via x402Fetch (TWZRD earns the receipt fee on-chain).
 *
 * Defaults to gateOnCanSpend=false (decision-only) — the free-tier preflight
 * returns can_spend=false for most unknown sellers, which would block too eagerly
 * on platforms like Agentic.Market where sellers are not yet in the corpus.
 */
export async function evaluate_x402_resource(
  resourceUrl: string,
  paymentRequirements: X402PaymentRequirements,
  opts: EvaluateX402Options = {},
): Promise<EvaluateX402Result> {
  const config = resolveConfig({
    intelBase: opts.intelBase,
    preflightMinScore: opts.preflightMinScore,
    blockDecisions: opts.blockDecisions,
    failOpen: opts.failOpen,
    // Decision-only gate: unknown sellers score warn (~45), not block.
    // Gating on can_spend would block every Agentic.Market seller not in corpus.
    gateOnCanSpend: opts.gateOnCanSpend,
    refuseWashFlagged: opts.refuseWashFlagged,
    washMaxUsdc: opts.washMaxUsdc,
    unsupportedNetworkMode: opts.unsupportedNetworkMode,
    fetch: opts.fetch,
    attribution: opts.attribution,
  });

  const { payTo, amountMicro, resource } = payToFromRequirements(paymentRequirements);
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

  const approval = await twzrdApprovePayment(
    {
      resourceUrl: resource ?? resourceUrl,
      payTo,
      priceUsdc,
      agentIntent: "evaluate_x402_resource",
      // Evaluate the exact network on the requirement the pay client will use
      // (pickRequirements prefers Solana when dual-listed).
      chain: paymentRequirements.network,
    },
    // resolveConfig already embeds refuseWashFlagged / washMaxUsdc
    config,
  );

  // Unscored networks: decision stays "unknown" — never map to reputation allow/warn/block.
  const decision = (
    approval.verdict === "unknown"
      ? "unknown"
      : (approval.card.decision ?? approval.verdict ?? "unknown")
  ) as TwzrdDecision | "unknown";
  // Paid trust receipt is Solana-only product surface — omit for unscored nets.
  const receiptUrl =
    payTo && approval.reputationScored === true
      ? `${config.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`
      : undefined;

  const base: EvaluateX402Result = {
    decision,
    trustScore: approval.card.trust_score ?? null,
    approved: approval.approved,
    reason: approval.reason,
    card: approval.card,
    failOpen: approval.failOpen,
    receiptUrl,
    network: approval.network,
    networkSupported: approval.networkSupported,
    reputationScored: approval.reputationScored,
    policyAction: approval.policyAction,
  };

  // Autonomous risk-escalation: a *proceeding* `warn` (uncertain / unknown seller)
  // is vetted by settling the cheap $0.001 quick tier and re-deciding on the paid
  // score. This is the autonomous demand loop - the paid call fires from the agent's
  // own risk policy, and the paid signal gates the spend (only tightens). Fail-soft:
  // if the quick tier cannot answer, the base warn decision is preserved.
  if (
    opts.escalateOnWarn &&
    typeof opts.x402Fetch === "function" &&
    payTo &&
    decision === "warn" &&
    base.approved &&
    (priceUsdc ?? 0) >= (opts.escalateOnWarn.minSpendUsdc ?? 0)
  ) {
    const floor = opts.escalateOnWarn.blockBelowScore ?? config.preflightMinScore;
    const quick = await quickCheck(payTo, {
      intelBase: config.intelBase,
      fetch: config.fetch,
      x402Fetch: opts.x402Fetch,
    });
    if (quick.available && quick.score !== null) {
      const escApproved = quick.score >= floor;
      return {
        ...base,
        approved: escApproved,
        trustScore: quick.score,
        escalated: true,
        escalatedScore: quick.score,
        escalatedTier: quick.tier,
        reason: escApproved
          ? `twzrd_escalated_warn_allow (paid quick score ${quick.score} >= ${floor})`
          : `twzrd_escalated_warn_block (paid quick score ${quick.score} < ${floor})`,
      };
    }
    // Quick tier could not answer (fail-soft) - preserve the base warn decision.
    return { ...base, escalated: true, escalatedScore: null };
  }

  // Auto-upsell: on warn or allow, fetch the paid TWZRD trust receipt.
  // This is the revenue capture path: x402Fetch settles $0.05 USDC to TWZRD.
  if (
    opts.autoReceipt &&
    typeof opts.x402Fetch === "function" &&
    payTo &&
    decision !== "block"
  ) {
    try {
      // Echo the verify->act funnel link so this paid call is attributed to its preflight.
      const headers: Record<string, string> = { accept: "application/json" };
      if (typeof approval.preflightId === "number") {
        headers["x-twzrd-preflight-id"] = String(approval.preflightId);
      }
      const resp = await opts.x402Fetch(
        `${config.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`,
        { method: "GET", headers },
      );
      if (resp.ok) {
        const body = (await resp.json()) as {
          tx?: string;
          tx_pending?: string;
          charged?: boolean;
          twzrd_receipt?: Record<string, unknown>;
        };
        const receipt = body.twzrd_receipt;
        const preimage = receipt?.preimage as Record<string, unknown> | undefined;
        const tx = body.tx ?? body.tx_pending ?? (typeof preimage?.settlement_tx === "string" ? preimage.settlement_tx : undefined);
        const feeCaptured = !!tx || body.charged === true;
        if (opts.onReceipt) opts.onReceipt(receipt, tx);
        return { ...base, receipt, receiptTx: tx, receiptFeeCaptured: feeCaptured };
      }
    } catch {
      // Fail-open: receipt upsell failure does not block access to the resource.
    }
  }

  return base;
}
