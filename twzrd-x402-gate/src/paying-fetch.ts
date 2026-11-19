import { AsyncLocalStorage } from "node:async_hooks";

import { distinctOffers, MAX_DISTINCT_OFFERS, TOO_MANY_PAYMENT_OPTIONS } from "./all-offers.js";
import { wrapFetchEchoTwzrdAttempt, wrapX402ClientEchoAttempt } from "./attempt-echo.js";
import { twzrdSentinelRefusal } from "./binding-plane.js";
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

/** Load the optional @x402/fetch peer with an install hint instead of a bare ERR_MODULE_NOT_FOUND (0.11.2). */
function x402FetchPeer(entry: string): Promise<typeof import("@x402/fetch")> {
  return import("@x402/fetch").catch((cause: unknown) => {
    throw new Error(
      `[twzrd-x402-gate] ${entry} needs @x402/fetch, an optional peer dependency. Install it: npm i @x402/fetch @x402/core`,
      { cause },
    );
  });
}

/** Wash abort, and the `.kill` / `.pause` halt; never treated as a dead origin. */
/**
 * The 402 carries a PAYMENT-REQUIRED header this package cannot read (not
 * canonical base64, or not a JSON object). A payer may still read it: the
 * x402 client decodes with `atob`, which takes text a strict reader refuses.
 * A challenge that was not checked is never handed to the payer.
 */
export const PAYMENT_REQUIRED_UNREADABLE = "twzrd_payment_required_unreadable";

export class TwzrdWashAbortError extends Error {
  override name = "TwzrdWashAbortError";
}

/**
 * Headers never carried to a fallback hop, whether they came from the caller's
 * request or from the route's `forward_headers`: credentials, payment proofs
 * and the hop's own routing headers (0.27.0 widened this from four names).
 */
const STRIP = /^(authorization|cookie|proxy-.*|x-payment|payment|payment-signature|payment-response|host)$/i;

/**
 * Fallback routing is configured but invalid. Thrown by
 * `createTwzrdPayingFetch` (and so `createTwzrdPolicyFetch`) at construction.
 */
const FALLBACK_CONFIG = "[twzrd-x402-gate] fallback routing";

/**
 * A fallback hop answered with a redirect (0.27.0). Fallback requests are sent with
 * `redirect: "manual"`; a redirect is refused before anything is handed to
 * the payer, so an allowlisted host cannot point the payment elsewhere.
 */
export const FALLBACK_REDIRECT_REFUSED = "twzrd_fallback_redirect_refused";

export type CreateTwzrdPayingFetchInput = WashDefaultOptions & {
  wallet?: unknown;
  rawFetch?: typeof fetch;
  wrapPay?: (guarded: typeof fetch) => typeof fetch;
  peekFetch?: typeof fetch;
  /**
   * Opt in to fallback routing (default false, 0.27.0). When a payment fails
   * for a reason other than a wash, policy, halt or abort refusal, the client
   * peeks `topUrl`, pays `routeUrl`, and pays the `url` that route answers
   * with. Off: the original error is rethrown and no fallback request is made.
   * On: `allowedFallbackHosts` and an https `routeUrl` on one of them are
   * required, or construction throws a TypeError.
   */
  fallbackEnabled?: boolean;
  /**
   * Hostnames the fallback may contact: `topUrl`, `routeUrl` and the `url` the
   * route answers with. Exact, case-insensitive match; no wildcards, no ports.
   */
  allowedFallbackHosts?: readonly string[];
  /** Free peek before the route is paid. Optional; https and allowlisted. No default (0.27.0). */
  topUrl?: string;
  /** Paid route that names the fallback `url`. Required when `fallbackEnabled`. No default (0.27.0). */
  routeUrl?: string;
  /** Default true. Kill switch: false or TWZRD_DELIVERY_CAPTURE=0. */
  deliveryCapture?: boolean;
};

function fwd(h?: NonNullable<Parameters<typeof fetch>[1]>["headers"], extra?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => { if (!STRIP.test(k)) out[k] = v; });
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (/^x-outbid-/i.test(k) && !STRIP.test(k) && typeof v === "string") out[k] = v;
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

type FallbackConfig = { hosts: ReadonlySet<string>; topUrl?: string; routeUrl: string };

/** Parse an https URL with no userinfo whose hostname is allowlisted, or say why not. */
function fallbackUrlRefusal(value: unknown, hosts: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "is not a non-empty string";
  let u: URL;
  try { u = new URL(value); } catch { return "does not parse as a URL"; }
  if (u.protocol !== "https:") return `is not https: (${u.protocol})`;
  if (u.username !== "" || u.password !== "") return "carries userinfo";
  if (!hosts.has(u.hostname.toLowerCase())) return `host ${u.hostname} is not in allowedFallbackHosts`;
  return undefined;
}

/** Validate the fallback options at construction. Undefined when fallback is off. */
function fallbackConfig(opts: CreateTwzrdPayingFetchInput): FallbackConfig | undefined {
  if (opts.fallbackEnabled !== true) return undefined;
  const list = opts.allowedFallbackHosts;
  if (!Array.isArray(list) || list.length === 0 || !list.every((h) => typeof h === "string" && h.trim().length > 0)) {
    throw new TypeError(`${FALLBACK_CONFIG}: fallbackEnabled needs allowedFallbackHosts, a non-empty array of non-empty hostnames`);
  }
  const hosts = new Set(list.map((h) => h.trim().toLowerCase()));
  if (opts.routeUrl === undefined) throw new TypeError(`${FALLBACK_CONFIG}: fallbackEnabled needs routeUrl`);
  const routeBad = fallbackUrlRefusal(opts.routeUrl, hosts);
  if (routeBad) throw new TypeError(`${FALLBACK_CONFIG}: routeUrl ${routeBad}`);
  if (opts.topUrl !== undefined) {
    const topBad = fallbackUrlRefusal(opts.topUrl, hosts);
    if (topBad) throw new TypeError(`${FALLBACK_CONFIG}: topUrl ${topBad}`);
  }
  return { hosts, topUrl: opts.topUrl, routeUrl: opts.routeUrl };
}

export function createTwzrdPayingFetch(opts: CreateTwzrdPayingFetchInput): typeof fetch {
  const fallback = fallbackConfig(opts);
  const inner = opts.rawFetch ?? globalThis.fetch.bind(globalThis);
  const raw = wrapFetchRememberInvoice(wrapFetchEchoTwzrdAttempt(inner));
  const peek = opts.peekFetch ?? inner;
  let lastChallenge: unknown;
  // Returning a 402 from `guarded` is the go-ahead: the payer wrapped around
  // it signs next. So every such return passes through here, and nothing is
  // awaited between this read and the return. Thrown as a wash abort so the
  // caller below does not treat the halt as a dead origin and pay the
  // fallback route instead.
  const handOver = (resp: Response): Response => {
    const halted = twzrdSentinelRefusal(opts);
    if (halted !== undefined) throw new TwzrdWashAbortError(`[twzrd] ${halted}`);
    return resp;
  };
  // Set while a fallback hop runs, so `guarded` sees the hop's requests,
  // including the payer's signed retry, and refuses any redirect.
  const fallbackHop = new AsyncLocalStorage<ReadonlySet<string>>();
  const refuseRedirect = (resp: Response): Response => {
    const status = resp.status;
    if (resp.type === "opaqueredirect" || resp.redirected || (status >= 300 && status < 400)) {
      throw new TwzrdWashAbortError(FALLBACK_REDIRECT_REFUSED);
    }
    // `redirected` also catches a rawFetch that ignored `redirect: "manual"`.
    // resp.url is not checked: a rawFetch may legitimately rewrite the host
    // (proxy, loopback test double), and the request URL was already allowlisted.
    return resp;
  };
  const guarded: typeof fetch = async (input, init) => {
    const hopHosts = fallbackHop.getStore();
    const resp = hopHosts
      ? refuseRedirect(await raw(input, { ...init, redirect: "manual" }))
      : await raw(input, init);
    if (resp.status !== 402) return resp;
    handOver(resp); // on entry: no card lookups for a payment that cannot happen
    let challenge: unknown;
    try {
      challenge = await paymentRequiredFromResponse(resp);
    } catch { throw new TwzrdWashAbortError(PAYMENT_REQUIRED_UNREADABLE); }
    // No header and no JSON body: the x402 payer cannot pay it, and handing it
    // over made the payer throw a plain error that sent this fetch to its
    // fallback route. Refused like an unreadable header (0.26.0).
    if (challenge == null) throw new TwzrdWashAbortError(PAYMENT_REQUIRED_UNREADABLE);
    lastChallenge = challenge;
    const accepts = (challenge as { accepts?: Array<Record<string, unknown>> }).accepts;
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // The payer may take any entry (@x402/core: the first its schemes can pay), so every
    // distinct entry must pass the wash check, and one with no recipient is refused (0.11.3).
    const offers = distinctOffers(accepts);
    if (offers.length === 0) throw new TwzrdWashAbortError("twzrd_unidentifiable_payment_recipient");
    if (offers.length > MAX_DISTINCT_OFFERS) throw new TwzrdWashAbortError(TOO_MANY_PAYMENT_OPTIONS);
    for (const offer of offers) {
      if (!payToFromRequirements(offer).payTo) throw new TwzrdWashAbortError("twzrd_unidentifiable_payment_recipient");
      const decision = await evaluateWashOnlyBeforePayment(
        mapWashRequirements(offer as WashSelectedRequirements & Record<string, unknown>, { requestUrl }),
        opts,
      );
      if (decision && decision.abort === true) throw new TwzrdWashAbortError(decision.reason);
    }
    return handOver(resp);
  };
  let pay = opts.wrapPay?.(guarded);
  return async (input, init) => {
    if (!pay) {
      if (opts.wallet == null) throw new Error("[twzrd-x402-gate] createTwzrdPayingFetch needs wallet or wrapPay");
      pay = (await x402FetchPeer("createTwzrdPayingFetch")).wrapFetchWithPayment(
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
      // Fallback is opt-in (0.27.0): off, the original error is the answer and nothing else is fetched.
      if (!fallback) throw err;
      const hop = <T>(fn: () => Promise<T>): Promise<T> => fallbackHop.run(fallback.hosts, fn);
      const payHop = pay;
      if (fallback.topUrl !== undefined) {
        const topUrl = fallback.topUrl;
        try { await peek(topUrl, { redirect: "manual" }); } catch { /* peek is free */ }
      }
      const body = (await (await hop(() => payHop(fallback.routeUrl, {
        headers: { accept: "application/json" },
      }))).json()) as { url?: unknown; forward_headers?: Record<string, unknown> };
      if (typeof body.url !== "string") throw new Error("[twzrd-x402-gate] fallback route answer has no url");
      // The route names where the next payment goes: only an allowlisted https host is paid.
      const refused = fallbackUrlRefusal(body.url, fallback.hosts);
      if (refused) throw new Error(`[twzrd-x402-gate] fallback route url refused: ${refused}`);
      const hopUrl = body.url;
      return after(await hop(() => payHop(hopUrl, { ...init, headers: fwd(init?.headers, body.forward_headers) })));
    }
  };
}
