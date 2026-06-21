import type { ResolvedTwzrdGateConfig } from "./config.js";
import { payToFromRequirements } from "./payto.js";
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

    let body: X402PaymentRequiredBody = {};
    try {
      body = (await resp.clone().json()) as X402PaymentRequiredBody;
    } catch {
      // 402 without a parseable x402 body — nothing to gate on; pass through
      return resp;
    }

    const first = (body.accepts?.[0] ?? {}) as X402PaymentRequirements;
    const { payTo, resource } = payToFromRequirements(first);
    const url = requestUrl(input);

    const { approved, reason } = await twzrdApprovePayment(
      {
        resourceUrl: resource ?? url,
        payTo,
        agentIntent: "wrapFetch_402_gate",
      },
      config,
    );

    if (!approved) {
      throw new Error(`[twzrd] payment blocked: ${reason} payTo=${payTo} url=${url}`);
    }
    return resp;
  };
}
