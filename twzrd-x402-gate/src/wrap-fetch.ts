import { wrapFetchEchoTwzrdAttempt } from "./attempt-echo.js";
import type { ResolvedTwzrdGateConfig } from "./config.js";
import { distinctOffers, firstRefusedOffer } from "./all-offers.js";
import { paymentRequiredFromResponse } from "./payto.js";
import type { X402PaymentRequiredBody } from "./types.js";

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
  const echoing = wrapFetchEchoTwzrdAttempt(innerFetch);
  return async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const resp = await echoing(input, init);
    if (resp.status !== 402) return resp;

    // AUDIT FIX: header (v2) before body — the same precedence the payer uses.
    const body: X402PaymentRequiredBody | null = await paymentRequiredFromResponse(resp);
    if (body === null) {
      // No header and no JSON body — nothing an x402 payer can pay from either.
      return resp;
    }

    // The payer picks which accepts[] entry it pays, so every distinct entry
    // must pass (0.11.2). The approval is free; no paid hops here.
    const url = requestUrl(input);
    const offers = distinctOffers(body.accepts);
    if (offers.length === 0) {
      // No offer at all: nothing identifiable to pay.
      throw new Error(`[twzrd] payment blocked: twzrd_unidentifiable_payment_recipient url=${url}`);
    }
    const refused = await firstRefusedOffer(offers, {
      config,
      resourceUrl: url,
      agentIntent: "wrapFetch_402_gate",
    });
    if (refused) {
      throw new Error(`[twzrd] payment blocked: ${refused.reason} payTo=${refused.payTo} url=${url}`);
    }
    return resp;
  };
}
