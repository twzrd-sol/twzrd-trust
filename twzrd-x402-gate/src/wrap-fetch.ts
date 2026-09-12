import type { ResolvedTwzrdGateConfig } from "./config.js";
import {
  paymentRequiredFromResponse,
  payToFromRequirements,
  pickRequirements,
  priceUsdcFromAmountMicro,
} from "./payto.js";
import { twzrdApprovePayment } from "./policy.js";
import type { X402PaymentRequiredBody, X402PaymentRequirements } from "./types.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap fetch: on HTTP 402, run TWZRD preflight on payTo before caller retries with payment.
 * Throws if policy denies; returns original 402 if approved (caller attaches payment).
 */
export function wrapFetchWithTwzrdGate(
  innerFetch: typeof fetch,
  config?: ResolvedTwzrdGateConfig,
): typeof fetch {
  return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const resp = await innerFetch(input, init);
    if (resp.status !== 402) return resp;

    // AUDIT FIX: header (v2) before body — the same precedence the payer uses.
    const body: X402PaymentRequiredBody | null = await paymentRequiredFromResponse(resp);
    if (body === null) {
      // No header and no JSON body — nothing an x402 payer can pay from either.
      return resp;
    }

    const first = pickRequirements(body.accepts as Array<Record<string, unknown>> | undefined);
    const { payTo, resource, amountMicro } = payToFromRequirements(first);
    const url = requestUrl(input);
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

    const { approved, reason } = await twzrdApprovePayment(
      {
        resourceUrl: resource ?? url,
        payTo,
        priceUsdc,
        agentIntent: "wrapFetch_402_gate",
        chain: first.network,
      },
      config,
    );

    if (!approved) {
      throw new Error(`[twzrd] payment blocked: ${reason} payTo=${payTo} url=${url}`);
    }
    return resp;
  };
}
