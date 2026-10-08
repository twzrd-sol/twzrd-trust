/**
 * Clearance SKU — paid, challenge-bound `twzrd.payment_decision.v1`.
 *
 * Issue #99: the hook must not invoke the signer without an unexpired
 * `allow` or `warn` for this exact 402 `challenge_hash`. Free refuse stays
 * free (the caller never reaches this module on a policy block).
 *
 * `GET /v1/intel/quick/{seller}` is a $0.001 score teaser. It is not this SKU:
 * it is not challenge-bound and it does not unlock the signer.
 *
 * Intel does not yet issue this record over x402. Until it does, a host
 * supplies a verified record or an explicit `issuerUrl`. Do not default the
 * issuer to `/v1/intel/quick`.
 */
import {
  verifyPaymentDecisionRecord,
  type PaymentDecisionRecordV1,
  type PaymentDecisionVerification,
  type VerifyPaymentDecisionOptions,
} from "./payment-decision.js";
import type { ResourceBindReq } from "./resource-bind.js";

/** Invoice price. The live issuer is not this package. */
export const CLEARANCE_SKU_USDC = 0.001;

export type RequirePaymentDecisionPolicy = {
  /** Default true. Soft annotates and still proceeds — not the SKU. */
  hard: boolean;
  /** Already-issued record. Preferred: no paid hop. */
  record?: unknown;
  publicKeyPem?: string;
  publicKeys?: Record<string, string>;
  /**
   * Paying issuer. POST `{ challenge }` via `x402Fetch`. Absent unless the
   * host names one — live intel has no payment-decision 402 today.
   */
  issuerUrl?: string;
};

export type RequirePaymentDecision =
  | boolean
  | (Omit<RequirePaymentDecisionPolicy, "hard"> & { hard?: boolean });

export function resolveRequirePaymentDecisionPolicy(
  value: RequirePaymentDecision | undefined,
): RequirePaymentDecisionPolicy | null {
  if (value === undefined || value === false) return null;
  if (value === true) return { hard: true };
  return {
    hard: value.hard !== false,
    record: value.record,
    publicKeyPem: value.publicKeyPem,
    publicKeys: value.publicKeys,
    issuerUrl: typeof value.issuerUrl === "string" && value.issuerUrl.length > 0
      ? value.issuerUrl
      : undefined,
  };
}

export type ClearanceSkuResult = {
  required: true;
  cleared: boolean;
  reason: string;
  denied?: boolean;
  paid?: boolean;
  record?: PaymentDecisionRecordV1;
  verification?: PaymentDecisionVerification;
};

function denied(reason: string, extra: Partial<ClearanceSkuResult> = {}): ClearanceSkuResult {
  return { required: true, cleared: false, denied: true, reason, ...extra };
}

function recordFromIssuerBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  if (o.schema === "twzrd.payment_decision.v1") return o;
  if (o.twzrd_payment_decision && typeof o.twzrd_payment_decision === "object") {
    return o.twzrd_payment_decision;
  }
  if (o.record && typeof o.record === "object") return o.record;
  return undefined;
}

async function fetchIssuedRecord(
  issuerUrl: string,
  challenge: ResourceBindReq,
  x402Fetch: typeof fetch,
): Promise<{ record?: unknown; paid: boolean; miss?: string }> {
  try {
    const resp = await x402Fetch(issuerUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
    });
    if (!resp.ok) {
      return { paid: false, miss: `clearance_issuer_http_${resp.status}` };
    }
    const body = await resp.json();
    const record = recordFromIssuerBody(body);
    if (!record) return { paid: true, miss: "clearance_issuer_no_record" };
    return { record, paid: true };
  } catch {
    return { paid: false, miss: "clearance_issuer_error" };
  }
}

function acceptDecision(decision: string | null): boolean {
  return decision === "allow" || decision === "warn";
}

/**
 * Verify (and optionally buy) the clearance SKU for one selected 402 entry.
 * Never throws. A hard miss is `cleared: false` — the hook aborts.
 */
export async function evaluateClearanceSku(opts: {
  policy: RequirePaymentDecisionPolicy;
  challenge: ResourceBindReq;
  x402Fetch?: typeof fetch;
  now?: number;
}): Promise<ClearanceSkuResult> {
  const verifyOpts: VerifyPaymentDecisionOptions = {
    publicKeyPem: opts.policy.publicKeyPem,
    publicKeys: opts.policy.publicKeys,
    now: opts.now,
    challenge: opts.challenge,
  };

  let record = opts.policy.record;
  let paid = false;

  if (record === undefined) {
    const issuer = opts.policy.issuerUrl;
    if (issuer && typeof opts.x402Fetch === "function") {
      const bought = await fetchIssuedRecord(issuer, opts.challenge, opts.x402Fetch);
      record = bought.record;
      paid = bought.paid === true;
      if (record === undefined) {
        return denied(bought.miss ?? "clearance_required_missing_record", { paid });
      }
    } else if (issuer && typeof opts.x402Fetch !== "function") {
      return denied("clearance_required_missing_x402Fetch");
    } else {
      return denied("clearance_required_missing_record");
    }
  }

  if (!opts.policy.publicKeyPem && !opts.policy.publicKeys) {
    return denied("clearance_required_missing_verifier_key");
  }

  const verification = verifyPaymentDecisionRecord(record, verifyOpts);
  if (!verification.ok) {
    const codes = verification.errors.map((e) => e.code).join(",") || "verify_failed";
    return denied(`clearance_required_failed (${codes})`, { verification, paid });
  }
  if (!acceptDecision(verification.decision)) {
    return denied(`clearance_decision_${verification.decision}`, {
      verification,
      paid,
      record: record as PaymentDecisionRecordV1,
    });
  }
  return {
    required: true,
    cleared: true,
    reason: `clearance_${verification.decision}`,
    paid: paid || undefined,
    record: record as PaymentDecisionRecordV1,
    verification,
  };
}
