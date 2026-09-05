/**
 * requireLogInclusion — a paid V6 receipt does not satisfy `requireReceipt`
 * until its leaf is proven included in the Receipt Transparency log under a
 * head the buyer's PINNED key signed.
 *
 * A valid receipt signature proves authorship and integrity. It does not prove
 * the issuer showed everyone the same answer (non-equivocation) or that the
 * receipt existed when it claims to. The log closes that gap; this policy makes
 * the gate refuse to treat an unproven receipt as trust.
 *
 * Injection, not dependency. `twzrd-log-verifier` is not published to npm and
 * this package must stay publishable, so the gate defines the verdict shape and
 * the host wires the verifier. The verifier's `verifyReceiptInLog` result
 * satisfies `LogInclusionVerdict` structurally — no adapter:
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
};

export type LogInclusionVerifier = (receipt: unknown) => Promise<LogInclusionVerdict>;

export type RequireLogInclusionPolicy = {
  /** Checks a captured receipt against the log. Required. */
  verifier: LogInclusionVerifier;
  /** Default true: a receipt that is not proven in the log denies spend. */
  hard?: boolean;
  /** Leaf not yet merged: "deny" (default) or "allow" (tolerate the merge-delay window). */
  onPending?: "deny" | "allow";
  /** Default true: refuse a verdict whose keys were taken from the log itself. */
  refuseTofu?: boolean;
};

export type ResolvedRequireLogInclusionPolicy = {
  verifier: LogInclusionVerifier | undefined;
  hard: boolean;
  onPending: "deny" | "allow";
  refuseTofu: boolean;
};

export type LogInclusionDenyReason =
  | "twzrd_log_inclusion_failed"
  | "twzrd_log_inclusion_pending"
  | "twzrd_log_inclusion_tofu_refused"
  | "twzrd_log_inclusion_error";

export type LogInclusionOutcome = {
  /** true when a verifier actually ran against a receipt */
  checked: boolean;
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
 */
export function resolveRequireLogInclusionPolicy(
  raw: RequireLogInclusionPolicy | false | undefined,
): ResolvedRequireLogInclusionPolicy | null {
  if (raw === undefined || raw === false) return null;
  // JS consumers can pass anything. `null` would throw on property access and
  // crash evaluate_x402_resource; `true` (valid for other knobs) would silently
  // read as an empty object. Either way the host asked for the policy without
  // wiring a verifier, so resolve to "set but misconfigured": hard mode then
  // denies instead of crashing or silently skipping.
  if (typeof raw !== "object" || raw === null) {
    return { verifier: undefined, hard: true, onPending: "deny", refuseTofu: true };
  }
  return {
    verifier: typeof raw.verifier === "function" ? raw.verifier : undefined,
    hard: raw.hard !== false,
    onPending: raw.onPending === "allow" ? "allow" : "deny",
    refuseTofu: raw.refuseTofu !== false,
  };
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

  let verdict: LogInclusionVerdict;
  try {
    verdict = await policy.verifier(receipt);
  } catch (e) {
    return deny(
      { checked: true, valid: false, errors: [(e as Error)?.message ?? String(e)] },
      policy,
      "twzrd_log_inclusion_error",
    );
  }

  const errors = Array.isArray(verdict?.errors) ? verdict.errors : [];
  const outcome: LogInclusionOutcome = {
    checked: true,
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
