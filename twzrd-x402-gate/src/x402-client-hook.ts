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

import { resolveBuyerPathADefaults } from "./buyer-defaults.js";
import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import { priceUsdcFromAmountMicro } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import { quickCheck } from "./quick.js";
import { CLIENT_VERSION } from "./version.js";
import type { TwzrdGateConfig } from "./types.js";
import { x402RequirementsToIntent } from "./intent-adapters.js";
import { evaluateIntent, type Mandate, type SpendLedger, type SpendPolicy } from "./policy-runtime.js";
import {
  createSeededDecisionSigner,
  type DecisionSigner,
  type PaymentDecision,
} from "./decision-token.js";
import { counterpartyKnownFromApproval } from "./intelligence.js";
import type { PaymentIntent } from "./intent.js";
import {
  resolveRequireReceiptPolicy,
  shouldRequirePathAReceipt,
  type RequireReceiptPolicy,
} from "./receipt-policy.js";
import {
  stampResourceBind,
  type ResourceBindDecision,
} from "./resource-bind.js";

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
  extra?: Record<string, unknown>;
};

/**
 * Context passed to onBeforePaymentCreation (official x402Client).
 * Field names follow TypeScript docs: context.selectedRequirements.
 */
export type BeforePaymentCreationContext = {
  selectedRequirements: X402SelectedRequirements;
  /** Full 402 body (v2: resource.url lives here, not on accepts[]). */
  paymentRequired?: unknown;
  /** Some client versions may nest under requirements */
  requirements?: X402SelectedRequirements;
};

export type BeforePaymentCreationResult = void | { abort: true; reason: string };

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
  onBeforePaymentCreation: (
    hook: (
      context: BeforePaymentCreationContext,
    ) => Promise<BeforePaymentCreationResult>,
  ) => unknown;
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
export type X402PaymentControlOptions = X402PaymentControlCommon &
  (
    | {
        /** Ed25519 decision signer (createLocalDecisionSigner() or a remote signer). */
        signer: DecisionSigner;
        secret?: never;
      }
    | {
        /**
         * High-entropy key material (32+ bytes, hex or base64 — `openssl rand -hex 32`)
         * deterministically derived into an Ed25519 signer. Verifiers receive the
         * signer's `publicKeyPem`, never this secret.
         */
        secret: string;
        signer?: never;
      }
  );

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
    resourceBind?: ResourceBindDecision;
  }) => void;
};

/** v2 402: resource URL is on the envelope, not on the selected accepts[] entry. */
export function resourceUrlFromPaymentRequired(paymentRequired: unknown): string | undefined {
  if (!paymentRequired || typeof paymentRequired !== "object") return undefined;
  const r = (paymentRequired as { resource?: unknown }).resource;
  if (typeof r === "string" && r.length > 0) return r;
  return flattenDeclaredResource(r as X402DeclaredResource | undefined);
}

function pickReq(ctx: BeforePaymentCreationContext): X402SelectedRequirements {
  const req = ctx.selectedRequirements ?? ctx.requirements ?? {};
  if (!req.resource) {
    const url = resourceUrlFromPaymentRequired(ctx.paymentRequired);
    if (url) req.resource = url;
  }
  return req;
}

/**
 * Resolve Payment Control signer once at install / first evaluate.
 * EXACTLY one of signer/secret — never silently prefer one when both are set.
 */
export function resolvePaymentControlSigner(
  paymentControl: X402PaymentControlOptions | undefined,
): DecisionSigner | undefined {
  if (!paymentControl) return undefined;
  const { signer, secret } = paymentControl as {
    signer?: DecisionSigner;
    secret?: string;
  };
  const hasSigner = signer != null;
  const hasSecret = typeof secret === "string" && secret.length > 0;
  if (hasSigner && hasSecret) {
    throw new Error(
      "[twzrd] paymentControl: provide exactly one of `signer` or `secret` — both were given. " +
        "Silently choosing one would sign decisions with a key you did not intend.",
    );
  }
  if (!hasSigner && !hasSecret) {
    throw new Error(
      "[twzrd] paymentControl: provide exactly one of `signer` or `secret` — neither was given. " +
        "Decisions must be signed to be verifiable at the signer boundary.",
    );
  }
  return hasSigner ? signer : createSeededDecisionSigner(secret as string);
}

/**
 * Shared evaluator used by both `installTwzrdX402ClientHook` and
 * `twzrdBeforePaymentCreation`. Same legacy preflight + optional Payment
 * Control + onDecision telemetry — one security semantic under both entry points.
 *
 * @param pcSigner Pre-resolved signer (install-time) or leave undefined to
 *   resolve from options.paymentControl on each call.
 */
export async function evaluateBeforePaymentCreation(
  selectedRequirements: X402SelectedRequirements,
  options?: InstallX402ClientHookOptions,
  pcSigner?: DecisionSigner,
  paymentRequired?: unknown,
): Promise<BeforePaymentCreationResult> {
  options = resolveBuyerPathADefaults(options ?? {});
  const cfg: ResolvedTwzrdGateConfig = resolveConfig(options);
  const payTo = selectedRequirements.payTo ?? selectedRequirements.pay_to;
  const amountMicro =
    selectedRequirements.amount ?? selectedRequirements.maxAmountRequired;
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
  const network = selectedRequirements.network;

  const approval = await twzrdApprovePayment(
    {
      resourceUrl: selectedRequirements.resource,
      payTo,
      priceUsdc,
      agentIntent: "x402_onBeforePaymentCreation",
      chain: network,
    },
    cfg,
  );

  // Opt-in Payment Control: build the canonical intent and run the policy
  // runtime, feeding the preflight result in as remote intelligence. Skipped
  // when payTo/amount are missing — the legacy gate already denies those.
  let intent: PaymentIntent | undefined;
  let decision: PaymentDecision | undefined;
  if (options?.paymentControl && payTo && amountMicro) {
    const signer = pcSigner ?? resolvePaymentControlSigner(options.paymentControl);
    const pc = options.paymentControl;
    // x402RequirementsToIntent converts the wire micro-amount to decimal USD.
    intent = x402RequirementsToIntent(selectedRequirements, {
      resourceUrl: selectedRequirements.resource,
      method: pc.method,
      facilitator: pc.facilitator,
      purpose: pc.purpose,
    });
    decision = await evaluateIntent(intent, {
      signer: signer!,
      policy: pc.policy,
      mandate: pc.mandate,
      ledger: pc.ledger,
      ttlMs: pc.ttlMs,
      now: options.now?.(),
      // Ledger hygiene: never record spend for a payment the legacy gate
      // already denied — the hook aborts it regardless of this decision,
      // so recording would pollute cumulative/monthly caps.
      recordSpend: approval.approved,
      intelligence: () => ({
        // NOT reputationScored — that flag is true for any scored Solana path,
        // including a wallet we have never observed, which would mark every
        // recipient known:true and disable unknownCounterparty entirely.
        // Same shared mapping as the standalone intelligence provider.
        known: counterpartyKnownFromApproval(approval),
        washFlagged: approval.washFlagged ?? undefined,
        decision:
          approval.verdict === "allow" ||
          approval.verdict === "warn" ||
          approval.verdict === "block"
            ? approval.verdict
            : undefined,
        trustScore: approval.score ?? undefined,
      }),
    });
  }

  // Payment Control can only TIGHTEN: abort if the legacy gate denied OR the
  // signed decision blocks. Never loosen a legacy denial.
  const pcBlocks = decision?.decision === "block";
  if (!approval.approved || pcBlocks) {
    const reason =
      pcBlocks && approval.approved
        ? `[twzrd] payment_control_block:${decision?.reasonCodes.join(",")} payTo=${payTo ?? "unknown"}`
        : `[twzrd] ${approval.reason} payTo=${payTo ?? "unknown"} network=${network ?? "unknown"}`;
    try {
      options?.onDecision?.({
        approved: false,
        reason,
        verdict: String(approval.verdict),
        payTo,
        network: approval.network ?? network,
        amountMicro,
        reputationScored: approval.reputationScored,
        policyAction: approval.policyAction,
        intent,
        decision,
        budget_remaining_usdc: decision?.budgetRemainingUsdc ?? null,
      });
    } catch {
      // never break payment path on telemetry
    }
    return { abort: true, reason };
  }

  // Host threshold: Path A V6 before signing high-value or warn spends.
  const receiptPolicy = resolveRequireReceiptPolicy(options?.requireReceipt);
  const freeDecision =
    approval.verdict === "allow" ||
    approval.verdict === "warn" ||
    approval.verdict === "block"
      ? approval.verdict
      : String(approval.verdict);
  const receiptRequired = shouldRequirePathAReceipt({
    policy: receiptPolicy,
    decision: freeDecision,
    priceUsdc,
  });

  let receiptFeeCaptured = false;
  if (receiptRequired) {
    if (typeof options?.x402Fetch !== "function") {
      const reason =
        "[twzrd] twzrd_receipt_required_missing_x402Fetch (wire x402Fetch for Path A)";
      try {
        options?.onDecision?.({
          approved: false,
          reason,
          verdict: String(approval.verdict),
          payTo,
          network: approval.network ?? network,
          amountMicro,
          reputationScored: approval.reputationScored,
          policyAction: "block",
          intent,
          decision,
          receiptRequired: true,
        });
      } catch {
        /* telemetry */
      }
      if (receiptPolicy?.hard !== false) {
        return { abort: true, reason };
      }
    } else if (payTo && approval.reputationScored !== false) {
      try {
        // Seat identity (fork-1 caller_id metric — same pair twzrdPreflight always
        // stamps). This paid receipt fetch previously sent no identity headers at
        // all, so every Path A challenge event landed with caller_id=NULL.
        const clientTag = `twzrd-x402-gate/${CLIENT_VERSION}`;
        const headers: Record<string, string> = {
          accept: "application/json",
          "X-TWZRD-Client": clientTag,
          "X-Twzrd-Caller": cfg.attribution ? `${cfg.attribution.integration}@${CLIENT_VERSION}` : clientTag,
        };
        if (typeof approval.preflightId === "number") {
          headers["x-twzrd-preflight-id"] = String(approval.preflightId);
        }
        const resp = await options.x402Fetch(
          `${cfg.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`,
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
          receiptFeeCaptured = !!tx || body.charged === true;
          try {
            options.onReceipt?.(receipt, tx);
          } catch {
            /* never break path */
          }
        } else if (receiptPolicy?.hard !== false) {
          const reason = `[twzrd] twzrd_receipt_required_failed (HTTP ${resp.status}) payTo=${payTo}`;
          try {
            options?.onDecision?.({
              approved: false,
              reason,
              verdict: String(approval.verdict),
              payTo,
              network: approval.network ?? network,
              amountMicro,
              reputationScored: approval.reputationScored,
              policyAction: "block",
              intent,
              decision,
              receiptRequired: true,
            });
          } catch {
            /* telemetry */
          }
          return { abort: true, reason };
        }
      } catch (e) {
        if (receiptPolicy?.hard !== false) {
          const msg = e instanceof Error ? e.message : String(e);
          const reason = `[twzrd] twzrd_receipt_required_error (${msg}) payTo=${payTo}`;
          try {
            options?.onDecision?.({
              approved: false,
              reason,
              verdict: String(approval.verdict),
              payTo,
              network: approval.network ?? network,
              amountMicro,
              reputationScored: approval.reputationScored,
              policyAction: "block",
              intent,
              decision,
              receiptRequired: true,
            });
          } catch {
            /* telemetry */
          }
          return { abort: true, reason };
        }
      }
    }
  }

  // Sub-material warn: $0.001 re-decide. Skip when Path A already ran.
  const esc = options.escalateOnWarn;
  if (
    !receiptRequired &&
    esc &&
    typeof options.x402Fetch === "function" &&
    payTo &&
    approval.verdict === "warn" &&
    approval.approved &&
    (priceUsdc ?? 0) >= (esc.minSpendUsdc ?? 0)
  ) {
    const floor = esc.blockBelowScore ?? cfg.preflightMinScore;
    const quick = await quickCheck(payTo, {
      intelBase: cfg.intelBase,
      fetch: cfg.fetch,
      x402Fetch: options.x402Fetch,
    });
    if (quick.available && quick.score !== null && quick.score < floor) {
      const reason = `[twzrd] twzrd_escalated_warn_block (paid quick score ${quick.score} < ${floor})`;
      try {
        options?.onDecision?.({
          approved: false,
          reason,
          verdict: String(approval.verdict),
          payTo,
          network: approval.network ?? network,
          amountMicro,
          reputationScored: approval.reputationScored,
          policyAction: "block",
          intent,
          decision,
        });
      } catch {
        /* telemetry */
      }
      return { abort: true, reason };
    }
  }

  const resourceBind = stampResourceBind(selectedRequirements, paymentRequired);
  try {
    options?.onDecision?.({
      approved: true,
      reason: approval.reason,
      verdict: String(approval.verdict),
      payTo,
      network: approval.network ?? network,
      amountMicro,
      reputationScored: approval.reputationScored,
      policyAction: approval.policyAction,
      intent,
      decision,
      receiptRequired: receiptRequired || undefined,
      receiptFeeCaptured: receiptFeeCaptured || undefined,
      resourceBind,
    });
  } catch {
    // never break payment path on telemetry
  }

  // void / undefined → proceed to payment payload creation (same selectedRequirements)
  return undefined;
}

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
export function installTwzrdX402ClientHook(
  client: X402ClientLike,
  options?: InstallX402ClientHookOptions,
): X402ClientLike {
  // Resolve Payment Control signer once at install (fail fast). Body is ONLY
  // the shared evaluator — never inline a second preflight/PC path here.
  const pcSigner = resolvePaymentControlSigner(options?.paymentControl);

  client.onBeforePaymentCreation((context) =>
    evaluateBeforePaymentCreation(pickReq(context), options, pcSigner, context.paymentRequired),
  );

  return client;
}

/**
 * Standalone handler for runtimes that expose an equivalent hook API
 * (Python on_before_payment_creation, Go OnBeforePaymentCreation).
 *
 * Full parity with `installTwzrdX402ClientHook`: same shared evaluator
 * (legacy preflight + optional Payment Control + onDecision). Prefer the
 * install helper when you have an x402Client instance; use this when the host
 * only provides the selected requirements object.
 */
export async function twzrdBeforePaymentCreation(
  selectedRequirements: X402SelectedRequirements,
  options?: InstallX402ClientHookOptions,
): Promise<BeforePaymentCreationResult> {
  return evaluateBeforePaymentCreation(selectedRequirements, options);
}

/**
 * Context shape from PayAI `x402-solana` `beforePayment` (config seat on
 * `createX402Client`). 2.1.0 passed `declaredResource` as a string; 3.0.0
 * passes the v2 resource object `{ url, description?, mimeType? }`. We flatten
 * `.url` so the same hook copy-paste runs on both. No hard dependency.
 */
export type X402DeclaredResource = string | { url?: string };

export type X402SolanaBeforePaymentContext = {
  requestUrl?: string;
  responseUrl?: string;
  declaredResource?: X402DeclaredResource;
  protocolVersion?: 1 | 2;
  signal?: AbortSignal;
};

/** Flatten 3.0.0 resource object or 2.1.0 string to a URL. */
export function flattenDeclaredResource(
  declared?: X402DeclaredResource,
): string | undefined {
  if (typeof declared === "string") return declared;
  if (declared && typeof declared.url === "string" && declared.url.length > 0) {
    return declared.url;
  }
  return undefined;
}

/**
 * Map PayAI stock-client requirements (+ optional context) into the shared
 * evaluator input. Prefer requirement fields; fall back to challenge-declared
 * resource then the caller's request URL.
 */
export function mapX402SolanaRequirements(
  requirements: X402SelectedRequirements & Record<string, unknown>,
  context?: X402SolanaBeforePaymentContext,
): X402SelectedRequirements {
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
      : flattenDeclaredResource(reqResource as X402DeclaredResource | undefined);
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
export function createTwzrdBeforePaymentHook(
  options?: InstallX402ClientHookOptions,
): (
  requirements: X402SelectedRequirements & Record<string, unknown>,
  context?: X402SolanaBeforePaymentContext,
) => Promise<BeforePaymentCreationResult> {
  // Resolve Payment Control signer once (fail fast) — same as install path.
  const pcSigner = resolvePaymentControlSigner(options?.paymentControl);

  return async (requirements, context) => {
    // Honor AbortSignal if the stock client forwarded one (cancel → no sign).
    if (context?.signal?.aborted) {
      return {
        abort: true,
        reason: "[twzrd] aborted_before_payment: signal already aborted",
      };
    }
    const mapped = mapX402SolanaRequirements(requirements, context);
    if (mapped.resource) requirements.resource = mapped.resource;
    return evaluateBeforePaymentCreation(requirements, options, pcSigner);
  };
}
