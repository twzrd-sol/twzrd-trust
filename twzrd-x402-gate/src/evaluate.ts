import { resolveConfig } from "./config.js";
import { twzrdApprovePayment } from "./policy.js";
import { payToFromRequirements, priceUsdcFromAmountMicro } from "./payto.js";
import { quickCheck, type TwzrdTier } from "./quick.js";
import { CLIENT_VERSION } from "./version.js";
import {
  resolveRequireReceiptPolicy,
  shouldAttemptPathAReceipt,
  shouldRequirePathAReceipt,
  type RequireReceiptPolicy,
} from "./receipt-policy.js";
import {
  evaluateLogInclusion,
  resolveRequireLogInclusionPolicy,
  type LogInclusionOutcome,
  type RequireLogInclusionPolicy,
} from "./log-inclusion.js";
import type {
  TwzrdDecision,
  TwzrdGateConfig,
  TwzrdReadinessCard,
  X402PaymentRequirements,
} from "./types.js";
import type { BuyerEscalateOnWarn } from "./buyer-defaults.js";

export type EvaluateX402Options = TwzrdGateConfig & {
  /**
   * When true, automatically fetches the paid TWZRD trust receipt (via x402)
   * after a warn/allow decision. Requires x402Fetch to be provided.
   * Default: false. Prefer `requireReceipt` when you want threshold/warn policy.
   */
  autoReceipt?: boolean;
  /**
   * Host threshold policy for Path A ($0.05 V6). Opt-in.
   * - Free preflight still decides allow|warn|block.
   * - Path A auto-runs when resource price > minSpendUsdc (default 10) OR
   *   decision === "warn" (onWarn default true).
   * - Never on decision === "block" (free refuse stays free).
   * - hard (default true): deny merchant spend if Path A fails.
   * Requires x402Fetch.
   */
  requireReceipt?: boolean | RequireReceiptPolicy;
  /**
   * x402-capable fetch that can settle USDC payments. Used by autoReceipt (the
   * $0.05 receipt), requireReceipt, and escalateOnWarn (the $0.001 quick tier).
   * The caller wires in a Solana wallet + x402 payer.
   */
  x402Fetch?: typeof fetch;
  /**
   * Called immediately after a receipt is captured on-chain.
   * Provides the raw twzrd_receipt object and the settlement tx hash (if present).
   */
  onReceipt?: (receipt: unknown, tx: string | undefined) => void;
  /**
   * Require a captured Path A receipt to be proven included in the Receipt
   * Transparency log under a key the host pinned, before it counts as trust.
   * Opt-in. Hard by default: when Path A is attempted it must yield a receipt
   * that is then proven — an unproven, missing, or unfetchable receipt denies
   * spend. Path A not attempted by policy (below the requireReceipt threshold)
   * is out of scope. The host wires the verifier (see log-inclusion.ts) — the
   * gate takes no dependency on the log verifier.
   */
  requireLogInclusion?: RequireLogInclusionPolicy | false;
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
  escalateOnWarn?: BuyerEscalateOnWarn;
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
  /** true when Path A was attempted due to requireReceipt threshold/warn policy */
  receiptRequired?: boolean;
  /** true when hard requireReceipt denied spend because Path A failed */
  receiptRequiredDenied?: boolean;
  /**
   * Present whenever requireLogInclusion was in play for an attempted Path A:
   * either a captured receipt was verified, or none was captured to verify
   * (then `checked` is false and `errors` says why). Its presence does NOT
   * imply a receipt exists — read `receipt` for that.
   */
  logInclusion?: LogInclusionOutcome;
  /** true when hard requireLogInclusion denied spend (receipt not proven in the log) */
  logInclusionDenied?: boolean;
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
 *   3. If autoReceipt / requireReceipt triggers and decision !== block:
 *      auto-fetch the paid TWZRD trust receipt via x402Fetch (Path A, $0.05 V6).
 *      With requireReceipt.hard (default), deny spend if Path A fails.
 *   4. Else if escalateOnWarn is set and decision=warn: settle the cheap
 *      $0.001 quick tier and re-decide on the paid score (only when Path A
 *      did not already fire).
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

  // Path A first ($0.05 V6 on material warn/allow). escalateOnWarn ($0.001)
  // only runs when Path A is not required — otherwise it would steal the
  // cash SKU. Never on block.
  const receiptPolicy = resolveRequireReceiptPolicy(opts.requireReceipt);
  const receiptRequired = shouldRequirePathAReceipt({
    policy: receiptPolicy,
    decision,
    priceUsdc,
  });
  const attemptReceipt = shouldAttemptPathAReceipt({
    autoReceipt: opts.autoReceipt,
    requireReceipt: opts.requireReceipt,
    decision,
    priceUsdc,
  });
  const logPolicy = resolveRequireLogInclusionPolicy(opts.requireLogInclusion);
  // Why Path A ended without a captured receipt, when it did. Read by the hard
  // requireLogInclusion guard below the Path A block.
  let receiptMiss: string | undefined;

  if (attemptReceipt && typeof opts.x402Fetch === "function" && payTo) {
    try {
      // Seat identity (fork-1 caller_id metric — same pair twzrdPreflight always
      // stamps). This paid receipt fetch previously sent no identity headers at
      // all, so every Path A challenge event landed with caller_id=NULL.
      const clientTag = `twzrd-x402-gate/${CLIENT_VERSION}`;
      const headers: Record<string, string> = {
        accept: "application/json",
        "X-TWZRD-Client": clientTag,
        "X-Twzrd-Caller": config.attribution ? `${config.attribution.integration}@${CLIENT_VERSION}` : clientTag,
      };
      // Echo the verify->act funnel link so this paid call is attributed to its preflight.
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
        const tx =
          body.tx ??
          body.tx_pending ??
          (typeof preimage?.settlement_tx === "string"
            ? preimage.settlement_tx
            : undefined);
        const feeCaptured = !!tx || body.charged === true;
        if (opts.onReceipt) opts.onReceipt(receipt, tx);

        // The receipt was paid for and is returned either way; what
        // requireLogInclusion decides is whether it may COUNT as trust.
        let logInclusion: LogInclusionOutcome | undefined;
        if (logPolicy) {
          logInclusion = await evaluateLogInclusion(receipt, logPolicy);
          if (logInclusion.denyReason) {
            return {
              ...base,
              approved: false,
              receipt,
              receiptTx: tx,
              receiptFeeCaptured: feeCaptured,
              receiptRequired,
              logInclusion,
              logInclusionDenied: true,
              reason: `${logInclusion.denyReason} (${(logInclusion.errors ?? []).join("; ") || "receipt not proven in the transparency log"}; price=${priceUsdc ?? "?"} decision=${decision})`,
              policyAction: "block",
            };
          }
        }
        return {
          ...base,
          receipt,
          receiptTx: tx,
          receiptFeeCaptured: feeCaptured,
          receiptRequired,
          ...(logInclusion ? { logInclusion } : {}),
        };
      }
      // Non-OK paid response: hard require → deny; soft → fail-open.
      if (receiptRequired && receiptPolicy?.hard !== false) {
        return {
          ...base,
          approved: false,
          receiptRequired: true,
          receiptRequiredDenied: true,
          reason: `twzrd_receipt_required_failed (HTTP ${resp.status}; price=${priceUsdc ?? "?"} decision=${decision})`,
          policyAction: "block",
        };
      }
      receiptMiss = `paid_response_not_ok (HTTP ${resp.status})`;
    } catch {
      if (receiptRequired && receiptPolicy?.hard !== false) {
        return {
          ...base,
          approved: false,
          receiptRequired: true,
          receiptRequiredDenied: true,
          reason: `twzrd_receipt_required_error (price=${priceUsdc ?? "?"} decision=${decision})`,
          policyAction: "block",
        };
      }
      // Soft autoReceipt: fail-open — do not block merchant spend.
      receiptMiss = "paid_fetch_error";
    }
  } else if (
    receiptRequired &&
    receiptPolicy?.hard !== false &&
    typeof opts.x402Fetch !== "function"
  ) {
    // Host enabled hard threshold policy but forgot x402Fetch — deny rather
    // than silently skip (would re-create the free-only loop).
    return {
      ...base,
      approved: false,
      receiptRequired: true,
      receiptRequiredDenied: true,
      reason:
        "twzrd_receipt_required_missing_x402Fetch (wire x402Fetch for Path A)",
      policyAction: "block",
    };
  } else if (attemptReceipt) {
    receiptMiss = typeof opts.x402Fetch !== "function" ? "missing_x402Fetch" : "no_payTo";
  }

  // requireLogInclusion when Path A was attempted but yielded no receipt.
  // Every path above that ends without a captured receipt lands here —
  // non-OK, thrown, missing x402Fetch, no payTo. The policy is evaluated for
  // ANY enabled mode so the result is never silent about it:
  //   - hard: deny. An outage on the receipt endpoint must not produce a
  //     better outcome than an empty receipt body.
  //   - soft: annotate only. "Soft annotates, never denies" holds here too;
  //     otherwise soft would be indistinguishable from policy-off exactly
  //     when the receipt path failed.
  // Path A that was not attempted by policy (below the requireReceipt
  // threshold) is out of scope; this knob gates receipts, it does not
  // override the host's threshold.
  if (logPolicy && attemptReceipt) {
    const miss = receiptMiss ?? "not_captured";
    const outcome = await evaluateLogInclusion(undefined, logPolicy);
    const annotated: LogInclusionOutcome = {
      ...outcome,
      errors: [`no receipt captured: ${miss}`],
    };
    // evaluateLogInclusion only sets denyReason under a hard policy.
    if (annotated.denyReason && base.approved) {
      return {
        ...base,
        approved: false,
        receiptRequired,
        logInclusion: annotated,
        logInclusionDenied: true,
        reason: `${annotated.denyReason} (no receipt captured: ${miss}; price=${priceUsdc ?? "?"} decision=${decision})`,
        policyAction: "block",
      };
    }
    // Soft policy, or already denied upstream: carry the annotation on `base`
    // so every later return (escalation included) reports it.
    base.logInclusion = annotated;
  }

  // Cheap re-decide only when Path A did not already fire.
  if (
    !receiptRequired &&
    !attemptReceipt &&
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
        receiptRequired: receiptRequired || undefined,
        reason: escApproved
          ? `twzrd_escalated_warn_allow (paid quick score ${quick.score} >= ${floor})`
          : `twzrd_escalated_warn_block (paid quick score ${quick.score} < ${floor})`,
      };
    }
    return {
      ...base,
      escalated: true,
      escalatedScore: null,
      receiptRequired: receiptRequired || undefined,
    };
  }

  return { ...base, receiptRequired: receiptRequired || undefined };
}
