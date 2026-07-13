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
import { resolveConfig } from "./config.js";
import { priceUsdcFromAmountMicro } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import { x402RequirementsToIntent } from "./intent-adapters.js";
import { evaluateIntent } from "./policy-runtime.js";
import { createSeededDecisionSigner, } from "./decision-token.js";
import { counterpartyKnownFromApproval } from "./intelligence.js";
function pickReq(ctx) {
    return ctx.selectedRequirements ?? ctx.requirements ?? {};
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
    const cfg = resolveConfig(options);
    // Resolve the Payment Control signer once at install time (fail fast).
    // EXACTLY one of signer/secret — never silently prefer one when both are set.
    let pcSigner;
    if (options?.paymentControl) {
        const { signer, secret } = options.paymentControl;
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
        pcSigner = hasSigner ? signer : createSeededDecisionSigner(secret);
    }
    client.onBeforePaymentCreation(async (context) => {
        const req = pickReq(context);
        const payTo = req.payTo ?? req.pay_to;
        const amountMicro = req.amount ?? req.maxAmountRequired;
        const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
        const network = req.network;
        const approval = await twzrdApprovePayment({
            resourceUrl: req.resource,
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
            const pc = options.paymentControl;
            // x402RequirementsToIntent converts the wire micro-amount to decimal USD.
            intent = x402RequirementsToIntent(req, {
                resourceUrl: req.resource,
                method: pc.method,
                facilitator: pc.facilitator,
                purpose: pc.purpose,
            });
            decision = await evaluateIntent(intent, {
                signer: pcSigner,
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
        try {
            options?.onDecision?.({
                approved: approval.approved,
                reason: approval.reason,
                verdict: String(approval.verdict),
                payTo,
                network: approval.network ?? network,
                amountMicro,
                reputationScored: approval.reputationScored,
                policyAction: approval.policyAction,
                intent,
                decision,
            });
        }
        catch {
            // never break payment path on telemetry
        }
        // Payment Control can only TIGHTEN: abort if the legacy gate denied OR the
        // signed decision blocks. Never loosen a legacy denial.
        const pcBlocks = decision?.decision === "block";
        if (!approval.approved || pcBlocks) {
            const reason = pcBlocks && approval.approved
                ? `[twzrd] payment_control_block:${decision?.reasonCodes.join(",")} payTo=${payTo ?? "unknown"}`
                : `[twzrd] ${approval.reason} payTo=${payTo ?? "unknown"} network=${network ?? "unknown"}`;
            return { abort: true, reason };
        }
        // void / undefined → proceed to payment payload creation (same selectedRequirements)
    });
    return client;
}
/**
 * Standalone handler for runtimes that expose an equivalent hook API
 * (Python on_before_payment_creation, Go OnBeforePaymentCreation).
 * Returns abort result without requiring a client instance.
 */
export async function twzrdBeforePaymentCreation(selectedRequirements, options) {
    const cfg = resolveConfig(options);
    const payTo = selectedRequirements.payTo ?? selectedRequirements.pay_to;
    const amountMicro = selectedRequirements.amount ?? selectedRequirements.maxAmountRequired;
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
    const approval = await twzrdApprovePayment({
        resourceUrl: selectedRequirements.resource,
        payTo,
        priceUsdc,
        agentIntent: "x402_onBeforePaymentCreation",
        chain: selectedRequirements.network,
    }, cfg);
    if (!approval.approved) {
        return {
            abort: true,
            reason: `[twzrd] ${approval.reason} payTo=${payTo ?? "unknown"}`,
        };
    }
    return undefined;
}
//# sourceMappingURL=x402-client-hook.js.map