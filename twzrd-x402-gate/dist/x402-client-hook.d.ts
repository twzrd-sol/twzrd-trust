/**
 * Canonical Path E integration: official x402 client lifecycle hook.
 *
 * Registers on `x402Client.onBeforePaymentCreation` so TWZRD evaluates the
 * **exact** selected payment requirement after the client chooses it and
 * **before** payment payload construction / wallet signing.
 *
 * This eliminates TOCTOU from probe-then-shell-out wrappers (twzrd-safe-fetch).
 *
 * @see https://docs.x402.org/advanced-concepts/lifecycle-hooks
 */
import type { TwzrdGateConfig } from "./types.js";
import { type Mandate, type SpendLedger, type SpendPolicy } from "./policy-runtime.js";
import { type DecisionSigner, type PaymentDecision } from "./decision-token.js";
import type { PaymentIntent } from "./intent.js";
import { type RequireReceiptPolicy } from "./receipt-policy.js";
/** Minimal shape of x402 payment requirements used by the hook. */
export type X402SelectedRequirements = {
    payTo?: string;
    pay_to?: string;
    network?: string;
    amount?: string;
    maxAmountRequired?: string;
    asset?: string;
    resource?: string;
    scheme?: string;
};
/**
 * Context passed to onBeforePaymentCreation (official x402Client).
 * Field names follow TypeScript docs: context.selectedRequirements.
 */
export type BeforePaymentCreationContext = {
    selectedRequirements: X402SelectedRequirements;
    /** Full 402 response body; present on the official client, unused by the gate. */
    paymentRequired?: unknown;
    /** Some client versions may nest under requirements */
    requirements?: X402SelectedRequirements;
};
export type BeforePaymentCreationResult = void | {
    abort: true;
    reason: string;
};
/**
 * Minimal client surface — no hard dependency on @x402/core at compile time.
 *
 * Must stay assignable FROM the official x402Client under strictFunctionTypes:
 * the hook type we claim the client accepts must satisfy the client's own
 * BeforePaymentCreationHook — async-only, returning nothing or
 * `{ abort: true, reason }`. A sync return branch or an `{ abort: false }`
 * variant here makes `new x402Client()` fail to typecheck against this
 * surface. Proven by test/x402-official-compat.test.ts against @x402/fetch.
 */
export type X402ClientLike = {
    onBeforePaymentCreation: (hook: (context: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>) => unknown;
};
/**
 * Opt-in TWZRD Payment Control on the client hook. When set, the hook builds a
 * canonical PaymentIntent from the selected requirement and runs the policy
 * runtime — local mandate + company policy as deterministic hard controls, with
 * the hook's own preflight fed in as remote intelligence — producing a signed,
 * expiring PaymentDecision bound to the exact intent (surfaced on
 * onDecision.decision). A downstream cooperating signer re-checks it with
 * assertIntentApproved and refuses if the intent changed after approval.
 *
 * The decision can only TIGHTEN the legacy gate: a policy/mandate block aborts
 * even when preflight allowed; it never loosens a legacy denial. Leaving
 * paymentControl unset preserves the exact prior behavior.
 */
type X402PaymentControlCommon = {
    policy?: SpendPolicy;
    mandate?: Mandate;
    ledger?: SpendLedger;
    /** Token time-to-live in ms (default 120s). */
    ttlMs?: number;
    /** Spend purpose bound into the intent (matched against mandate.purposes). */
    purpose?: string;
    facilitator?: string;
    /** Resource method bound into the intent (GET/POST/…). */
    method?: string;
};
/**
 * Exactly one signing source. Modeled as a union so the type system rejects
 * both-at-once, and checked again at runtime for JS callers: silently
 * preferring one over the other would let an operator believe decisions are
 * signed by a key that is not in fact signing them.
 */
export type X402PaymentControlOptions = X402PaymentControlCommon & ({
    /** Ed25519 decision signer (createLocalDecisionSigner() or a remote signer). */
    signer: DecisionSigner;
    secret?: never;
} | {
    /**
     * High-entropy key material (32+ bytes, hex or base64 — `openssl rand -hex 32`)
     * deterministically derived into an Ed25519 signer. Verifiers receive the
     * signer's `publicKeyPem`, never this secret.
     */
    secret: string;
    signer?: never;
});
export type InstallX402ClientHookOptions = TwzrdGateConfig & {
    /** Opt-in Payment Control: signed intent-bound decisions + local policy/mandate. */
    paymentControl?: X402PaymentControlOptions;
    /** Clock for decision issue time, Unix ms. Injectable for tests. Default Date.now. */
    now?: () => number;
    /**
     * Host threshold policy for Path A V6 (same semantics as evaluate_x402_resource).
     * Requires `x402Fetch` when hard require is active.
     */
    requireReceipt?: boolean | RequireReceiptPolicy;
    /**
     * x402-capable fetch used to buy Path A when requireReceipt triggers.
     * Not used for free refuse-only installs. When present and flags are
     * unset, buyer Path A defaults turn on (warn+material → $0.05;
     * sub-material warn → $0.001). Facilitator settle hooks stay free.
     */
    x402Fetch?: typeof fetch;
    /**
     * Autonomous $0.001 re-decide on a proceeding warn. Default on when
     * `x402Fetch` is wired and this flag is unset. Set false to opt out.
     */
    escalateOnWarn?: false | {
        minSpendUsdc?: number;
        blockBelowScore?: number;
    };
    /**
     * Called after a successful Path A purchase from the beforePayment seat.
     */
    onReceipt?: (receipt: unknown, tx: string | undefined) => void;
    /**
     * Optional callback after each policy decision (telemetry / logging).
     * Never throws into the payment path.
     */
    onDecision?: (detail: {
        approved: boolean;
        reason: string;
        verdict: string;
        payTo?: string;
        network?: string;
        amountMicro?: string;
        reputationScored?: boolean;
        policyAction?: string;
        /** Canonical evaluated intent (present when paymentControl is set). */
        intent?: PaymentIntent;
        /** Signed, intent-bound decision (present when paymentControl is set). */
        decision?: PaymentDecision;
        /**
         * Refuse-transcript field: decimal USDC still available under the budget
         * that blocked (POLICY_MAX_AMOUNT / monthly ceiling). Null/absent when
         * the refuse was not budget-related.
         */
        budget_remaining_usdc?: string | null;
        /** true when Path A was required by threshold/warn policy */
        receiptRequired?: boolean;
        receiptFeeCaptured?: boolean;
    }) => void;
};
/**
 * Resolve Payment Control signer once at install / first evaluate.
 * EXACTLY one of signer/secret — never silently prefer one when both are set.
 */
export declare function resolvePaymentControlSigner(paymentControl: X402PaymentControlOptions | undefined): DecisionSigner | undefined;
/**
 * Shared evaluator used by both `installTwzrdX402ClientHook` and
 * `twzrdBeforePaymentCreation`. Same legacy preflight + optional Payment
 * Control + onDecision telemetry — one security semantic under both entry points.
 *
 * @param pcSigner Pre-resolved signer (install-time) or leave undefined to
 *   resolve from options.paymentControl on each call.
 */
export declare function evaluateBeforePaymentCreation(selectedRequirements: X402SelectedRequirements, options?: InstallX402ClientHookOptions, pcSigner?: DecisionSigner): Promise<BeforePaymentCreationResult>;
/**
 * Install TWZRD as the default onBeforePaymentCreation policy engine.
 *
 * @example
 * ```ts
 * import { x402Client } from "@x402/core/client";
 * import { wrapFetchWithPayment } from "@x402/fetch";
 * import { ExactSvmScheme } from "@x402/svm/exact/client";
 * import { installTwzrdX402ClientHook } from "twzrd-x402-gate";
 *
 * const client = new x402Client();
 * client.register("solana:*", new ExactSvmScheme(svmSigner));
 * installTwzrdX402ClientHook(client, { gateOnCanSpend: true });
 *
 * const fetchWithPayment = wrapFetchWithPayment(fetch, client);
 * await fetchWithPayment("https://merchant.example/paid");
 * ```
 */
export declare function installTwzrdX402ClientHook(client: X402ClientLike, options?: InstallX402ClientHookOptions): X402ClientLike;
/**
 * Standalone handler for runtimes that expose an equivalent hook API
 * (Python on_before_payment_creation, Go OnBeforePaymentCreation).
 *
 * Full parity with `installTwzrdX402ClientHook`: same shared evaluator
 * (legacy preflight + optional Payment Control + onDecision). Prefer the
 * install helper when you have an x402Client instance; use this when the host
 * only provides the selected requirements object.
 */
export declare function twzrdBeforePaymentCreation(selectedRequirements: X402SelectedRequirements, options?: InstallX402ClientHookOptions): Promise<BeforePaymentCreationResult>;
/**
 * Context shape from PayAI `x402-solana` `beforePayment` (config seat on
 * `createX402Client`). 2.1.0 passed `declaredResource` as a string; 3.0.0
 * passes the v2 resource object `{ url, description?, mimeType? }`. We flatten
 * `.url` so the same hook copy-paste runs on both. No hard dependency.
 */
export type X402DeclaredResource = string | {
    url?: string;
};
export type X402SolanaBeforePaymentContext = {
    requestUrl?: string;
    responseUrl?: string;
    declaredResource?: X402DeclaredResource;
    protocolVersion?: 1 | 2;
    signal?: AbortSignal;
};
/** Flatten 3.0.0 resource object or 2.1.0 string to a URL. */
export declare function flattenDeclaredResource(declared?: X402DeclaredResource): string | undefined;
/**
 * Map PayAI stock-client requirements (+ optional context) into the shared
 * evaluator input. Prefer requirement fields; fall back to challenge-declared
 * resource then the caller's request URL.
 */
export declare function mapX402SolanaRequirements(requirements: X402SelectedRequirements & Record<string, unknown>, context?: X402SolanaBeforePaymentContext): X402SelectedRequirements;
/**
 * Stock PayAI client seat: `createX402Client({ beforePayment })`.
 *
 * Returns a hook with the x402-solana@2.1.0 / @3.0.0 `beforePayment`
 * signature: `(requirements, context) => Promise<{ abort: true, reason } | void>`.
 * Runs AFTER requirement selection and BEFORE `signTransaction`.
 * 3.0.0 `declaredResource` objects are flattened to `.url`.
 *
 * Same security semantic as `installTwzrdX402ClientHook` /
 * `evaluateBeforePaymentCreation` — shared evaluator, refuse/wash/can_spend.
 *
 * @example
 * ```ts
 * import { createX402Client } from "x402-solana/client";
 * import { createTwzrdBeforePaymentHook } from "twzrd-x402-gate";
 *
 * const client = createX402Client({
 *   wallet,
 *   network: "solana",
 *   beforePayment: createTwzrdBeforePaymentHook({ refuseWashFlagged: true }),
 * });
 * ```
 *
 * Alias via AutoGate: `installTwzrdAutoGate("x402-solana", opts)`.
 */
export declare function createTwzrdBeforePaymentHook(options?: InstallX402ClientHookOptions): (requirements: X402SelectedRequirements & Record<string, unknown>, context?: X402SolanaBeforePaymentContext) => Promise<BeforePaymentCreationResult>;
export {};
//# sourceMappingURL=x402-client-hook.d.ts.map