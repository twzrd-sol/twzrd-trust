/**
 * Delivery receipts as the outcome ledger's validation rule.
 *
 * `receiptValidationRule()` returns `{ validate, ruleVersion }`, to spread into
 * the `outcomeLedger` options of `createGuardedX402Fetch` (or
 * `createOutcomeLedgerX402Binding`). It runs only after the settlement check has
 * confirmed the payment. A valid receipt for this request, these payment
 * terms, this settlement and these exact response bytes records the attempt
 * `completed` with reason `receipt_verified`; a missing or failing receipt
 * records `paid_incomplete` with a `receipt_*` reason. The payment has
 * already happened either way: this records whether delivery is proven, it
 * refuses nothing.
 *
 * The gate ships no verifier and pins none: pass one. For Outbid-Receipt v1
 * that is `verifyReceipt` (and `splitSseReceipt` for streams) from
 * `outbid-receipt-verify`. This is unrelated to `requireReceipt`, which buys
 * TWZRD's V7 trust receipt before paying.
 */
import type { OutcomeValidator } from "./outcome-ledger-x402.js";
import type { ValidationFact } from "./outcome-ledger.js";

/** Default rule version recorded in the approval and returned by the validator. */
export const OUTBID_RECEIPT_RULE_V1 = "outbid-receipt/v1";

export type ReceiptExpectation = {
  body: Uint8Array;
  request_body: Uint8Array;
  method: string;
  path: string;
  network: string;
  payer: string;
  payee: string;
  asset: string;
  amount_atomic: string;
  settlement_ref: string;
  model: string;
};

/** The verifier's contract (outbid-receipt-verify's `verifyReceipt`): never throws, answers `{ ok, reason? }`. */
export type ReceiptVerifier = (token: string, opts: {
  keys: unknown[];
  iss: string;
  max_age_seconds: number;
  now_seconds: number;
  expect: ReceiptExpectation;
}) => { ok: boolean; reason?: string };

/** Splits a whole SSE body into the bytes before the trailer and the token (outbid-receipt-verify's `splitSseReceipt`). */
export type SseReceiptSplitter = (stream: Uint8Array) => { ok: boolean; body?: Uint8Array; token?: string; reason?: string };

export type ReceiptValidationOptions = {
  verify: ReceiptVerifier;
  /** The seller's keys, pinned at setup. Never fetched per call from the seller being checked. */
  keys: readonly unknown[];
  /** The issuer the receipt must name (the seller's https origin). */
  iss: string;
  /** Your paying address: the receipt must name it as payer. */
  payer: string;
  /** Oldest receipt accepted, in seconds. Default 900. */
  maxAgeSeconds?: number;
  /** Streams: the receipt rides in a trailer after `[DONE]`. Without a splitter, a stream with no receipt header is `receipt_missing`. */
  splitSse?: SseReceiptSplitter;
  /** The catalog model you asked for. Default: the request body's JSON `model`. */
  model?: (requestBody: Uint8Array) => string | undefined;
  /** Response headers read for the token, first non-empty wins. Default `Outbid-Receipt`, then `X-Outbid-Receipt`. */
  headers?: readonly string[];
  ruleVersion?: string;
  /** Clock in ms, for the age check. */
  now?: () => number;
};

const DEFAULT_HEADERS = ["Outbid-Receipt", "X-Outbid-Receipt"] as const;
/** RFC 8037 Appendix A's Ed25519 public key: its private key is printed in the RFC, so anyone can sign with it. */
const RFC8037_TEST_KEY_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

function requestModel(requestBody: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(requestBody)) as { model?: unknown } | null;
    return typeof parsed?.model === "string" && parsed.model ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

export function receiptValidationRule(options: ReceiptValidationOptions): { validate: OutcomeValidator; ruleVersion: string } {
  if (options.keys.some((k) => (k as { x?: unknown } | null)?.x === RFC8037_TEST_KEY_X)) {
    throw new TypeError("[twzrd-x402-gate] receiptValidationRule: keys include the RFC 8037 test key, whose private key is public");
  }
  const ruleVersion = options.ruleVersion ?? OUTBID_RECEIPT_RULE_V1;
  const names = options.headers ?? DEFAULT_HEADERS;
  const fail = (code: string): ValidationFact => ({ ok: false, ruleVersion, reasonCodes: [code] });

  const validate: OutcomeValidator = async ({ response, approval, settlementTx, requestBody }) => {
    let token: string | undefined;
    for (const name of names) {
      const value = response.headers.get(name)?.trim();
      if (value) { token = value; break; }
    }
    // The whole body: for a stream this waits for its end (the validator reads a clone).
    let body = new Uint8Array(await response.arrayBuffer());
    if (!token && options.splitSse && /^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
      const split = options.splitSse(body);
      if (!split?.ok || !split.token || !split.body) return fail(`receipt_${split?.reason ?? "missing"}`);
      token = split.token;
      body = new Uint8Array(split.body);
    }
    if (!token) return fail("receipt_missing");
    if (!settlementTx) return fail("receipt_unverifiable:no_settlement_tx");
    if (!requestBody) return fail("receipt_unverifiable:no_request_body");
    const model = (options.model ?? requestModel)(requestBody);
    if (!model) return fail("receipt_unverifiable:no_model");
    let path: string;
    try { path = new URL(approval.request.url).pathname; } catch { return fail("receipt_unverifiable:no_path"); }

    let verdict: { ok: boolean; reason?: string };
    try {
      verdict = options.verify(token, {
        keys: [...options.keys],
        iss: options.iss,
        max_age_seconds: options.maxAgeSeconds ?? 900,
        now_seconds: Math.floor((options.now?.() ?? Date.now()) / 1000),
        expect: {
          body,
          request_body: requestBody,
          method: approval.request.method,
          path,
          network: approval.network,
          payer: options.payer,
          payee: approval.payTo,
          asset: approval.asset,
          amount_atomic: approval.amountAtomic,
          settlement_ref: settlementTx,
          model,
        },
      });
    } catch {
      return fail("receipt_verifier_threw");
    }
    return verdict?.ok === true ? { ok: true, ruleVersion, reasonCodes: ["receipt_verified"] } : fail(`receipt_${verdict?.reason ?? "invalid"}`);
  };

  return { validate, ruleVersion };
}
