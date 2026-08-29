import { resolveBuyerPathADefaults } from "./buyer-defaults.js";
import { resolveConfig } from "./config.js";
import { evaluate_x402_resource, type EvaluateX402Options } from "./evaluate.js";
import { payToFromRequirements, pickRequirements } from "./payto.js";
import type {
  TwzrdGateConfig,
  X402PaymentRequiredBody,
  X402PaymentRequirements,
} from "./types.js";

export type TwzrdGuardOptions = TwzrdGateConfig &
  Pick<
    EvaluateX402Options,
    "autoReceipt" | "x402Fetch" | "onReceipt" | "escalateOnWarn" | "requireReceipt"
  >;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wraps a fetch implementation with TWZRD gate logic.
 *
 * On every 402 response, the guard:
 *   1. Runs free TWZRD preflight on the seller (via evaluate_x402_resource).
 *   2. If decision=block: throws before the caller can sign a payment.
 *   3. If decision=warn + autoReceipt=true: auto-fetches the paid TWZRD
 *      trust receipt via x402Fetch (TWZRD earns the receipt fee on-chain),
 *      then returns the original 402 for the caller to pay the resource.
 *   4. If decision=allow: returns the original 402 for the caller to pay.
 *
 * Non-402 responses pass through unchanged.
 *
 * Usage:
 *   const safeFetch = withTwzrdGuard(fetch, { autoReceipt: true, x402Fetch: walletFetch });
 *   const resp = await safeFetch("https://example.com/paid-resource"); // 402 handled
 *   // caller attaches payment and retries (or uses an x402 wrapper around safeFetch)
 */
export function withTwzrdGuard(
  innerFetch: typeof fetch,
  opts?: TwzrdGuardOptions,
): typeof fetch {
  const paid = resolveBuyerPathADefaults({
    x402Fetch: opts?.x402Fetch,
    requireReceipt: opts?.requireReceipt,
    escalateOnWarn: opts?.escalateOnWarn,
  });
  // Resolve once at construction time so config errors surface early.
  const config = resolveConfig({
    intelBase: opts?.intelBase,
    preflightMinScore: opts?.preflightMinScore,
    blockDecisions: opts?.blockDecisions,
    failOpen: opts?.failOpen,
    gateOnCanSpend: opts?.gateOnCanSpend,
    refuseWashFlagged: opts?.refuseWashFlagged,
    washMaxUsdc: opts?.washMaxUsdc,
    unsupportedNetworkMode: opts?.unsupportedNetworkMode,
    fetch: opts?.fetch ?? innerFetch,
    attribution: opts?.attribution,
  });

  return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const resp = await innerFetch(input, init);
    if (resp.status !== 402) return resp;

    let body: X402PaymentRequiredBody = {};
    try {
      body = (await resp.clone().json()) as X402PaymentRequiredBody;
    } catch {
      // 402 without a parseable x402 body — nothing to gate on.
      return resp;
    }

    const first = pickRequirements(body.accepts as Array<Record<string, unknown>> | undefined);
    const url = requestUrl(input);

    const result = await evaluate_x402_resource(url, first, {
      intelBase: config.intelBase,
      preflightMinScore: config.preflightMinScore,
      blockDecisions: config.blockDecisions,
      failOpen: config.failOpen,
      gateOnCanSpend: config.gateOnCanSpend,
      refuseWashFlagged: config.refuseWashFlagged,
      washMaxUsdc: config.washMaxUsdc ?? undefined,
      unsupportedNetworkMode: config.unsupportedNetworkMode,
      fetch: config.fetch,
      attribution: config.attribution,
      autoReceipt: opts?.autoReceipt,
      x402Fetch: paid.x402Fetch,
      onReceipt: opts?.onReceipt,
      escalateOnWarn: paid.escalateOnWarn === false ? undefined : paid.escalateOnWarn,
      requireReceipt: paid.requireReceipt,
    });

    if (!result.approved) {
      const { payTo } = payToFromRequirements(first);
      throw new Error(
        `[twzrd-guard] payment blocked: ${result.reason} payTo=${payTo ?? "unknown"} url=${url}`,
      );
    }

    return resp;
  };
}
