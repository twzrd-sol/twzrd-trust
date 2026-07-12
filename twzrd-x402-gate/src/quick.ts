/**
 * twzrd quick tier — the $0.001 cheap paid qualify rung.
 *
 * The reputation ladder has three rungs:
 *   free   POST /v1/intel/preflight          -> allow/warn/block (the gate)
 *   $0.001 GET  /v1/intel/quick/{seller}      -> tier + score, NO receipt  <-- this file
 *   $0.05  GET  /v1/intel/trust/{seller}      -> full intel + signed V6 receipt (autoReceipt)
 *
 * Use `quickCheck` when the free preflight is inconclusive (warn / unknown seller)
 * and you want a cheap PAID confirmation of tier+score before committing — without
 * paying 50x for the full portable receipt. It settles $0.001 USDC to TWZRD via the
 * caller-supplied x402Fetch (same BYO-wallet seam as autoReceipt; @x402/svm etc.).
 *
 * FAIL-SOFT: this is an enrichment, not a gate — it NEVER throws. Any gap (no
 * x402Fetch, unreachable, non-200, settle failure) returns available=false with the
 * raw reason, so a quick-tier hiccup can't break the caller's flow. (The hard
 * allow/warn/block decision is the free preflight's job; see gate.ts.)
 */
import type { TwzrdGateConfig } from "./types.js";

export type TwzrdTier = "Bronze" | "Silver" | "Gold" | "Platinum";

const DEFAULT_BASE = "https://intel.twzrd.xyz";
/** Server price for the quick tier (AMOUNT_TEASER = "1000" micro = $0.001). */
export const QUICK_PRICE_USDC = 0.001;

export interface QuickCheckResult {
  sellerWallet: string;
  /** Bronze <40, Silver >=40, Gold >=100, Platinum >=180 (server thresholds). */
  tier: TwzrdTier | null;
  score: number | null;
  payments: number | null;
  lastSeen: string | null;
  /** true when the $0.001 settle landed and data came back. */
  paid: boolean;
  chargedUsdc: number | null;
  /** false when the quick endpoint could not produce an answer (fail-soft path). */
  available: boolean;
  reason: string;
}

export type QuickCheckOptions = Pick<TwzrdGateConfig, "intelBase" | "fetch"> & {
  /** x402-capable fetch that settles the $0.001 quick charge. Without it: available=false. */
  x402Fetch?: typeof fetch;
  /** ms before the quick call gives up. Default 5000. */
  timeoutMs?: number;
};

function unavailable(sellerWallet: string, reason: string): QuickCheckResult {
  return { sellerWallet, tier: null, score: null, payments: null, lastSeen: null,
    paid: false, chargedUsdc: null, available: false, reason };
}

/**
 * $0.001 paid tier+score check for a seller wallet. Never throws (fail-soft).
 * Requires an x402-capable `x402Fetch` to settle the charge.
 */
export async function quickCheck(
  sellerWallet: string,
  opts: QuickCheckOptions = {},
): Promise<QuickCheckResult> {
  if (!sellerWallet) return unavailable(sellerWallet, "no seller wallet supplied");
  const x402 = opts.x402Fetch;
  if (typeof x402 !== "function") {
    return unavailable(sellerWallet, "no x402Fetch — quick tier needs a paying fetch ($0.001)");
  }
  const base = (opts.intelBase ?? DEFAULT_BASE).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await x402(
      `${base}/v1/intel/quick/${encodeURIComponent(sellerWallet)}`,
      { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal },
    );
    if (!resp.ok) return unavailable(sellerWallet, `quick HTTP ${resp.status}`);
    const body = (await resp.json()) as Record<string, unknown>;
    const score = typeof body.score === "number" ? body.score : null;
    const tier = (typeof body.tier === "string" ? body.tier : null) as TwzrdTier | null;
    const payments = typeof body.payments === "number" ? body.payments : null;
    const lastSeen = typeof body.last_seen === "string" ? body.last_seen : null;
    const chargedUsdc = typeof body.charged_amount_usdc === "number" ? body.charged_amount_usdc : null;
    return {
      sellerWallet, tier, score, payments, lastSeen,
      paid: body.paid === true,
      chargedUsdc,
      available: score !== null || tier !== null,
      reason: `quick tier ${tier ?? "?"} (score=${score})`,
    };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 80);
    return unavailable(sellerWallet, `quick unreachable: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}
