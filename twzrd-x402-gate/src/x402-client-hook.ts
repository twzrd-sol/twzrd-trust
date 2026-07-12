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

import { resolveConfig, type ResolvedTwzrdGateConfig } from "./config.js";
import { priceUsdcFromAmountMicro } from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import type { TwzrdGateConfig } from "./types.js";

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
  /** Some client versions may nest under requirements */
  requirements?: X402SelectedRequirements;
};

export type BeforePaymentCreationResult =
  | { abort: true; reason: string }
  | { abort?: false }
  | void;

/**
 * Minimal client surface — no hard dependency on @x402/core at compile time.
 * Compatible with x402Client from @x402/core/client.
 */
export type X402ClientLike = {
  onBeforePaymentCreation: (
    hook: (
      context: BeforePaymentCreationContext,
    ) => Promise<BeforePaymentCreationResult> | BeforePaymentCreationResult,
  ) => X402ClientLike | void;
};

export type InstallX402ClientHookOptions = TwzrdGateConfig & {
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
  }) => void;
};

function pickReq(ctx: BeforePaymentCreationContext): X402SelectedRequirements {
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
export function installTwzrdX402ClientHook(
  client: X402ClientLike,
  options?: InstallX402ClientHookOptions,
): X402ClientLike {
  const cfg: ResolvedTwzrdGateConfig = resolveConfig(options);

  client.onBeforePaymentCreation(async (context) => {
    const req = pickReq(context);
    const payTo = req.payTo ?? req.pay_to;
    const amountMicro = req.amount ?? req.maxAmountRequired;
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);
    const network = req.network;

    const approval = await twzrdApprovePayment(
      {
        resourceUrl: req.resource,
        payTo,
        priceUsdc,
        agentIntent: "x402_onBeforePaymentCreation",
        chain: network,
      },
      cfg,
    );

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
      });
    } catch {
      // never break payment path on telemetry
    }

    if (!approval.approved) {
      return {
        abort: true,
        reason: `[twzrd] ${approval.reason} payTo=${payTo ?? "unknown"} network=${network ?? "unknown"}`,
      };
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
export async function twzrdBeforePaymentCreation(
  selectedRequirements: X402SelectedRequirements,
  options?: InstallX402ClientHookOptions,
): Promise<BeforePaymentCreationResult> {
  const cfg = resolveConfig(options);
  const payTo = selectedRequirements.payTo ?? selectedRequirements.pay_to;
  const amountMicro =
    selectedRequirements.amount ?? selectedRequirements.maxAmountRequired;
  const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

  const approval = await twzrdApprovePayment(
    {
      resourceUrl: selectedRequirements.resource,
      payTo,
      priceUsdc,
      agentIntent: "x402_onBeforePaymentCreation",
      chain: selectedRequirements.network,
    },
    cfg,
  );

  if (!approval.approved) {
    return {
      abort: true,
      reason: `[twzrd] ${approval.reason} payTo=${payTo ?? "unknown"}`,
    };
  }
  return undefined;
}
