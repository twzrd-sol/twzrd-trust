/*
 * Equivocation detection: two correctly signed Signed Tree Heads for the same
 * log_id that cannot both describe one append-only log. The two STH JSON
 * envelopes ARE the misbehavior proof — portable, offline-checkable by anyone
 * with the pinned log key or key directory.
 *
 * Rotation is not an escape hatch. Two contradictory heads convict the log even
 * when different key_ids signed them: every key in the pinned directory speaks
 * for the same log_id, so "a different key of ours signed that one" is an
 * admission, not a defence. The proof bundle records both key_ids for exactly
 * this reason.
 */
import { verifySth, type SignedTreeHead } from "./sth.js";
import { verifyConsistency } from "./merkle.js";
import { hexToBytes } from "./util.js";
import type { LogKeyDirectory } from "./keydir.js";

export interface EquivocationResult {
  /** true when the two STHs are cryptographic proof of log misbehavior */
  equivocation: boolean;
  /** why (or why not) */
  reason: string;
  errors: string[];
  /** whether the two heads were signed by different key_ids (rotation spanned) */
  cross_key: boolean;
  /** portable proof bundle when equivocation === true */
  proof?: {
    sth_a: SignedTreeHead;
    sth_b: SignedTreeHead;
    consistency_path?: string[];
    key_id_a?: string;
    key_id_b?: string;
  };
}

/**
 * Same log_id + same tree_size + different roots = equivocation, no proof
 * material needed beyond the two signatures.
 *
 * For different tree sizes, pass the log's consistency proof between the two
 * sizes (`consistencyPath`); a verification failure is equally damning, but a
 * missing proof is only "unproven", never "proven honest".
 */
export function checkEquivocation(
  sthA: SignedTreeHead,
  sthB: SignedTreeHead,
  trusted: string | LogKeyDirectory,
  consistencyPath?: string[],
): EquivocationResult {
  const out: EquivocationResult = {
    equivocation: false,
    reason: "",
    errors: [],
    cross_key: false,
  };

  const resA = verifySth(sthA, trusted);
  const resB = verifySth(sthB, trusted);
  if (!resA.valid) out.errors.push(...resA.errors.map((e) => `sth_a: ${e}`));
  if (!resB.valid) out.errors.push(...resB.errors.map((e) => `sth_b: ${e}`));
  if (!resA.valid || !resB.valid) {
    out.reason = "one or both STH signatures are invalid — not attributable to the log";
    return out;
  }

  out.cross_key = Boolean(resA.key_id && resB.key_id && resA.key_id !== resB.key_id);

  if (String(sthA.log_id) !== String(sthB.log_id)) {
    out.reason = "different log_id values — heads belong to different logs";
    return out;
  }

  const rootA = String(sthA.root).toLowerCase().replace(/^0x/, "");
  const rootB = String(sthB.root).toLowerCase().replace(/^0x/, "");
  const bundle = (path?: string[]) => ({
    sth_a: sthA,
    sth_b: sthB,
    ...(path ? { consistency_path: path } : {}),
    ...(resA.key_id ? { key_id_a: resA.key_id } : {}),
    ...(resB.key_id ? { key_id_b: resB.key_id } : {}),
  });

  if (Number(sthA.tree_size) === Number(sthB.tree_size)) {
    if (rootA === rootB) {
      out.reason = "same tree_size and same root — consistent";
      return out;
    }
    out.equivocation = true;
    out.reason =
      `two valid STHs for log_id ${JSON.stringify(String(sthA.log_id))} at tree_size ` +
      `${sthA.tree_size} with different roots` +
      (out.cross_key
        ? ` (signed by different keys, ${resA.key_id} and ${resB.key_id} — both speak for this log, so rotation does not excuse it)`
        : "");
    out.proof = bundle();
    return out;
  }

  // Different sizes: adjudicate with a consistency proof if one was supplied.
  const [older, newer] =
    Number(sthA.tree_size) < Number(sthB.tree_size) ? [sthA, sthB] : [sthB, sthA];
  if (!consistencyPath) {
    out.reason =
      "different tree sizes and no consistency proof supplied — fetch " +
      `/v1/log/proof/consistency?old_size=${older.tree_size}&new_size=${newer.tree_size} and re-run`;
    return out;
  }
  let ok = false;
  try {
    ok = verifyConsistency(
      Number(older.tree_size),
      hexToBytes(older.root),
      Number(newer.tree_size),
      hexToBytes(newer.root),
      consistencyPath.map(hexToBytes),
    );
  } catch (e) {
    out.errors.push(`malformed consistency path: ${(e as Error).message}`);
    out.reason = "consistency path could not be decoded";
    return out;
  }
  if (ok) {
    out.reason = "consistency proof verifies — the newer head extends the older one";
    return out;
  }
  out.equivocation = true;
  out.reason =
    `consistency proof between tree_size ${older.tree_size} and ${newer.tree_size} FAILS — ` +
    "the log rewrote history";
  out.proof = bundle(consistencyPath);
  return out;
}
