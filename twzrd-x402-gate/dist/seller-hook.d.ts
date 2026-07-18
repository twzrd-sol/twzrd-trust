/**
 * Seller-side x402 pre-settlement guard — the MIRROR of the buyer gate.
 *
 * The rest of this package gates a PAYER's outgoing spend (buyer screens the
 * seller before paying). This module is the other direction: a resource server
 * (SELLER), before it settles an incoming x402 payment, screens the PAYER
 * against TWZRD's payer-graph reputation and can veto settlement of
 * wash / sybil / abusive payers — keeping the seller's own demand-quality
 * reputation clean (captive/wash inbound is exactly what TWZRD flags).
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
import type { TwzrdDecision } from "./types.js";
/**
 * Minimal structural view of an x402 `BeforeSettleHook`/`BeforeVerifyHook`
 * context. Mirrors @x402/core (paymentPayload + requirements) WITHOUT importing
 * the SDK, so this stays zero-dep and runtime-agnostic. x402 `PaymentPayload`
 * carries the scheme-specific `payload: Record<string, unknown>` where the payer
 * lives (its exact key varies by scheme: exact-svm vs exact-evm).
 */
export type SettleGuardContext = {
    paymentPayload?: {
        payload?: Record<string, unknown> | null;
        payer?: unknown;
        [k: string]: unknown;
    } | null;
    requirements?: unknown;
    [k: string]: unknown;
};
/** The abort object the x402 onBeforeSettle/onBeforeVerify hook understands. */
export type SettleGuardAbort = {
    abort: true;
    reason: string;
    message?: string;
};
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
export type ScreenFn = (payer: string, ctx: SettleGuardContext) => Promise<PayerScreen | null> | PayerScreen | null;
export type GetPayerFn = (ctx: SettleGuardContext) => string | null | undefined | Promise<string | null | undefined>;
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
    abortOn?: {
        block?: boolean;
        warn?: boolean;
        washFlagged?: boolean;
    };
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
/**
 * Recover the token payer (owner of the source ATA) from an exact-SVM base64
 * transaction via optional peer `@x402/svm`. Returns null when the peer is
 * missing or the payload cannot be decoded.
 */
export declare function extractSvmPayerFromTransaction(transaction: string): Promise<string | null>;
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
export declare function defaultExtractPayer(ctx: SettleGuardContext): Promise<string | null>;
/**
 * Create an x402 `onBeforeSettle(hook)` that screens the incoming PAYER against
 * TWZRD and vetoes wash/blocked payers before settlement. Advisory + fail-open
 * by default (with a hard timeout around screening).
 *
 *   const server = new x402ResourceServer(facilitator);
 *   server.onBeforeSettle(createTwzrdSettleGuard({ screen: twzrdPayerScreen() }));
 */
export declare function createTwzrdSettleGuard(opts: SettleGuardOptions): (ctx: SettleGuardContext) => Promise<SettleGuardResult>;
/**
 * Reference payer screen: free `GET /v1/intel/merchant_card/{payer}`. Returns
 * the wash signal for the payer wallet (fail-open null on outage/absent). The
 * free merchant_card is keyed by any wallet that appears in the corpus as a
 * counterparty, so it resolves payer wallets too. For richer screening
 * (decision/score) inject a `screen` that calls the paid `/v1/intel/trust`
 * endpoint instead — kept out of the default to avoid a per-payment cost on the
 * hot path.
 */
export declare function twzrdPayerScreen(opts?: {
    intelBase?: string;
    fetch?: typeof fetch;
}): ScreenFn;
/**
 * Adapt a SettleGuardResult to the PayAI agentic-payments `onPaymentVerified`
 * return shape (`{ reject: true, reason }`). PayAI swallows thrown hook errors,
 * so a guard must RETURN the reject object, not throw — this helper does that.
 */
export declare function toPayaiVerifyResult(result: SettleGuardResult): {
    reject: true;
    reason: string;
} | undefined;
//# sourceMappingURL=seller-hook.d.ts.map