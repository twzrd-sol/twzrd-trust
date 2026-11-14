/**
 * requireLogInclusion — a paid receipt does not satisfy `requireReceipt`
 * until its leaf is proven included in the Receipt Transparency log under a
 * head the buyer's PINNED key signed.
 *
 * A valid receipt signature proves authorship and integrity. It does not prove
 * the issuer showed everyone the same answer (non-equivocation) or that the
 * receipt existed when it claims to. The log closes that gap; this policy makes
 * the gate refuse to treat an unproven receipt as trust.
 *
 * The log proves a leaf, not the fields printed beside it. So before the
 * verifier runs, the gate itself checks the receipt (receipt-binding.ts): it
 * recomputes the canonical leaf from the receipt's preimage, requires
 * `receipt.leaf` to equal it, and requires the receipt's Ed25519 signature to
 * verify over that leaf under the pinned receipt issuer key
 * (`twzrd-receipt-ed25519-v2` by default; `receiptPubkey` overrides the pin).
 * A receipt that fails is denied with `twzrd_log_inclusion_receipt_invalid`
 * and the verifier is never called, so a proof for a logged leaf cannot carry
 * a receipt whose score or other signed field was changed. A verdict that
 * names the leaf it proved has to name that same leaf.
 *
 * Injection, not dependency. `twzrd-log-verifier` is a separate npm package
 * (published since 0.3.0; install the latest) and this package takes no
 * dependency on it, so the gate defines the verdict shape and the host wires
 * the verifier. The verifier's `verifyReceiptInLog`
 * result satisfies `LogInclusionVerdict` structurally — no adapter:
 *
 *   import { verifyReceiptInLog } from "twzrd-log-verifier";
 *   evaluate_x402_resource(url, reqs, {
 *     requireReceipt: true,
 *     x402Fetch,
 *     requireLogInclusion: {
 *       verifier: (receipt) =>
 *         verifyReceiptInLog({ baseUrl, receipt, trusted: pinnedKeyDirectory }),
 *     },
 *   });
 *
 * Scope: the policy gates receipts, it does not override the host's Path A
 * threshold. When Path A is ATTEMPTED, a hard policy requires it to yield a
 * receipt that is then proven — non-OK, thrown, and missing-x402Fetch all
 * deny (evaluate.ts), so an outage on the receipt endpoint can never produce
 * a better outcome than an empty receipt body. Path A not attempted by policy
 * (below the requireReceipt threshold) is out of scope.
 *
 * Defaults are the conservative reading of docs/transparency-log.md:
 *   - hard: an unproven receipt denies spend (it never silently "counts").
 *   - onPending "deny": a leaf not yet merged is unprovable at pay time. The
 *     spec allows one anchor period of merge delay and calls it a retry case,
 *     not misbehavior — hosts that accept that window set onPending: "allow".
 *   - refuseTofu: a verdict reached with keys the log advertised about itself
 *     is circular; requireLogInclusion exists to demand a pin.
 */

import { verifyReceiptBinding } from "./receipt-binding.js";

export type LogInclusionVerdict = {
  valid: boolean;
  errors: string[];
  /** Leaf not merged yet (log answered 404). Retry after the next anchor. */
  not_yet_merged?: boolean;
  /** Keys came from the log's own descriptor (trust-on-first-use), not a caller pin. */
  tofu?: boolean;
  key_id?: string;
  leaf_index?: number;
  tree_size?: number;
  /**
   * The leaf the verifier proved (hex, 0x optional). `twzrd-log-verifier`
   * results carry it. When present it must be the receipt's leaf as the gate
   * recomputed it, or the verdict is refused.
   */
  leaf?: string;
};

/**
 * What the gate hands the verifier alongside the receipt. A paid response
 * carries its inclusion proof INLINE (`log_inclusion`: proof + the signed
 * head it targets) once the leaf is merged, so the offline verifier needs the
 * whole response, not just `twzrd_receipt`. `logInclusion` is that block when
 * present; it is a convenience, not a verdict — an absent block means the
 * host's verifier decides what to do (fetch, or report pending).
 */
export type LogInclusionContext = {
  /** The entire paid /v1/intel/trust response body. */
  response: unknown;
  /** `response.log_inclusion`, when the server attached one. */
  logInclusion?: unknown;
  /**
   * The receipt's leaf, 64 lowercase hex chars, as the gate recomputed it from
   * the receipt's fields and checked the issuer signature over. Set on every
   * verifier call.
   */
  leaf?: string;
};

/**
 * Host-wired verifier. A one-argument function is assignable too, so existing
 * `(receipt) => …` wirings keep working; the second argument is what lets a
 * host verify offline against the block the response already carries:
 *
 *   verifier: async (_receipt, ctx) =>
 *     ctx.logInclusion
 *       ? verifyLogInclusion(ctx.response, pin)               // offline, no round-trip
 *       : verifyReceiptInLog({ baseUrl, receipt: ctx.response, trusted: pin }), // fetch; 404 => pending
 */
export type LogInclusionVerifier = (
  receipt: unknown,
  ctx: LogInclusionContext,
) => Promise<LogInclusionVerdict>;

export type RequireLogInclusionPolicy = {
  /** Checks a captured receipt against the log. Required. */
  verifier: LogInclusionVerifier;
  /** Default true: a receipt that is not proven in the log denies spend. */
  hard?: boolean;
  /** Leaf not yet merged: "deny" (default) or "allow" (tolerate the merge-delay window). */
  onPending?: "deny" | "allow";
  /** Default true: refuse a verdict whose keys were taken from the log itself. */
  refuseTofu?: boolean;
  /**
   * Receipt issuer key or keys (base58 Ed25519) the receipt signature must
   * verify under. Default: the pinned issuer key, `RECEIPT_ISSUER_PUBKEY`
   * (key_id `twzrd-receipt-ed25519-v2`). The key a receipt names for itself is
   * never used.
   */
  receiptPubkey?: string | readonly string[];
};

export type ResolvedRequireLogInclusionPolicy = {
  verifier: LogInclusionVerifier | undefined;
  hard: boolean;
  onPending: "deny" | "allow";
  refuseTofu: boolean;
  /**
   * Pinned receipt issuer keys. Absent means the default pin. An empty list
   * (the host set `receiptPubkey` to something that is not a key) verifies
   * nothing, so every receipt is refused.
   */
  receiptPubkeys?: readonly string[];
};

export type LogInclusionDenyReason =
  | "twzrd_log_inclusion_failed"
  | "twzrd_log_inclusion_pending"
  | "twzrd_log_inclusion_tofu_refused"
  | "twzrd_log_inclusion_error"
  | "twzrd_log_inclusion_receipt_invalid";

export type LogInclusionOutcome = {
  /** true when a verifier actually ran against a receipt */
  checked: boolean;
  /**
   * true when the receipt's leaf recomputed from its fields and its issuer
   * signature verified under the pinned key. false when that check refused the
   * receipt (the verifier did not run). Absent when no receipt was checked.
   */
  receipt_bound?: boolean;
  /** The receipt's recomputed leaf (64 lowercase hex), when `receipt_bound`. */
  leaf?: string;
  /**
   * true when the verifier proved inclusion and the policy accepted the
   * verdict. Under the default `refuseTofu` that implies a caller-pinned key;
   * with `refuseTofu: false` a TOFU verdict can be valid too — read `tofu`
   * alongside this, never in place of it.
   */
  valid: boolean;
  /** leaf not merged yet */
  pending?: boolean;
  tofu?: boolean;
  key_id?: string;
  leaf_index?: number;
  tree_size?: number;
  errors?: string[];
  /** present when this outcome denies spend under a hard policy */
  denyReason?: LogInclusionDenyReason;
};

/**
 * Normalize host config. `undefined`/`false` → null (policy off). An object is
 * kept even without a verifier: a hard policy the host forgot to wire must deny,
 * not silently skip — the same rule `requireReceipt` applies to a missing
 * `x402Fetch`.
 *
 * The parameter is `unknown` on purpose. This is the runtime boundary, and JS
 * callers can hand it anything; the signature should say so rather than force
 * casts to reach behavior that exists exactly for those inputs. The *option*
 * type on EvaluateX402Options stays strict (`RequireLogInclusionPolicy | false`)
 * because `true` is not a valid config — there is no default verifier — and the
 * type must not suggest otherwise. Strict at the API, honest at the boundary.
 */
export function resolveRequireLogInclusionPolicy(
  raw: unknown,
): ResolvedRequireLogInclusionPolicy | null {
  if (raw === undefined || raw === false) return null;
  // `null` would throw on property access and crash evaluate_x402_resource;
  // `true` (valid for sibling knobs) would read as an empty object. Either way
  // the host asked for the policy without wiring a verifier, so resolve to
  // "set but misconfigured": hard mode then denies instead of crashing or
  // silently skipping.
  if (typeof raw !== "object" || raw === null) {
    return { verifier: undefined, hard: true, onPending: "deny", refuseTofu: true };
  }
  const r = raw as Partial<Record<keyof RequireLogInclusionPolicy, unknown>>;
  return {
    verifier: typeof r.verifier === "function" ? (r.verifier as LogInclusionVerifier) : undefined,
    hard: r.hard !== false,
    onPending: r.onPending === "allow" ? "allow" : "deny",
    refuseTofu: r.refuseTofu !== false,
    ...(r.receiptPubkey === undefined ? {} : { receiptPubkeys: pinnedReceiptKeys(r.receiptPubkey) }),
  };
}

/**
 * A host-supplied pin as a list. Anything that is not a non-empty string, or a
 * non-empty array of them, resolves to no keys at all: the host asked for its
 * own pin, so falling back to the default one would verify under a key it did
 * not choose.
 */
function pinnedReceiptKeys(raw: unknown): readonly string[] {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return list.every((k) => typeof k === "string" && k !== "") ? (list as string[]) : [];
}

function deny(
  outcome: LogInclusionOutcome,
  policy: ResolvedRequireLogInclusionPolicy,
  reason: LogInclusionDenyReason,
): LogInclusionOutcome {
  return policy.hard ? { ...outcome, denyReason: reason } : outcome;
}

/**
 * Run the policy against a captured receipt. Never throws: a verifier error is
 * a verification failure, and under a hard policy a failure denies. Fail-open
 * on an exception would let a broken or unreachable verifier wave receipts
 * through — the opposite of what a host asked for by enabling this.
 */
export async function evaluateLogInclusion(
  receipt: unknown,
  policy: ResolvedRequireLogInclusionPolicy,
  ctx: LogInclusionContext,
): Promise<LogInclusionOutcome> {
  if (receipt === undefined || receipt === null) {
    return deny(
      { checked: false, valid: false, errors: ["no twzrd_receipt to prove in the log"] },
      policy,
      "twzrd_log_inclusion_failed",
    );
  }
  if (!policy.verifier) {
    return deny(
      {
        checked: false,
        valid: false,
        errors: ["requireLogInclusion is set but no verifier was wired"],
      },
      policy,
      "twzrd_log_inclusion_error",
    );
  }

  // The receipt first: its fields must hash to its leaf, and the issuer must
  // have signed that leaf. Until that holds there is nothing worth looking up,
  // and a pending or TOFU answer about the leaf would say nothing about the
  // fields either.
  const bound = verifyReceiptBinding(receipt, policy.receiptPubkeys);
  if (!bound.ok) {
    return deny(
      { checked: false, receipt_bound: false, valid: false, errors: [bound.error] },
      policy,
      "twzrd_log_inclusion_receipt_invalid",
    );
  }

  let verdict: LogInclusionVerdict;
  try {
    verdict = await policy.verifier(receipt, { ...ctx, leaf: bound.leaf });
  } catch (e) {
    return deny(
      {
        checked: true, receipt_bound: true, leaf: bound.leaf, valid: false,
        errors: [(e as Error)?.message ?? String(e)],
      },
      policy,
      "twzrd_log_inclusion_error",
    );
  }

  // A verdict about some other leaf is not a verdict about this receipt.
  const proved = verdict?.leaf;
  if (proved !== undefined && proved !== null
    && (typeof proved !== "string" || proved.replace(/^0x/, "").toLowerCase() !== bound.leaf)) {
    return deny(
      {
        checked: true, receipt_bound: true, leaf: bound.leaf, valid: false,
        errors: ["the verifier's verdict names a different leaf than the receipt's"],
      },
      policy,
      "twzrd_log_inclusion_failed",
    );
  }

  const errors = Array.isArray(verdict?.errors) ? verdict.errors : [];
  const outcome: LogInclusionOutcome = {
    checked: true,
    receipt_bound: true,
    leaf: bound.leaf,
    valid: verdict?.valid === true,
    ...(verdict?.tofu ? { tofu: true } : {}),
    ...(verdict?.key_id ? { key_id: verdict.key_id } : {}),
    ...(typeof verdict?.leaf_index === "number" ? { leaf_index: verdict.leaf_index } : {}),
    ...(typeof verdict?.tree_size === "number" ? { tree_size: verdict.tree_size } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };

  // Not merged yet: unprovable, but not misbehavior. Tolerated only on request.
  if (verdict?.not_yet_merged) {
    const pending = { ...outcome, valid: false, pending: true };
    return policy.onPending === "allow"
      ? pending
      : deny(pending, policy, "twzrd_log_inclusion_pending");
  }

  // Checked before `valid`: a TOFU verdict can be "valid" against keys the log
  // chose for itself, which is exactly the trust this policy refuses.
  if (verdict?.tofu && policy.refuseTofu) {
    return deny({ ...outcome, valid: false }, policy, "twzrd_log_inclusion_tofu_refused");
  }

  if (!outcome.valid) {
    return deny(outcome, policy, "twzrd_log_inclusion_failed");
  }
  return outcome;
}
