/**
 * Product default paying path (2026-08-22).
 *
 * One job before sign:
 *   GET merchant_card/{payTo} → abort on measured wash, and on
 *   null/partial/stale/missing coverage (unknown ≠ clean).
 *   abort on timeout / 5xx / 429 / throw (intel outage). Opt in to
 *   proceed-on-outage with failOpen / TWZRD_FAIL_OPEN.
 *
 * No Path A, no requireReceipt, no escalateOnWarn, no payment-control tokens,
 * no readiness preflight. Framework authors can read this file in ~60s.
 *
 * Full 0.8.x engine: createTwzrdBeforePaymentHook({ engine: "full" }) or
 * createTwzrdFullBeforePaymentHook().
 *
 * Self-contained (no import from x402-client-hook) to avoid cycles.
 */

import {
  applyWashFlaggedPolicy,
  fetchMerchantCardResult,
  type MerchantCardLookup,
  type TwzrdMerchantCard,
} from "./merchant-card.js";
import { priceUsdcFromAmountMicro } from "./payto.js";
import { CLIENT_VERSION } from "./version.js";

const PARTIAL_WASH_CONFIDENCE = new Set([
  "base_2cycle",
  "partial_inbound_only",
  "partial",
  "unknown",
  "unmeasured",
  "none",
]);

export type WashEvidence = {
  washFlagged: boolean | null;
  washConfidence: string | null;
  ringEvaluated: boolean | null;
  stale: boolean;
};

export function washEvidenceFromCard(card: TwzrdMerchantCard): WashEvidence {
  const rec = card as TwzrdMerchantCard & Record<string, unknown>;
  const washFlagged =
    typeof rec.wash_flagged === "boolean" ? rec.wash_flagged : null;
  const rawConfidence =
    typeof rec.wash_confidence === "string" && rec.wash_confidence.trim()
      ? rec.wash_confidence
      : typeof rec.confidence === "string" && String(rec.confidence).trim()
        ? String(rec.confidence)
        : null;
  const washConfidence = rawConfidence ? rawConfidence.trim() : null;
  const nested = rec.circular_flow_signals as { ring_evaluated?: boolean } | undefined;
  const ringEvaluated =
    typeof rec.ring_evaluated === "boolean"
      ? rec.ring_evaluated
      : typeof nested?.ring_evaluated === "boolean"
        ? nested.ring_evaluated
        : null;
  // Corpus-age `stale` on merchant_card is a warning, not wash-overlay refuse.
  const stale = rec.wash_stale === true;
  return { washFlagged, washConfidence, ringEvaluated, stale };
}

export function isWashCoverageAdequate(ev: {
  washConfidence?: string | null;
  ringEvaluated?: boolean | null;
  stale?: boolean | null;
}): boolean {
  if (ev.stale === true) return false;
  if (ev.ringEvaluated === false) return false;
  const c = (ev.washConfidence ?? "").trim().toLowerCase();
  if (c) {
    if (PARTIAL_WASH_CONFIDENCE.has(c)) return false;
    if (c === "full") return true;
    return false;
  }
  return false;
}

/** Minimal requirements shape (same fields as x402-client-hook). */
export type WashSelectedRequirements = {
  payTo?: string;
  pay_to?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  resource?: string;
  scheme?: string;
};

export type WashDeclaredResource = string | { url?: string };

export type WashBeforePaymentContext = {
  requestUrl?: string;
  responseUrl?: string;
  declaredResource?: WashDeclaredResource;
  protocolVersion?: 1 | 2;
  signal?: AbortSignal;
};

export type WashBeforePaymentResult = void | { abort: true; reason: string };

export type WashDefaultOptions = {
  /** Default https://intel.twzrd.xyz */
  intelBase?: string;
  /** Injectable fetch (tests). Default globalThis.fetch */
  fetch?: typeof fetch;
  /** Same pair as installTwzrdAutoGate — stamps X-Twzrd-Caller on merchant_card. */
  attribution?: { integration: string; runId: string };
  /** merchant_card timeout ms. Default 3000. On timeout → abort unless failOpen. */
  timeoutMs?: number;
  /**
   * When true, intel outage (5xx/429/throw/timeout/bad JSON) proceeds.
   * Default false (fail-closed). TWZRD_FAIL_OPEN=true/1 also opts in.
   */
  failOpen?: boolean;
  /**
   * Abort on measured wash and on unknown/partial/stale coverage.
   * Default true. Set false only to disable the product brake.
   */
  refuseWashFlagged?: boolean;
  /**
   * Soft cap: if wash_flagged and priceUsdc <= washMaxUsdc, allow.
   * Default null = hard refuse on wash_flagged.
   */
  washMaxUsdc?: number | null;
  /** Optional telemetry; never throws into the payment path. */
  onDecision?: (detail: {
    approved: boolean;
    reason: string;
    payTo?: string;
    washFlagged: boolean | null;
    failOpen?: boolean;
  }) => void;
};

function flattenDeclaredResource(
  declared?: WashDeclaredResource,
): string | undefined {
  if (typeof declared === "string") return declared;
  if (declared && typeof declared.url === "string" && declared.url.length > 0) {
    return declared.url;
  }
  return undefined;
}

/** Map stock-client requirements into wash evaluator input. */
export function mapWashRequirements(
  requirements: WashSelectedRequirements & Record<string, unknown>,
  context?: WashBeforePaymentContext,
): WashSelectedRequirements {
  const payTo =
    (requirements.payTo as string | undefined) ??
    (requirements.pay_to as string | undefined);
  const amount =
    (requirements.amount as string | undefined) ??
    (requirements.maxAmountRequired as string | undefined);
  const reqResource = requirements.resource;
  const resourceFromReq =
    typeof reqResource === "string"
      ? reqResource
      : flattenDeclaredResource(reqResource as WashDeclaredResource | undefined);
  const resource =
    resourceFromReq ??
    flattenDeclaredResource(context?.declaredResource) ??
    context?.requestUrl;
  return {
    payTo,
    pay_to: payTo,
    network: requirements.network as string | undefined,
    amount,
    maxAmountRequired: amount,
    asset: requirements.asset as string | undefined,
    resource,
    scheme: requirements.scheme as string | undefined,
  };
}

function resolveIntelBase(opts?: WashDefaultOptions): string {
  return (
    opts?.intelBase ??
    process.env.TWZRD_INTEL_BASE ??
    "https://intel.twzrd.xyz"
  ).replace(/\/+$/, "");
}

function resolveFetch(opts?: WashDefaultOptions): typeof fetch {
  const f = opts?.fetch ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("[twzrd-x402-gate] fetch is not available; pass options.fetch");
  }
  return f;
}

function resolveRefuseWash(opts?: WashDefaultOptions): boolean {
  if (opts?.refuseWashFlagged != null) return opts.refuseWashFlagged;
  const env = process.env.TWZRD_REFUSE_WASH_FLAGGED;
  if (env === "0" || env === "false") return false;
  return true;
}

function resolveWashMaxUsdc(opts?: WashDefaultOptions): number | null {
  if (opts?.washMaxUsdc != null && Number.isFinite(opts.washMaxUsdc)) {
    return opts.washMaxUsdc;
  }
  if (process.env.TWZRD_WASH_MAX_USDC != null && process.env.TWZRD_WASH_MAX_USDC !== "") {
    const n = Number(process.env.TWZRD_WASH_MAX_USDC);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function resolveFailOpen(opts?: WashDefaultOptions): boolean {
  if (opts?.failOpen != null) return opts.failOpen;
  return process.env.TWZRD_FAIL_OPEN === "true" || process.env.TWZRD_FAIL_OPEN === "1";
}

async function fetchMerchantCardTimed(
  payTo: string,
  opts: {
    intelBase: string;
    fetch: typeof fetch;
    timeoutMs: number;
    attribution?: { integration: string; runId: string };
  },
): Promise<{ lookup: MerchantCardLookup; timedOut: boolean }> {
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 3000;
  let timedOut = false;
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    ac &&
    setTimeout(() => {
      timedOut = true;
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

  try {
    const wrappedFetch: typeof fetch = (input, init) => {
      const next = { ...(init ?? {}) } as RequestInit;
      if (ac && !next.signal) next.signal = ac.signal;
      return opts.fetch(input, next);
    };
    const lookup = await fetchMerchantCardResult(payTo, {
      intelBase: opts.intelBase,
      fetch: wrappedFetch,
    });
    return { lookup, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Product evaluator: wash_flagged only. Fail-open on every non-boolean wash.
 */
export async function evaluateWashOnlyBeforePayment(
  selected: WashSelectedRequirements,
  options?: WashDefaultOptions,
): Promise<WashBeforePaymentResult> {
  const payTo = selected.payTo ?? selected.pay_to;
  const amountMicro = selected.amount ?? selected.maxAmountRequired;
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

  const emit = (detail: {
    approved: boolean;
    reason: string;
    washFlagged: boolean | null;
    failOpen?: boolean;
  }) => {
    try {
      options?.onDecision?.({ ...detail, payTo });
    } catch {
      /* never break payment path */
    }
  };

  if (!payTo || !String(payTo).trim()) {
    emit({
      approved: true,
      reason: "twzrd_wash_skip_no_payTo",
      washFlagged: null,
      failOpen: true,
    });
    return undefined;
  }

  if (!resolveRefuseWash(options)) {
    emit({
      approved: true,
      reason: "twzrd_wash_disabled",
      washFlagged: null,
    });
    return undefined;
  }

  const intelBase = resolveIntelBase(options);
  const fetchFn = resolveFetch(options);
  const timeoutMs =
    typeof options?.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : Number(process.env.TWZRD_WASH_TIMEOUT_MS ?? "3000") || 3000;

  const { lookup, timedOut } = await fetchMerchantCardTimed(payTo, {
    intelBase,
    fetch: fetchFn,
    timeoutMs,
    attribution: options?.attribution,
  });

  if (!lookup.reachable) {
    const error = timedOut ? "timeout" : lookup.error;
    const reason = `twzrd_card_unreachable_fail_closed (${error})`;
    if (resolveFailOpen(options)) {
      emit({
        approved: true,
        reason: timedOut ? "twzrd_wash_fail_open_timeout" : "twzrd_wash_fail_open",
        washFlagged: null,
        failOpen: true,
      });
      return undefined;
    }
    emit({ approved: false, reason, washFlagged: null });
    return { abort: true, reason };
  }

  if (!lookup.card) {
    const reason = "twzrd_wash_unknown";
    emit({ approved: false, reason, washFlagged: null });
    return { abort: true, reason };
  }

  const evidence = washEvidenceFromCard(lookup.card);
  // Measured wash refuses even when coverage fields are absent.
  if (evidence.washFlagged === true) {
    const wash = applyWashFlaggedPolicy({
      approved: true,
      reason: "twzrd_wash_ok",
      washFlagged: true,
      refuseWashFlagged: true,
      washMaxUsdc: resolveWashMaxUsdc(options),
      priceUsdc,
    });
    if (!wash.approved) {
      const reason = `[twzrd] ${wash.reason} payTo=${payTo}`;
      emit({ approved: false, reason, washFlagged: wash.washFlagged });
      return { abort: true, reason };
    }
  }
  if (!isWashCoverageAdequate(evidence)) {
    const reason = "twzrd_wash_unknown";
    emit({
      approved: false,
      reason,
      washFlagged: evidence.washFlagged,
    });
    return { abort: true, reason };
  }
  const wash = applyWashFlaggedPolicy({
    approved: true,
    reason: "twzrd_wash_ok",
    washFlagged: evidence.washFlagged,
    refuseWashFlagged: true,
    washMaxUsdc: resolveWashMaxUsdc(options),
    priceUsdc,
  });

  if (!wash.approved) {
    const reason = `[twzrd] ${wash.reason} payTo=${payTo}`;
    emit({ approved: false, reason, washFlagged: wash.washFlagged });
    return { abort: true, reason };
  }

  emit({
    approved: true,
    reason: wash.reason,
    washFlagged: wash.washFlagged,
  });
  return undefined;
}

/**
 * Stock PayAI seat hook — product default (wash only).
 * Signature matches createX402Client({ beforePayment }).
 */
export function createTwzrdWashBeforePaymentHook(
  options?: WashDefaultOptions,
): (
  requirements: WashSelectedRequirements & Record<string, unknown>,
  context?: WashBeforePaymentContext,
) => Promise<WashBeforePaymentResult> {
  return async (requirements, context) => {
    if (context?.signal?.aborted) {
      return {
        abort: true,
        reason: "[twzrd] aborted_before_payment: signal already aborted",
      };
    }
    const selected = mapWashRequirements(requirements, context);
    return evaluateWashOnlyBeforePayment(selected, options);
  };
}

/**
 * Drop-in config for framework authors.
 *
 * Replace:
 *   createX402Client({ wallet })
 * with:
 *   createX402Client(createTwzrdPayingClient({ wallet }))
 *
 * Does not import x402-solana (peer). Returns the object you pass through.
 */
export type CreateTwzrdPayingClientInput<W = unknown> = WashDefaultOptions & {
  wallet: W;
  network?: string;
  /** Extra createX402Client fields (rpcUrl, …) — passed through. */
  [key: string]: unknown;
};

export type CreateTwzrdPayingClientResult<W = unknown> = {
  wallet: W;
  network: string;
  beforePayment: ReturnType<typeof createTwzrdWashBeforePaymentHook>;
  /** Stamped so hosts can log which seat they took. */
  twzrdGate: { version: string; engine: "wash" };
  [key: string]: unknown;
};

export function createTwzrdPayingClient<W = unknown>(
  input: CreateTwzrdPayingClientInput<W>,
): CreateTwzrdPayingClientResult<W> {
  const {
    wallet,
    network = "solana",
    intelBase,
    fetch: fetchFn,
    timeoutMs,
    refuseWashFlagged,
    washMaxUsdc,
    failOpen,
    onDecision,
    ...passthrough
  } = input;

  const washOpts: WashDefaultOptions = {
    intelBase,
    fetch: fetchFn,
    timeoutMs,
    refuseWashFlagged,
    washMaxUsdc,
    failOpen,
    onDecision,
  };

  return {
    ...passthrough,
    wallet,
    network,
    beforePayment: createTwzrdWashBeforePaymentHook(washOpts),
    twzrdGate: { version: CLIENT_VERSION, engine: "wash" },
  };
}
