/**
 * Bind a pre-sign approval to the payment that actually leaves.
 *
 * The pre-sign hook approves one accepts[] entry. The payload the client then
 * sends is built by the payment scheme, and it is not always for that entry:
 * @x402/core lets a scheme answer a failed payment creation with a "recovered"
 * payload, returned without running the pre-sign hooks again, and a scheme may
 * build that payload for a different accepts[] entry (another recipient,
 * another amount). An approval that is only a flag on the call covers that
 * second payment too.
 *
 * Two controls, used together by the wrappers that own the transport:
 *  - refuseRecoveredPayments(): a payment that failed to build stays failed.
 *    Core runs client-level failure hooks before a scheme's own, so rethrowing
 *    the failure there stops the scheme's recovery before it signs.
 *  - paymentBindingRefusal(): the PAYMENT-SIGNATURE / X-PAYMENT header about to
 *    be sent must name the approved recipient, asset, network, amount and
 *    scheme. Anything else is refused before the request is made.
 */
import { resolveRequirementFields } from "./payto.js";
import { base64ToUtf8Strict } from "./strict-base64.js";

/** The outgoing payment names something other than the approved requirement. */
export const PAYMENT_DIFFERS_FROM_APPROVAL = "payment_differs_from_approval";
/** The outgoing payment header is not base64 JSON, so it cannot be compared. */
export const PAYMENT_PAYLOAD_UNREADABLE = "payment_payload_unreadable";

/** What a pre-sign check approved, as the outgoing payload must still name it. */
export type ApprovedRequirement = {
  scheme: string | undefined;
  network: string | undefined;
  payTo: string | undefined;
  asset: string | undefined;
  amount: string | undefined;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** EVM addresses compare case-insensitively; everything else is exact. */
function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Record the fields of a requirement a pre-sign check has just approved. */
export function approvedRequirementOf(selected: unknown): ApprovedRequirement {
  const r = asRecord(selected) ?? {};
  const fields = resolveRequirementFields(r);
  return {
    scheme: text(r.scheme),
    network: text(r.network),
    payTo: fields.payTo,
    asset: text(r.asset),
    amount: fields.amount,
  };
}

/** Every payment header on a request (v2 PAYMENT-SIGNATURE, v1 X-PAYMENT). */
export function paymentHeadersOf(headers: Headers): string[] {
  const out: string[] = [];
  for (const name of ["payment-signature", "x-payment"]) {
    const value = headers.get(name);
    if (value !== null) out.push(value);
  }
  return out;
}

/** The headers a fetch(input, init) call will send, without consuming a body. */
export function requestHeadersOf(input: Parameters<typeof fetch>[0], init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

/**
 * Why the payment in `header` is not the payment `approved` describes, or
 * undefined when it is.
 *
 * A v2 payload carries the requirement it pays in `accepted`; every approved
 * field must match it. A v1 payload has no `accepted`, only `scheme` and
 * `network`, and those two are compared. A v2 payload with no `accepted` is
 * refused: there is nothing to compare.
 */
export function paymentBindingRefusal(approved: ApprovedRequirement, header: string): string | undefined {
  let payload: Record<string, unknown> | undefined;
  try {
    payload = asRecord(JSON.parse(base64ToUtf8Strict(header)));
  } catch {
    payload = undefined;
  }
  if (!payload) return PAYMENT_PAYLOAD_UNREADABLE;

  const accepted = asRecord(payload.accepted);
  if (!accepted) {
    if (payload.x402Version !== 1) return PAYMENT_DIFFERS_FROM_APPROVAL;
    const sameScheme = approved.scheme === undefined || text(payload.scheme) === approved.scheme;
    const sameNetwork = approved.network === undefined || text(payload.network) === approved.network;
    return sameScheme && sameNetwork ? undefined : PAYMENT_DIFFERS_FROM_APPROVAL;
  }

  const fields = resolveRequirementFields(accepted);
  if (fields.conflict) return PAYMENT_DIFFERS_FROM_APPROVAL;
  const same =
    text(accepted.scheme) === approved.scheme &&
    text(accepted.network) === approved.network &&
    sameAddress(fields.payTo, approved.payTo) &&
    sameAddress(text(accepted.asset), approved.asset) &&
    fields.amount === approved.amount;
  return same ? undefined : PAYMENT_DIFFERS_FROM_APPROVAL;
}

type FailureHook = (context: { error?: unknown }) => Promise<never>;

/**
 * Register a failure hook that keeps a failed payment creation failed.
 *
 * `onFailure` runs first (void the approval there). The original error is then
 * rethrown, which ends core's recovery loop before any scheme or extension
 * hook can return a payload the pre-sign checks never saw. A client without
 * `onPaymentCreationFailure` has no recovery to stop; returns false.
 */
export function refuseRecoveredPayments(client: unknown, onFailure: () => void): boolean {
  const register = (client as { onPaymentCreationFailure?: unknown } | null | undefined)?.onPaymentCreationFailure;
  if (typeof register !== "function") return false;
  const hook: FailureHook = async (context) => {
    onFailure();
    throw context?.error ?? new Error("payment creation failed");
  };
  (register as (hook: FailureHook) => unknown).call(client, hook);
  return true;
}
