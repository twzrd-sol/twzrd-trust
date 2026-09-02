/**
 * Optional seller-side x402 pre-settlement guard (merchant customer policy).
 *
 * Core product of this package is the BUYER gate: a payer screens the merchant
 * (payTo) before spending. This module is the other direction and is optional:
 * a resource server (merchant), before it settles an inbound x402 payment, can
 * screen the payer for policy reasons (abuse, sanctions, bots, customer selection)
 * and veto settlement. It is not an equal product mirror of the buyer gate —
 * settled USDC is final; wash resistance is primarily TWZRD scoring (discount
 * bad edges), not forcing merchants to reject revenue to stay "clean."
 *
 * Attaches to the official, unit-tested `x402ResourceServer.onBeforeSettle`
 * hook (inherited by @x402/express|hono|next|fastify and python x402), whose
 * contract is:
 *   BeforeSettleHook = (ctx) => Promise<void | { abort: true; reason; message? }>
 * TWZRD is NEVER in the settlement path: the guard is ADVISORY and FAIL-OPEN —
 * any error, timeout, unresolved payer, or unavailable signal returns "continue"
 * (void), never blocking legitimate revenue on infra failure (unless
 * `failOpen: false` is set intentionally).
 *
 * Vendor-neutral: the context view and payer extractor are structural, so the
 * same guard fits PayAI agentic-payments `onPaymentVerified` (returns
 * `{ reject: true }` — see toPayaiVerifyResult) and any hook that exposes the
 * payer. Zero hard runtime deps; `screen` is injected for testability.
 * Optional peer `@x402/svm` is used only to recover the token payer from an
 * exact-SVM base64 transaction payload.
 */

import { fetchMerchantCard, type TwzrdMerchantCard } from "./merchant-card.js";
import type { TwzrdDecision } from "./types.js";

/**
 * Minimal structural view of an x402 `BeforeSettleHook`/`BeforeVerifyHook`
 * context. Mirrors @x402/core (paymentPayload + requirements) WITHOUT importing
 * the SDK, so this stays zero-dep and runtime-agnostic. x402 `PaymentPayload`
 * carries the scheme-specific `payload: Record<string, unknown>` where the payer
 * lives (its exact key varies by scheme: exact-svm vs exact-evm).
 */
export type SettleGuardContext = {
  paymentPayload?:
    | {
        payload?: Record<string, unknown> | null;
        payer?: unknown;
        [k: string]: unknown;
      }
    | null;
  requirements?: unknown;
  [k: string]: unknown;
};

/** The abort object the x402 onBeforeSettle/onBeforeVerify hook understands. */
export type SettleGuardAbort = { abort: true; reason: string; message?: string };

/** void = continue settlement; SettleGuardAbort = veto before money moves. */
export type SettleGuardResult = void | SettleGuardAbort;

/**
 * Result of screening a payer wallet against TWZRD. All fields optional so an
 * unavailable signal fails open (undefined/null -> no abort) when failOpen.
 */
export type PayerScreen = {
  decision?: TwzrdDecision;
  /** true = wash/sybil payer; false = clean; null/undefined = signal unavailable. */
  washFlagged?: boolean | null;
  tier?: string | null;
  inCorpus?: boolean;
  score?: number | null;
  reason?: string;
};

export type ScreenFn = (
  payer: string,
  ctx: SettleGuardContext,
) => Promise<PayerScreen | null> | PayerScreen | null;

export type GetPayerFn = (
  ctx: SettleGuardContext,
) => string | null | undefined | Promise<string | null | undefined>;

export type SettleGuardOptions = {
  /**
   * How to score the incoming payer. Injected for testability + vendor
   * neutrality. Use `twzrdPayerScreen()` for the default free merchant_card
   * screen, or supply your own (e.g. a paid /v1/intel/trust call, or a cache).
   */
  screen: ScreenFn;
  /** Extract the payer wallet from the hook context. Default: defaultExtractPayer. */
  getPayer?: GetPayerFn;
  /**
   * Which screen outcomes abort settlement. Default: block + wash-flagged abort;
   * warn is allowed (matches the buyer gate's "gate only on block/wash" default).
   */
  abortOn?: { block?: boolean; warn?: boolean; washFlagged?: boolean };
  /**
   * On screen error/timeout/unresolved-payer/null-screen, continue (never block
   * real revenue on infra failure). Default: true. Set false only if you would
   * rather refuse a payment than settle one you could not screen.
   */
  failOpen?: boolean;
  /**
   * Max ms to wait for `screen` (and async payer extraction). Default 3000.
   * On timeout: fail-open continues, fail-closed aborts with
   * `twzrd_screen_timeout`. Set 0 to disable.
   */
  timeoutMs?: number;
  /** Optional per-call observability. Never throws into the payment path. */
  onDecision?: (info: {
    payer: string | null;
    screen: PayerScreen | null;
    aborted: boolean;
    reason: string;
  }) => void;
};

const DEFAULT_ABORT_ON = { block: true, warn: false, washFlagged: true } as const;
/** Default screen budget — short so settlement is not held open. */
const DEFAULT_TIMEOUT_MS = 3000;

function asNonEmptyString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function recordOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * True when the payload has an authoritative scheme shape whose payer must come
 * from signed/encoded fields — not from client-supplied aliases like `payer`.
 */
function hasAuthoritativeSchemeShape(pl: Record<string, unknown> | null): boolean {
  if (!pl) return false;
  if (recordOf(pl.authorization)) return true;
  if (recordOf(pl.permit2Authorization)) return true;
  if (typeof pl.transaction === "string" && pl.transaction.trim()) return true;
  return false;
}

/**
 * Recover the token payer (owner of the source ATA) from an exact-SVM base64
 * transaction via optional peer `@x402/svm`. Returns null when the peer is
 * missing or the payload cannot be decoded.
 */
export async function extractSvmPayerFromTransaction(
  transaction: string,
): Promise<string | null> {
  const tx = transaction.trim();
  // Cheap reject before dynamic import / upstream console.error on garbage.
  if (!tx || tx.length < 32 || !/^[A-Za-z0-9+/]+=*$/.test(tx)) return null;
  try {
    const svm = await import("@x402/svm");
    const decoded = svm.decodeTransactionFromPayload({ transaction: tx });
    const payer = svm.getTokenPayerFromTransaction(decoded);
    return asNonEmptyString(payer);
  } catch {
    return null;
  }
}

let svmPeer: Promise<boolean> | undefined;
/** Whether the optional `@x402/svm` peer resolves (memoized per process). */
function svmPeerAvailable(): Promise<boolean> {
  return (svmPeer ??= import("@x402/svm").then(() => true, () => false));
}

let warnedSvmPeerMissing = false;
/**
 * An exact-SVM payload whose payer is unresolved because the optional peer is
 * not installed is a configuration gap, not a per-payment edge: under
 * fail-open it silently disables screening for ALL SVM traffic. Name it
 * distinctly and warn once (W-2026-0902 #3).
 */
async function svmShapeWithoutPeer(ctx: SettleGuardContext): Promise<boolean> {
  const pl = recordOf(recordOf(ctx?.paymentPayload)?.payload);
  if (typeof pl?.transaction !== "string" || !pl.transaction.trim()) return false;
  if (await svmPeerAvailable()) return false;
  if (!warnedSvmPeerMissing) {
    warnedSvmPeerMissing = true;
    console.warn(
      "[twzrd-x402-gate] svm_peer_missing: install optional peer @x402/svm to screen exact-SVM payers; the settle guard cannot screen them until then",
    );
  }
  return true;
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Authoritative payer extraction across x402 schemes (svm/evm) and PayAI-flat
 * shapes.
 *
 * Priority (signed/encoded first — never let a client-supplied alias outrank
 * them):
 *   1. exact-EVM EIP-3009 `payload.authorization.from`
 *   2. exact-EVM Permit2 `payload.permit2Authorization.from`
 *   3. exact-SVM `payload.transaction` → decode via optional `@x402/svm`
 *   4. Loose aliases (`payload.payer|from|account|sender`, top-level
 *      `paymentPayload.payer`, flat `ctx.payer`) ONLY when no authoritative
 *      scheme shape is present — otherwise a spoofed `payer: "clean"` next to
 *      a signed wash authorization would bypass screening.
 *
 * Async because SVM recovery may dynamic-import the optional peer.
 * Returns null when unresolved (-> fail-open / fail-closed per options).
 */
export async function defaultExtractPayer(
  ctx: SettleGuardContext,
): Promise<string | null> {
  const pp = ctx?.paymentPayload ?? null;
  const pl =
    pp && typeof pp === "object"
      ? ((pp.payload ?? null) as Record<string, unknown> | null)
      : null;

  // 1) EIP-3009 exact-EVM
  const auth = recordOf(pl?.authorization);
  const eipFrom = asNonEmptyString(auth?.from) ?? asNonEmptyString(auth?.payer);
  if (eipFrom) return eipFrom;

  // 2) Permit2 exact-EVM
  const permit2 = recordOf(pl?.permit2Authorization);
  const permitFrom = asNonEmptyString(permit2?.from);
  if (permitFrom) return permitFrom;

  // 3) exact-SVM base64 transaction (optional peer)
  if (typeof pl?.transaction === "string" && pl.transaction.trim()) {
    const svmPayer = await extractSvmPayerFromTransaction(pl.transaction);
    if (svmPayer) return svmPayer;
    // Authoritative shape present but unrecoverable — do NOT fall through to
    // spoofable aliases.
    return null;
  }

  // 4) Loose / PayAI shapes only when no signed scheme body is present.
  if (hasAuthoritativeSchemeShape(pl)) {
    return null;
  }

  const loose: unknown[] = [
    pl?.payer,
    pl?.from,
    pl?.account,
    pl?.sender,
    pp && typeof pp === "object" ? pp.payer : null,
    (ctx as Record<string, unknown>)?.payer,
  ];
  for (const c of loose) {
    const s = asNonEmptyString(c);
    if (s) return s;
  }
  return null;
}

function decideAbort(
  screen: PayerScreen,
  abortOn: { block?: boolean; warn?: boolean; washFlagged?: boolean },
): SettleGuardAbort | null {
  if (abortOn.washFlagged && screen.washFlagged === true) {
    return {
      abort: true,
      reason: "twzrd_payer_wash_flagged",
      message: "payer flagged as wash/sybil by TWZRD",
    };
  }
  if (abortOn.block && screen.decision === "block") {
    return {
      abort: true,
      reason: "twzrd_payer_block",
      message: "payer scored block by TWZRD",
    };
  }
  if (abortOn.warn && screen.decision === "warn") {
    return {
      abort: true,
      reason: "twzrd_payer_warn",
      message: "payer scored warn by TWZRD",
    };
  }
  return null;
}

/**
 * Create an x402 `onBeforeSettle(hook)` that screens the incoming PAYER against
 * TWZRD and vetoes wash/blocked payers before settlement. Advisory + fail-open
 * by default (with a hard timeout around screening).
 *
 *   const server = new x402ResourceServer(facilitator);
 *   server.onBeforeSettle(createTwzrdSettleGuard({ screen: twzrdPayerScreen() }));
 */
export function createTwzrdSettleGuard(
  opts: SettleGuardOptions,
): (ctx: SettleGuardContext) => Promise<SettleGuardResult> {
  const abortOn = { ...DEFAULT_ABORT_ON, ...(opts.abortOn ?? {}) };
  const failOpen = opts.failOpen !== false;
  const getPayer = opts.getPayer ?? defaultExtractPayer;
  const timeoutMs =
    typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  return async function twzrdSettleGuard(
    ctx: SettleGuardContext,
  ): Promise<SettleGuardResult> {
    let payer: string | null = null;
    const emit = (screen: PayerScreen | null, aborted: boolean, reason: string) => {
      try {
        opts.onDecision?.({ payer, screen, aborted, reason });
      } catch {
        /* observability must never break the payment path */
      }
    };

    const run = async (): Promise<SettleGuardResult> => {
      payer = (await getPayer(ctx)) ?? null;
      if (!payer) {
        const peerMissing = await svmShapeWithoutPeer(ctx);
        const reason = peerMissing ? "twzrd_svm_peer_missing" : "twzrd_payer_unresolved";
        if (!failOpen) {
          emit(null, true, `${reason}_failclosed`);
          return {
            abort: true,
            reason,
            message: peerMissing
              ? "exact-SVM payer needs optional peer @x402/svm to be screened"
              : "could not resolve payer wallet for screening",
          };
        }
        emit(null, false, reason);
        return; // fail-open: cannot screen an unknown payer
      }

      const screen = await opts.screen(payer, ctx);
      if (!screen) {
        if (!failOpen) {
          emit(null, true, "twzrd_screen_unavailable_failclosed");
          return {
            abort: true,
            reason: "twzrd_screen_unavailable",
            message: "payer screen returned no signal",
          };
        }
        emit(null, false, "twzrd_screen_unavailable");
        return; // fail-open: no signal, do not invent risk
      }

      const abort = decideAbort(screen, abortOn);
      if (abort) {
        emit(screen, true, abort.reason);
        return abort;
      }
      emit(screen, false, screen.reason ?? "twzrd_payer_ok");
      return;
    };

    try {
      // Single end-to-end budget for extract + screen (documented timeout).
      return await withTimeout(run(), timeoutMs, "twzrd_screen_timeout");
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const isTimeout = msg === "twzrd_screen_timeout" || /timeout/i.test(msg);
      if (failOpen) {
        emit(null, false, isTimeout ? "twzrd_screen_timeout_failopen" : "twzrd_screen_error_failopen");
        return;
      }
      emit(null, true, isTimeout ? "twzrd_screen_timeout_failclosed" : "twzrd_screen_error_failclosed");
      return {
        abort: true,
        reason: isTimeout ? "twzrd_screen_timeout" : "twzrd_screen_error",
        message: msg,
      };
    }
  };
}

/**
 * Reference payer screen: free `GET /v1/intel/merchant_card/{payer}`. Returns
 * the wash signal for the payer wallet (fail-open null on outage/absent). The
 * free merchant_card is keyed by any wallet that appears in the corpus as a
 * counterparty, so it resolves payer wallets too. For richer screening
 * (decision/score) inject a `screen` that calls the paid `/v1/intel/trust`
 * endpoint instead — kept out of the default to avoid a per-payment cost on the
 * hot path.
 */
export function twzrdPayerScreen(opts?: {
  intelBase?: string;
  fetch?: typeof fetch;
}): ScreenFn {
  const intelBase = (
    opts?.intelBase ??
    process.env.TWZRD_INTEL_BASE ??
    "https://intel.twzrd.xyz"
  ).replace(/\/+$/, "");
  const fetchImpl = opts?.fetch ?? (globalThis.fetch as typeof fetch);

  return async function screen(payer: string): Promise<PayerScreen | null> {
    const card: TwzrdMerchantCard | null = await fetchMerchantCard(payer, {
      intelBase,
      fetch: fetchImpl,
    });
    if (!card) return null; // fail-open
    const washFlagged =
      typeof card.wash_flagged === "boolean" ? card.wash_flagged : null;
    const tier =
      typeof card.provider_reputation_tier === "string"
        ? card.provider_reputation_tier
        : null;
    return {
      washFlagged,
      tier,
      inCorpus: card.in_corpus === true,
      reason:
        washFlagged === true
          ? "twzrd_payer_wash_flagged"
          : "twzrd_payer_merchant_card",
    };
  };
}

/**
 * Adapt a SettleGuardResult to the PayAI agentic-payments `onPaymentVerified`
 * return shape (`{ reject: true, reason }`). PayAI swallows thrown hook errors,
 * so a guard must RETURN the reject object, not throw — this helper does that.
 */
export function toPayaiVerifyResult(
  result: SettleGuardResult,
): { reject: true; reason: string } | undefined {
  if (result && (result as SettleGuardAbort).abort === true) {
    return { reject: true, reason: (result as SettleGuardAbort).reason };
  }
  return undefined;
}
