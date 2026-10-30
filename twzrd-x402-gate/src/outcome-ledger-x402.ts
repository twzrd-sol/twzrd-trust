/**
 * Binds the outcome ledger (outcome-ledger.ts) to the x402 payment path used
 * by createGuardedX402Fetch.
 *
 * Where each transition happens on a real 402 round trip:
 *
 *   transport: unpaid request  ──▶ 402        remember {method, bodyHash} for the URL
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
 * aborts in the hook with `unresolved_attempt` and never reaches the signer.
 *
 * Local only. Settlement facts come from the facilitator's PAYMENT-RESPONSE
 * header as the seller relayed it; this module does not verify them on chain.
 * A caller that reconciles against the chain resolves `unknown` records
 * through the ledger directly.
 */
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

type PendingRequest = { method: string; bodyHash: string; url: string };

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
export function x402AttemptIntentHash(terms: RequirementTerms, request: PendingRequest): string {
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
  /** Call first in the pre-sign hook. `abort` means do not run the signer. */
  open(context: BeforePaymentCreationContext): { intentHash: string } | { abort: string } | null;
  /** Call with the hook's own result. Returns an abort when the approval expired meanwhile. */
  close(intentHash: string, result: BeforePaymentCreationResult): BeforePaymentCreationResult;
  /** Wrap the raw transport the paying fetch uses. */
  wrapTransport(inner: typeof fetch): typeof fetch;
};

export function createOutcomeLedgerX402Binding(options: OutcomeLedgerX402Options): OutcomeLedgerX402Binding {
  const { ledger } = options;
  const now = options.now ?? Date.now;
  const ruleVersion = options.ruleVersion ?? X402_PAID_RESPONSE_RULE_V1;
  const validate: OutcomeValidator = options.validate ?? (({ response }) => defaultX402Validation(response));
  /** Unpaid requests we have seen, by canonical URL, so the hook can bind method and body. */
  const pending = new Map<string, PendingRequest>();

  function requestFor(context: BeforePaymentCreationContext, selected: Dict): PendingRequest {
    const pr = asRecord(context.paymentRequired);
    const resourceUrl = str(asRecord(pr?.resource)?.url) ?? str(selected.resource) ?? null;
    const byUrl = resourceUrl ? pending.get(canonicalRequestUrl(resourceUrl)) : undefined;
    if (byUrl) return byUrl;
    if (pending.size === 1) return [...pending.values()][0]!;
    return { url: resourceUrl ? canonicalRequestUrl(resourceUrl) : "unknown", method: "UNKNOWN", bodyHash: "" };
  }

  return {
    open(context) {
      const selected = asRecord(context.selectedRequirements ?? context.requirements) ?? {};
      const terms = termsOf(selected);
      if (!terms) return null; // the hook's own checks will refuse a malformed requirement; nothing to sign
      const request = requestFor(context, selected);
      const h = x402AttemptIntentHash(terms, request);
      const t = now();
      const ttl = terms.maxTimeoutSeconds != null ? terms.maxTimeoutSeconds * 1000 : DEFAULT_APPROVAL_TTL_MS;
      const approval: ApprovalBinding = {
        payTo: terms.payTo,
        network: terms.network,
        asset: terms.asset,
        amountAtomic: terms.amountAtomic,
        // x402 exact: no buyer-side fees; gas is the facilitator's.
        maxAllInAtomic: terms.amountAtomic,
        request: { method: request.method, url: request.url, bodyHash: request.bodyHash },
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
    wrapTransport(inner) {
      return async (input, init) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = canonicalRequestUrl(rawUrl);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const payment = decodeB64Json(paymentHeaderOf(headers));

        if (!payment) {
          // Unpaid leg: remember what is being bought so the hook can bind it.
          pending.set(url, { url, method, bodyHash: await bodyHashOf(input, init) });
          return inner(input, init);
        }

        // Paid leg: find the attempt the signer just ran for.
        const terms = termsOf(payment.accepted);
        const request = pending.get(url) ?? { url, method, bodyHash: await bodyHashOf(input, init) };
        const h = terms ? x402AttemptIntentHash(terms, request) : null;
        const rec = h ? ledger.get(h) : null;
        const live = rec && rec.state === "signing" ? rec : null;
        pending.delete(url);

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
        if (settle.success === false || !tx) {
          // The facilitator says it did not settle (or names no transaction we could check).
          if (settle.success === false) ledger.markNotSettled(h, { reasonCodes: ["settle_failed", ...(str(settle.errorReason) ? [String(settle.errorReason)] : [])], now: now() });
          else ledger.markUnknown(h, { cause: "payment_response_without_transaction", now: now() });
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
