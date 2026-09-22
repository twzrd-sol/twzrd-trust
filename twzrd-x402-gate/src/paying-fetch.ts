import { wrapFetchEchoTwzrdAttempt, wrapX402ClientEchoAttempt } from "./attempt-echo.js";
import { resolveConfig } from "./config.js";
import { captureDeliveryObservation } from "./delivery-capture.js";
import { paymentRequiredFromResponse, pickRequirements, payToFromRequirements } from "./payto.js";
import { wrapFetchRememberInvoice } from "./resource-bind.js";
import {
  evaluateWashOnlyBeforePayment,
  mapWashRequirements,
  type WashDefaultOptions,
  type WashSelectedRequirements,
} from "./wash-default.js";

/** Wash abort; never treated as a dead origin. */
export class TwzrdWashAbortError extends Error {
  override name = "TwzrdWashAbortError";
}

const STRIP = /^(authorization|cookie|payment-signature|payment-response)$/i;

export type CreateTwzrdPayingFetchInput = WashDefaultOptions & {
  wallet?: unknown;
  rawFetch?: typeof fetch;
  wrapPay?: (guarded: typeof fetch) => typeof fetch;
  peekFetch?: typeof fetch;
  topUrl?: string;
  routeUrl?: string;
  /** Default true. Kill switch: false or TWZRD_DELIVERY_CAPTURE=0. */
  deliveryCapture?: boolean;
};

function fwd(h?: NonNullable<Parameters<typeof fetch>[1]>["headers"], extra?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => { if (!STRIP.test(k)) out[k] = v; });
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (/^x-outbid-/i.test(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

async function maybeCapturePaid(
  resp: Response,
  opts: CreateTwzrdPayingFetchInput,
  requestUrl: string,
  challenge: unknown,
  startedAt: number,
): Promise<void> {
  if (resp.status !== 200 || challenge == null) return;
  const req = pickRequirements(
    (challenge as { accepts?: Array<Record<string, unknown>> }).accepts,
  );
  const { payTo, resource } = payToFromRequirements(req);
  if (!payTo) return;
  let resourceBody: unknown;
  try {
    const ct = resp.headers.get("content-type") ?? "";
    resourceBody = ct.includes("json") ? await resp.clone().json() : await resp.clone().text();
  } catch {
    resourceBody = null;
  }
  const cfg = resolveConfig({
    intelBase: opts.intelBase,
    fetch: opts.fetch,
    attribution: opts.attribution,
  });
  await captureDeliveryObservation(
    {
      merchantWallet: payTo,
      httpStatus: resp.status,
      resourceBody,
      challengeBody: challenge,
      payerOutput: resourceBody,
      latencyMs: Date.now() - startedAt,
      resource: resource ?? requestUrl,
      network: typeof req.network === "string" ? req.network : undefined,
      enabled: opts.deliveryCapture,
    },
    cfg,
  );
}

export function createTwzrdPayingFetch(opts: CreateTwzrdPayingFetchInput): typeof fetch {
  const inner = opts.rawFetch ?? globalThis.fetch.bind(globalThis);
  const raw = wrapFetchRememberInvoice(wrapFetchEchoTwzrdAttempt(inner));
  const peek = opts.peekFetch ?? inner;
  let lastChallenge: unknown;
  const guarded: typeof fetch = async (input, init) => {
    const resp = await raw(input, init);
    if (resp.status !== 402) return resp;
    let challenge: unknown;
    try {
      challenge = await paymentRequiredFromResponse(resp);
    } catch { return resp; }
    if (challenge == null) return resp;
    lastChallenge = challenge;
    const accepts = (challenge as { accepts?: Array<Record<string, unknown>> }).accepts;
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const decision = await evaluateWashOnlyBeforePayment(
      mapWashRequirements(
        pickRequirements(accepts) as WashSelectedRequirements & Record<string, unknown>,
        { requestUrl },
      ),
      opts,
    );
    if (decision && decision.abort === true) throw new TwzrdWashAbortError(decision.reason);
    return resp;
  };
  let pay = opts.wrapPay?.(guarded);
  return async (input, init) => {
    if (!pay) {
      if (opts.wallet == null) throw new Error("[twzrd-x402-gate] createTwzrdPayingFetch needs wallet or wrapPay");
      pay = (await import("@x402/fetch")).wrapFetchWithPayment(
        guarded,
        wrapX402ClientEchoAttempt(opts.wallet) as never,
      );
    }
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const startedAt = Date.now();
    const after = async (resp: Response) => {
      try {
        await maybeCapturePaid(resp, opts, requestUrl, lastChallenge, startedAt);
      } catch { /* never throw into the pay path */ }
      return resp;
    };
    try { return await after(await pay(input, init)); }
    catch (err) {
      const abort = init?.signal?.aborted === true || (err as { name?: string } | null)?.name === "AbortError";
      if (err instanceof TwzrdWashAbortError || (err as { name?: string } | null)?.name === "TwzrdPolicyAbortError" || abort) throw err;
      try { await peek(opts.topUrl ?? "https://outbid.sh/top"); } catch { /* peek is free */ }
      const body = (await (await pay(opts.routeUrl ?? "https://outbid.sh/route", {
        headers: { accept: "application/json" },
      })).json()) as { url?: unknown; forward_headers?: Record<string, unknown> };
      if (typeof body.url !== "string") throw new Error("[twzrd-x402-gate] outbid /route missing url");
      return after(await pay(body.url, { ...init, headers: fwd(init?.headers, body.forward_headers) }));
    }
  };
}
