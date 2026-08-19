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
import { resolveConfig } from "./config.js";
import { priceUsdcFromAmountMicro } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import { quickCheck } from "./quick.js";
import { CLIENT_VERSION } from "./version.js";
import { x402RequirementsToIntent } from "./intent-adapters.js";
import { evaluateIntent } from "./policy-runtime.js";
import { createSeededDecisionSigner, } from "./decision-token.js";
import { counterpartyKnownFromApproval } from "./intelligence.js";
import { resolveRequireReceiptPolicy, shouldRequirePathAReceipt, } from "./receipt-policy.js";
function pickReq(ctx) {
    return ctx.selectedRequirements ?? ctx.requirements ?? {};
}
/**
 * Resolve Payment Control signer once at install / first evaluate.
 * EXACTLY one of signer/secret — never silently prefer one when both are set.
 */
export function resolvePaymentControlSigner(paymentControl) {
    if (!paymentControl)
        return undefined;
    const { signer, secret } = paymentControl;
    const hasSigner = signer != null;
    const hasSecret = typeof secret === "string" && secret.length > 0;
    if (hasSigner && hasSecret) {
        throw new Error("[twzrd] paymentControl: provide exactly one of `signer` or `secret` — both were given. " +
            "Silently choosing one would sign decisions with a key you did not intend.");
    }
    if (!hasSigner && !hasSecret) {
        throw new Error("[twzrd] paymentControl: provide exactly one of `signer` or `secret` — neither was given. " +
            "Decisions must be signed to be verifiable at the signer boundary.");
    }
    return hasSigner ? signer : createSeededDecisionSigner(secret);
}
/**
 * Shared evaluator used by both `installTwzrdX402ClientHook` and
 * `twzrdBeforePaymentCreation`. Same legacy preflight + optional Payment
 * Control + onDecision telemetry — one security semantic under both entry points.
 *
 * @param pcSigner Pre-resolved signer (install-time) or leave undefined to
 *   resolve from options.paymentControl on each call.
 */
export async function evaluateBeforePaymentCreation(selectedRequirements, options, pcSigner) {
    options = resolveBuyerPathADefaults(options ?? {});
    const cfg = resolveConfig(options);
    const payTo = selectedRequirements.payTo ?? selectedRequirements.pay_to;
    const amountMicro = selectedRequirements.amount ?? selectedRequirements.maxAmountRequired;
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
    const network = selectedRequirements.network;
    const approval = await twzrdApprovePayment({
        resourceUrl: selectedRequirements.resource,
        payTo,
        priceUsdc,
        agentIntent: "x402_onBeforePaymentCreation",
        chain: network,
    }, cfg);
    // Opt-in Payment Control: build the canonical intent and run the policy
    // runtime, feeding the preflight result in as remote intelligence. Skipped
    // when payTo/amount are missing — the legacy gate already denies those.
    let intent;
    let decision;
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
            signer: signer,
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
                decision: approval.verdict === "allow" ||
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
        const reason = pcBlocks && approval.approved
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
        }
        catch {
            // never break payment path on telemetry
        }
        return { abort: true, reason };
    }
    // Host threshold: Path A V6 before signing high-value or warn spends.
    const receiptPolicy = resolveRequireReceiptPolicy(options?.requireReceipt);
    const freeDecision = approval.verdict === "allow" ||
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
            const reason = "[twzrd] twzrd_receipt_required_missing_x402Fetch (wire x402Fetch for Path A)";
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
            }
            catch {
                /* telemetry */
            }
            if (receiptPolicy?.hard !== false) {
                return { abort: true, reason };
            }
        }
        else if (payTo && approval.reputationScored !== false) {
            try {
                // Seat identity (fork-1 caller_id metric — same pair twzrdPreflight always
                // stamps). This paid receipt fetch previously sent no identity headers at
                // all, so every Path A challenge event landed with caller_id=NULL.
                const clientTag = `twzrd-x402-gate/${CLIENT_VERSION}`;
                const headers = {
                    accept: "application/json",
                    "X-TWZRD-Client": clientTag,
                    "X-Twzrd-Caller": cfg.attribution ? `${cfg.attribution.integration}@${CLIENT_VERSION}` : clientTag,
                };
                if (typeof approval.preflightId === "number") {
                    headers["x-twzrd-preflight-id"] = String(approval.preflightId);
                }
                const resp = await options.x402Fetch(`${cfg.intelBase}/v1/intel/trust/${encodeURIComponent(payTo)}`, { method: "GET", headers });
                if (resp.ok) {
                    const body = (await resp.json());
                    const receipt = body.twzrd_receipt;
                    const preimage = receipt?.preimage;
                    const tx = body.tx ??
                        body.tx_pending ??
                        (typeof preimage?.settlement_tx === "string"
                            ? preimage.settlement_tx
                            : undefined);
                    receiptFeeCaptured = !!tx || body.charged === true;
                    try {
                        options.onReceipt?.(receipt, tx);
                    }
                    catch {
                        /* never break path */
                    }
                }
                else if (receiptPolicy?.hard !== false) {
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
                    }
                    catch {
                        /* telemetry */
                    }
                    return { abort: true, reason };
                }
            }
            catch (e) {
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
                    }
                    catch {
                        /* telemetry */
                    }
                    return { abort: true, reason };
                }
            }
        }
    }
    // Sub-material warn: $0.001 re-decide. Skip when Path A already ran.
    const esc = options.escalateOnWarn;
    if (!receiptRequired &&
        esc &&
        typeof options.x402Fetch === "function" &&
        payTo &&
        approval.verdict === "warn" &&
        approval.approved &&
        (priceUsdc ?? 0) >= (esc.minSpendUsdc ?? 0)) {
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
            }
            catch {
                /* telemetry */
            }
            return { abort: true, reason };
        }
    }
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
        });
    }
    catch {
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
export function installTwzrdX402ClientHook(client, options) {
    // Resolve Payment Control signer once at install (fail fast). Body is ONLY
    // the shared evaluator — never inline a second preflight/PC path here.
    const pcSigner = resolvePaymentControlSigner(options?.paymentControl);
    client.onBeforePaymentCreation((context) => evaluateBeforePaymentCreation(pickReq(context), options, pcSigner));
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
export async function twzrdBeforePaymentCreation(selectedRequirements, options) {
    return evaluateBeforePaymentCreation(selectedRequirements, options);
}
/** Flatten 3.0.0 resource object or 2.1.0 string to a URL. */
export function flattenDeclaredResource(declared) {
    if (typeof declared === "string")
        return declared;
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
export function mapX402SolanaRequirements(requirements, context) {
    const payTo = requirements.payTo ??
        requirements.pay_to;
    const amount = requirements.amount ??
        requirements.maxAmountRequired;
    const reqResource = requirements.resource;
    const resourceFromReq = typeof reqResource === "string"
        ? reqResource
        : flattenDeclaredResource(reqResource);
    const resource = resourceFromReq ??
        flattenDeclaredResource(context?.declaredResource) ??
        context?.requestUrl;
    return {
        payTo,
        pay_to: payTo,
        network: requirements.network,
        amount,
        maxAmountRequired: amount,
        asset: requirements.asset,
        resource,
        scheme: requirements.scheme,
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
export function createTwzrdBeforePaymentHook(options) {
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
        const selected = mapX402SolanaRequirements(requirements, context);
        return evaluateBeforePaymentCreation(selected, options, pcSigner);
    };
}
//# sourceMappingURL=x402-client-hook.js.map