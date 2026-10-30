/**
 * Binds the outcome ledger (outcome-ledger.ts) to the x402 payment path used
 * by createGuardedX402Fetch.
 *
 * Where each transition happens on a real 402 round trip:
 *
 *   fetch:     the buyer's call                bind {url, method, bodyHash} to this call (AsyncLocalStorage)
 *   transport: unpaid request  ──▶ 402        pass through
 *   client:    onBeforePaymentCreation         begin() the attempt; local + TWZRD checks run;
 *                                              abort  -> refuse()
 *                                              pass   -> markSigning()   <- BEFORE the scheme signs
 *   client:    scheme.createPaymentPayload     the signer (not ours)
 *   transport: paid retry (PAYMENT header)     throw -> markUnknown()
 *                                              PAYMENT-RESPONSE success+tx -> complete()
 *                                              PAYMENT-RESPONSE success:false -> markNotSettled()
 *                                              no PAYMENT-RESPONSE -> markUnknown()
 *
 * The attempt key is the intent hash of what the gate can see: the selected
 * requirement (payTo, network, asset, amount) and the request (URL, method,
 * body hash). A second call for the same intent while the first is unresolved
 * (approved, signing, or unknown) aborts in the hook with `unresolved_attempt`
 * and never reaches the signer; that includes an identical concurrent call.
 *
 * Local only. Settlement facts come from the facilitator's PAYMENT-RESPONSE
 * header AS THE SELLER RELAYED IT; this module does not verify them on chain.
 * Only `success: true` with a transaction is treated as settled. A relayed
 * `success: false` is NOT treated as "not settled": a seller that settles and
 * then relays a failure would otherwise get the buyer to pay again under the
 * ledger's own blessing. It lands as `unknown`, and `markNotSettled` is left
 * to the operator's reconcile step against the chain.
 *
 * The request being paid for is taken from the BUYER's own call: `bindCall`
 * (applied by createGuardedX402Fetch around the whole paying fetch) computes
 * {url, method, bodyHash} from the caller's input and carries it in an
 * AsyncLocalStorage store through the unpaid leg, the pre-sign hook and the
 * paid retry. The hook never derives the request from the seller-declared
 * `paymentRequired.resource.url` (seller-controlled) or from a count of calls
 * in flight. Calls run concurrently, whatever their URL; nothing is serialized.
 *
 * If the hook runs with no bound call (client.createPaymentPayload() called
 * directly, outside the returned fetch) it aborts with `unbound_request`
 * rather than bind an unknown method or an empty body hash. With a ledger
 * configured, use the returned fetch.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { newDecisionId } from "./decision-token.js";
import { intentHash, type PaymentIntent } from "./intent.js";
import {
  OutcomeLedgerBlockedError,
  OutcomeLedgerExpiredError,
  type ApprovalBinding,
  type OutcomeLedger,
  type ValidationFact,
} from "./outcome-ledger.js";
import { resolveRequirementFields } from "./payto.js";
import type { BeforePaymentCreationContext, BeforePaymentCreationResult } from "./x402-client-hook.js";

/** Default validation rule: PAYMENT-RESPONSE success with a transaction, and a 2xx response. */
export const X402_PAID_RESPONSE_RULE_V1 = "twzrd.x402-paid-response.v1";
/** Approval lifetime when the requirement carries no maxTimeoutSeconds. */
export const DEFAULT_APPROVAL_TTL_MS = 60_000;
/** maxTimeoutSeconds is merchant-controlled; clamp it before it becomes an expiry. */
export const MIN_APPROVAL_TTL_MS = 5_000;
export const MAX_APPROVAL_TTL_MS = 10 * 60_000;

export type OutcomeValidator = (ctx: {
  /** A clone; the caller's body is untouched. */
  response: Response;
  intentHash: string;
  approval: ApprovalBinding;
}) => ValidationFact | Promise<ValidationFact>;

export type OutcomeLedgerX402Options = {
  ledger: OutcomeLedger;
  /**
   * Buyer-side validation of the paid response. Its `ruleVersion` must equal
   * `ruleVersion` here or the attempt lands as paid_incomplete. Default: the
   * built-in rule named by X402_PAID_RESPONSE_RULE_V1.
   */
  validate?: OutcomeValidator;
  ruleVersion?: string;
  /** Schema identifier recorded in the approval, for the reader. */
  schemaId?: string;
  now?: () => number;
};

/** `url` is the full canonical URL (hash input); the stored binding splits it. */
export type BoundRequest = { method: string; bodyHash: string; url: string };

/** Reason the pre-sign hook aborts when no buyer call is bound to it. */
export const UNBOUND_REQUEST_REASON = "unbound_request";

type Dict = Record<string, unknown>;
const asRecord = (v: unknown): Dict | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const sha256hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function decodeB64Json(header: string | null): Dict | null {
  if (!header) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  } catch {
    return null;
  }
}

function paymentHeaderOf(headers: Headers): string | null {
  return headers.get("PAYMENT-SIGNATURE") || headers.get("X-PAYMENT") || null;
}

/** Drop the fragment; keep the query (it is part of what was bought). */
export function canonicalRequestUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/** What the ledger file stores for a URL: origin + path, and a hash of the query. */
export function splitRequestUrl(url: string): { url: string; queryHash: string } {
  try {
    const u = new URL(url);
    const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
    return { url: u.origin + u.pathname, queryHash: query ? sha256hex(query) : "" };
  } catch {
    return { url: "unknown", queryHash: sha256hex(url) };
  }
}

function rawUrlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function bodyHashOf(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (typeof body === "string") return sha256hex(body);
  if (body instanceof Uint8Array) return sha256hex(body);
  if (body instanceof ArrayBuffer) return sha256hex(new Uint8Array(body));
  if (body instanceof URLSearchParams) return sha256hex(body.toString());
  if (body == null && input instanceof Request && !input.bodyUsed) {
    try {
      const buf = new Uint8Array(await input.clone().arrayBuffer());
      return buf.byteLength ? sha256hex(buf) : "";
    } catch {
      return "";
    }
  }
  return body == null ? "" : "unhashable";
}

export type RequirementTerms = { payTo: string; network: string; asset: string; amountAtomic: string; maxTimeoutSeconds: number | null };

export function termsOf(req: unknown): RequirementTerms | null {
  const r = asRecord(req);
  if (!r) return null;
  const fields = resolveRequirementFields(r);
  if (fields.conflict) return null;
  const payTo = str(fields.payTo);
  const amount = str(fields.amount);
  if (!payTo || !amount || !/^(0|[1-9][0-9]*)$/.test(amount)) return null;
  const timeout = typeof r.maxTimeoutSeconds === "number" && Number.isFinite(r.maxTimeoutSeconds) ? r.maxTimeoutSeconds : null;
  return { payTo, network: str(r.network) ?? "unknown", asset: str(r.asset) ?? "unknown", amountAtomic: amount, maxTimeoutSeconds: timeout };
}

/** The key: what the gate saw, hashed with the same canonical form as every other PaymentIntent. */
export function x402AttemptIntentHash(terms: RequirementTerms, request: BoundRequest): string {
  const intent: PaymentIntent = {
    protocol: "x402",
    network: terms.network,
    asset: terms.asset,
    // Base units on purpose: this key must not depend on a USD price table.
    amount: terms.amountAtomic,
    payTo: terms.payTo,
    resource: { url: request.url, method: request.method, requestHash: request.bodyHash || undefined },
  };
  return intentHash(intent);
}

export function defaultX402Validation(response: Response): ValidationFact {
  const ok = response.status >= 200 && response.status < 300;
  return { ok, ruleVersion: X402_PAID_RESPONSE_RULE_V1, reasonCodes: ok ? [] : [`http_${response.status}`] };
}

export type OutcomeLedgerX402Binding = {
  /**
   * Call first in the pre-sign hook. `abort` means do not run the signer.
   * Aborts with `unbound_request` when the hook runs outside `bindCall`.
   */
  open(context: BeforePaymentCreationContext): { intentHash: string } | { abort: string } | null;
  /** Call with the hook's own result. Returns an abort when the approval expired meanwhile. */
  close(intentHash: string, result: BeforePaymentCreationResult): BeforePaymentCreationResult;
  /** Wrap the raw transport the paying fetch uses. */
  wrapTransport(inner: typeof fetch): typeof fetch;
  /**
   * Run one whole round trip with the buyer's own request bound to it. The
   * hook and the paid leg read the binding; the seller's declared URL is never
   * consulted. Calls run concurrently.
   */
  bindCall<T>(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, fn: () => Promise<T>): Promise<T>;
};

export function createOutcomeLedgerX402Binding(options: OutcomeLedgerX402Options): OutcomeLedgerX402Binding {
  const { ledger } = options;
  const now = options.now ?? Date.now;
  const ruleVersion = options.ruleVersion ?? X402_PAID_RESPONSE_RULE_V1;
  const validate: OutcomeValidator = options.validate ?? (({ response }) => defaultX402Validation(response));
  /** The buyer's request for the call in progress; set by bindCall, read by the hook and the paid leg. */
  const calls = new AsyncLocalStorage<BoundRequest>();

  return {
    open(context) {
      const selected = asRecord(context.selectedRequirements ?? context.requirements) ?? {};
      const terms = termsOf(selected);
      if (!terms) return null; // the hook's own checks will refuse a malformed requirement; nothing to sign
      const request = calls.getStore();
      // No bound call: the signer would run for a request this ledger cannot name. Refuse.
      if (!request) return { abort: `${UNBOUND_REQUEST_REASON}:call_the_returned_fetch_not_createPaymentPayload` };
      const h = x402AttemptIntentHash(terms, request);
      const t = now();
      const askedMs = terms.maxTimeoutSeconds != null ? terms.maxTimeoutSeconds * 1000 : DEFAULT_APPROVAL_TTL_MS;
      const ttl = Math.min(MAX_APPROVAL_TTL_MS, Math.max(MIN_APPROVAL_TTL_MS, Number.isFinite(askedMs) ? askedMs : DEFAULT_APPROVAL_TTL_MS));
      const stored = splitRequestUrl(request.url);
      const approval: ApprovalBinding = {
        payTo: terms.payTo,
        network: terms.network,
        asset: terms.asset,
        amountAtomic: terms.amountAtomic,
        // x402 exact: no buyer-side fees; gas is the facilitator's.
        maxAllInAtomic: terms.amountAtomic,
        request: { method: request.method, url: stored.url, bodyHash: request.bodyHash, queryHash: stored.queryHash },
        expiresAt: new Date(t + ttl).toISOString(),
        validation: { schemaId: options.schemaId, ruleVersion },
      };
      try {
        ledger.begin({ intentHash: h, decisionId: newDecisionId(), approval, now: t });
      } catch (err) {
        if (err instanceof OutcomeLedgerBlockedError) {
          const prior = err.record ? ` (${err.record.state} since ${new Date(err.record.updatedAt).toISOString()})` : "";
          return { abort: `${err.reason}:${h}${prior}` };
        }
        throw err;
      }
      return { intentHash: h };
    },
    close(h, result) {
      if (result && result.abort) {
        ledger.refuse(h, { reasonCodes: [result.reason], now: now() });
        return result;
      }
      try {
        ledger.markSigning(h, now());
      } catch (err) {
        if (err instanceof OutcomeLedgerExpiredError) return { abort: true, reason: `[twzrd-guarded-fetch] approval_expired:${h}` };
        throw err;
      }
      return result;
    },
    async bindCall(input, init, fn) {
      const url = canonicalRequestUrl(rawUrlOf(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const bound: BoundRequest = { url, method, bodyHash: await bodyHashOf(input, init) };
      return calls.run(bound, fn);
    },
    wrapTransport(inner) {
      return async (input, init) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const payment = decodeB64Json(paymentHeaderOf(headers));

        // Unpaid leg: nothing to record; the call is already bound.
        if (!payment) return inner(input, init);

        // Paid leg: find the attempt the signer just ran for. With no bound
        // call the hook refused, so there is nothing to resolve.
        const request = calls.getStore();
        if (!request) return inner(input, init);
        const terms = termsOf(payment.accepted);
        const h = terms ? x402AttemptIntentHash(terms, request) : null;
        const rec = h ? ledger.get(h) : null;
        const live = rec && rec.state === "signing" ? rec : null;

        let resp: Response;
        try {
          resp = await inner(input, init);
        } catch (err) {
          if (live && h) ledger.markUnknown(h, { cause: String((err as Error)?.name ?? err) + ": " + String((err as Error)?.message ?? ""), now: now() });
          throw err;
        }
        if (!live || !h || !terms) return resp;

        const settle = decodeB64Json(resp.headers.get("PAYMENT-RESPONSE") || resp.headers.get("X-PAYMENT-RESPONSE"));
        const tx = str(settle?.transaction) ?? str(settle?.txHash) ?? null;
        if (!settle) {
          ledger.markUnknown(h, { cause: `no_payment_response_header:http_${resp.status}`, now: now() });
          return resp;
        }
        if (settle.success !== true || !tx) {
          // Relayed by the seller: a failure claim is not evidence of no settlement.
          const reason = str(settle.errorReason) ?? str(settle.error) ?? null;
          const cause = settle.success === false
            ? `settle_failed${reason ? ":" + reason : ""}`
            : !tx ? "payment_response_without_transaction" : "payment_response_without_success";
          ledger.markUnknown(h, { cause, now: now() });
          return resp;
        }
        let validation: ValidationFact;
        try {
          validation = await validate({ response: resp.clone(), intentHash: h, approval: live.approval });
        } catch (err) {
          validation = { ok: false, ruleVersion, reasonCodes: ["validator_threw", String((err as Error)?.message ?? err)] };
        }
        ledger.complete(h, {
          settlement: { settlementTx: tx, amountAtomic: terms.amountAtomic, feesAtomic: "0" },
          validation,
          now: now(),
        });
        return resp;
      };
    },
  };
}
