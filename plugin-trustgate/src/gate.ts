/**
 * twzrd trust-gate core - dependency-free.
 *
 * Buyer-side x402 spend guard for autonomous agents. Before signing a payment to
 * a seller, call the FREE TWZRD preflight (no auth, no cost) and refuse when the
 * decision is "block" (e.g. a wash-flagged / captive-payer merchant).
 *
 * Fail-open by default: a preflight outage returns a non-blocking verdict with
 * gateAvailable=false so the agent is never bricked by an intel hiccup. Set
 * failOpen=false for strict mode (block on any outage) when security > liveness.
 *
 * No @elizaos/core or @solana/web3.js dependency - usable from any JS runtime.
 */

export type TwzrdDecision = "allow" | "warn" | "block";

export interface TrustGateConfig {
  /** Free preflight host. Default https://intel.twzrd.xyz */
  intelBase?: string;
  /**
   * Also block when trust_score < this, even if decision !== "block". Default 0 (decision-only).
   * Sharp edge: unknown sellers score 45 (default_no_data), so minScore > 45 blocks every
   * not-yet-seen merchant. Use deliberately.
   */
  minScore?: number;
  /** Injectable fetch (tests / non-global-fetch runtimes). Default globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** ms before the gate gives up on the preflight. Default 4000. */
  timeoutMs?: number;
  /** On a preflight outage: true (default) = allow (do not brick the agent); false = block (strict). */
  failOpen?: boolean;
}

export interface TrustVerdict {
  sellerWallet: string;
  decision: TwzrdDecision;
  trustScore: number | null;
  canSpend: boolean;
  /** true => DO NOT sign/spend. */
  blocked: boolean;
  reason: string;
  /** false when the preflight was unreachable (the verdict came from the fail-open/closed path). */
  gateAvailable: boolean;
}

const DEFAULT_BASE = "https://intel.twzrd.xyz";

/**
 * Score a seller wallet via the free TWZRD preflight. Never throws.
 */
export async function checkTrust(
  sellerWallet: string,
  config: TrustGateConfig = {},
): Promise<TrustVerdict> {
  const base = (config.intelBase ?? DEFAULT_BASE).replace(/\/+$/, "");
  const minScore = config.minScore ?? 0;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 4000;
  const failOpen = config.failOpen ?? true;

  if (!sellerWallet) return gateUnavailable(sellerWallet, "no seller wallet supplied", failOpen);
  if (typeof doFetch !== "function") return gateUnavailable(sellerWallet, "no fetch implementation", failOpen);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/v1/intel/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seller_wallet: sellerWallet }),
      signal: ctrl.signal,
    });
    if (!res.ok) return gateUnavailable(sellerWallet, `preflight HTTP ${res.status}`, failOpen);
    const body = (await res.json()) as Record<string, unknown>;
    const card = (body.readiness_card ?? body) as Record<string, unknown>;
    const decision = String(card.decision ?? "warn").toLowerCase() as TwzrdDecision;
    const trustScore = typeof card.trust_score === "number" ? card.trust_score : null;
    const canSpend = card.can_spend === true;
    const scoreBlocks = minScore > 0 && trustScore !== null && trustScore < minScore;
    const blocked = decision === "block" || scoreBlocks;
    const reason = !blocked
      ? `TWZRD preflight: ${decision} (trust_score=${trustScore})`
      : decision === "block"
        ? `TWZRD preflight blocked (trust_score=${trustScore})`
        : `trust_score ${trustScore} below min ${minScore}`;
    return { sellerWallet, decision, trustScore, canSpend, blocked, reason, gateAvailable: true };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 80);
    return gateUnavailable(sellerWallet, `preflight unreachable: ${msg}`, failOpen);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience guard: true => safe to sign/spend, false => abort the payment.
 * Respects config.failOpen (default true => safe on a preflight outage).
 */
export async function canSpendSafely(
  sellerWallet: string,
  config: TrustGateConfig = {},
): Promise<boolean> {
  return !(await checkTrust(sellerWallet, config)).blocked;
}

/** Verdict for the "preflight could not produce an answer" path. */
function gateUnavailable(sellerWallet: string, reason: string, failOpen: boolean): TrustVerdict {
  return {
    sellerWallet,
    decision: failOpen ? "warn" : "block",
    trustScore: null,
    canSpend: false,
    blocked: !failOpen, // fail-open (default): never brick the agent; strict: block on outage
    reason: `${failOpen ? "fail-open" : "fail-closed"} (${reason})`,
    gateAvailable: false,
  };
}
