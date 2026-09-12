/**
 * Consumer-agent adjacency router for Muse / Instinct / OpenClaw-class agents.
 *
 * Solana x402 accepts → TWZRD preflight path (gate 0.9.5 / skill check) before sign.
 * Stripe / Link / Tempo / MPP-only → hand off; do NOT run Solana wash on those rails.
 * Empty or template payTo → refuse.
 *
 * This module does not sign, spend, or call the network. Enforcement still lives in
 * AutoGate / twzrd.safeFetch / the host refusal to sign.
 *
 * Evidence objects stay distinct — never collapse to “the receipt”:
 *   witness_shopping_receipt | payment_decision_v1 | intel_receipt_v6_v7
 */

import { classifyNetwork } from "./network.js";

export const EVIDENCE_OBJECTS = [
  "witness_shopping_receipt",
  "payment_decision_v1",
  "intel_receipt_v6_v7",
] as const;

export type EvidenceObjectKind = (typeof EVIDENCE_OBJECTS)[number];

export type ConsumerRail =
  | "solana_twzrd"
  | "stripe_link"
  | "other_unscored"
  | "refuse";

export type HandOffTarget = "stripe-link-cli" | "mpp-agent" | null;

export type AcceptEntry = {
  network?: string | null;
  payTo?: string | null;
  method?: string | null;
  scheme?: string | null;
};

export type ConsumerRoute = {
  rail: ConsumerRail;
  reason: string;
  /** True only for Solana accepts that should hit TWZRD preflight / gate. */
  runTwzrdPreflight: boolean;
  handOff: HandOffTarget;
  /** False when this accept must not reach a signer. */
  canSign: boolean;
  payTo: string | null;
  network: string | null;
  method: string | null;
};

export type Consumer402Route = {
  primary: ConsumerRoute;
  routes: ConsumerRoute[];
  hasSolana: boolean;
  hasStripeLink: boolean;
  /** Guidance when multiple rails appear on one 402. */
  note: string | null;
};

export type SolanaConsumerDecision = {
  action: "pay" | "pay_capped" | "do_not_pay";
  reason: string;
  canSign: boolean;
  escalatePathA: boolean;
  recommendedCapUsdc: number | null;
};

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TEMPLATE_RE =
  /^(?:\{.*\}|:pubkey|PAY_TO_WALLET|SELLER_WALLET|pubkey|wallet)$/i;

export function isUsableSolanaPayTo(payTo: string | null | undefined): boolean {
  if (payTo == null) return false;
  const w = String(payTo).trim();
  if (!w) return false;
  if (TEMPLATE_RE.test(w) || w.includes("{") || w.includes("}") || w.startsWith(":")) {
    return false;
  }
  return BASE58_RE.test(w);
}

function norm(s: string | null | undefined): string {
  return s == null ? "" : String(s).trim().toLowerCase();
}

/** Stripe Link / MPP / Tempo consumer card rails — not Solana wash corpus. */
export function isStripeLinkRail(entry: AcceptEntry): boolean {
  const method = norm(entry.method);
  const scheme = norm(entry.scheme);
  const network = norm(entry.network);
  if (method === "stripe" || method === "link" || method.includes("stripe")) return true;
  if (method === "mpp" || scheme === "mpp") return true;
  if (scheme === "tempo" || network === "tempo" || network.includes("tempo")) return true;
  if (scheme === "link" || network.includes("stripe")) return true;
  return false;
}

function refuseRoute(reason: string, entry: AcceptEntry): ConsumerRoute {
  return {
    rail: "refuse",
    reason,
    runTwzrdPreflight: false,
    handOff: null,
    canSign: false,
    payTo: entry.payTo == null ? null : String(entry.payTo),
    network: entry.network == null ? null : String(entry.network),
    method: entry.method == null ? null : String(entry.method),
  };
}

/**
 * Classify a single 402 accepts[] entry for consumer agents.
 */
export function routeConsumerAccept(entry: AcceptEntry): ConsumerRoute {
  const payTo = entry.payTo == null ? null : String(entry.payTo).trim();
  const network = entry.network == null ? null : String(entry.network);
  const method = entry.method == null ? null : String(entry.method);

  if (isStripeLinkRail(entry)) {
    const m = norm(entry.method);
    const s = norm(entry.scheme);
    const handOff: HandOffTarget =
      m === "mpp" || s === "mpp" || s === "tempo" || norm(entry.network).includes("tempo")
        ? "mpp-agent"
        : "stripe-link-cli";
    return {
      rail: "stripe_link",
      reason: "stripe_or_link_method",
      runTwzrdPreflight: false,
      handOff,
      canSign: true, // host stripe/mpp path decides; TWZRD does not sign here
      payTo,
      network,
      method,
    };
  }

  const cls = classifyNetwork(network, payTo);
  if (cls.kind === "solana") {
    if (!isUsableSolanaPayTo(payTo)) {
      return refuseRoute("empty_or_template_payto", entry);
    }
    return {
      rail: "solana_twzrd",
      reason: "solana_accept",
      runTwzrdPreflight: true,
      handOff: null,
      canSign: true, // still must pass decideSolanaConsumerAction + AutoGate
      payTo,
      network,
      method,
    };
  }

  if (cls.kind === "evm" || cls.kind === "other" || cls.kind === "unknown") {
    return {
      rail: "other_unscored",
      reason: cls.reason || "network_not_scored",
      runTwzrdPreflight: false,
      handOff: null,
      canSign: true, // gate observe/strict owns policy; not Solana wash
      payTo,
      network,
      method,
    };
  }

  return refuseRoute("unusable_accept", entry);
}

/**
 * Route a full 402 body. When both rails appear, Solana accepts still get TWZRD;
 * Stripe/Link accepts are never washed via Solana preflight.
 */
export function routeConsumer402(body: {
  accepts?: AcceptEntry[] | null;
}): Consumer402Route {
  const accepts = Array.isArray(body.accepts) ? body.accepts : [];
  if (accepts.length === 0) {
    const primary = refuseRoute("no_accepts", {});
    return {
      primary,
      routes: [primary],
      hasSolana: false,
      hasStripeLink: false,
      note: null,
    };
  }

  const routes = accepts.map((a) => routeConsumerAccept(a ?? {}));
  const hasSolana = routes.some((r) => r.rail === "solana_twzrd");
  const hasStripeLink = routes.some((r) => r.rail === "stripe_link");

  const solana = routes.find((r) => r.rail === "solana_twzrd");
  const stripe = routes.find((r) => r.rail === "stripe_link");
  const other = routes.find((r) => r.rail === "other_unscored");
  const primary = solana ?? stripe ?? other ?? routes[0]!;

  let note: string | null = null;
  if (hasSolana && hasStripeLink) {
    note = "run_twzrd_on_solana_accept_only";
  } else if (hasSolana) {
    note = "solana_twzrd_before_sign";
  } else if (hasStripeLink) {
    note = "hand_off_stripe_link_no_solana_wash";
  }

  return { primary, routes, hasSolana, hasStripeLink, note };
}

export type SolanaConsumerInput = {
  preflightDecision?: string | null;
  washFlagged?: boolean | null;
  merchantNextAction?: string | null;
  recommendedCapUsdc?: number | null;
  priceUsdc?: number | null;
};

const CARD_REFUSALS = new Set(["refuse", "do_not_pay"]);

/**
 * Hermes-aligned Solana spend verdict after free preflight + merchant_card.
 * Hard stop only on decision=block or merchant_card refuse / cap breach.
 * wash + warn → pay_capped + Path A escalate, not hard stop.
 */
export function decideSolanaConsumerAction(
  input: SolanaConsumerInput,
): SolanaConsumerDecision {
  const decision = norm(input.preflightDecision);
  const next = norm(input.merchantNextAction);

  if (decision === "block") {
    return {
      action: "do_not_pay",
      reason: "preflight_block",
      canSign: false,
      escalatePathA: false,
      recommendedCapUsdc: null,
    };
  }

  if (next && CARD_REFUSALS.has(next)) {
    return {
      action: "do_not_pay",
      reason: "merchant_card_refuses",
      canSign: false,
      escalatePathA: false,
      recommendedCapUsdc: null,
    };
  }

  const cap =
    input.recommendedCapUsdc == null || !Number.isFinite(Number(input.recommendedCapUsdc))
      ? null
      : Number(input.recommendedCapUsdc);
  const price =
    input.priceUsdc == null || !Number.isFinite(Number(input.priceUsdc))
      ? null
      : Number(input.priceUsdc);

  if (cap != null && price != null && price > cap) {
    return {
      action: "do_not_pay",
      reason: "price_exceeds_cap",
      canSign: false,
      escalatePathA: false,
      recommendedCapUsdc: cap,
    };
  }

  const wash = input.washFlagged === true;
  if (wash || decision === "warn") {
    return {
      action: "pay_capped",
      reason: wash ? "wash_escalate" : "preflight_warn",
      canSign: true,
      escalatePathA: true,
      recommendedCapUsdc: cap,
    };
  }

  if (decision === "allow" || decision === "") {
    return {
      action: "pay",
      reason: decision === "allow" ? "preflight_allow" : "preflight_allow",
      canSign: true,
      escalatePathA: false,
      recommendedCapUsdc: cap,
    };
  }

  // Unknown / missing decision → fail closed to capped escalate, not clean pay
  return {
    action: "pay_capped",
    reason: "preflight_unknown",
    canSign: true,
    escalatePathA: true,
    recommendedCapUsdc: cap,
  };
}

export function describeEvidenceObject(kind: EvidenceObjectKind): string {
  switch (kind) {
    case "witness_shopping_receipt":
      return "witness shopping receipt — offer/page evidence at time T (separate service)";
    case "payment_decision_v1":
      return "twzrd.payment_decision.v1 — portable allow|block|warn|unavailable decision receipt";
    case "intel_receipt_v6_v7":
      return "V6/V7 intelligence receipt — paid Path A counterparty score, offline-verifiable";
    default: {
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}
