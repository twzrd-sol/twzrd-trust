/**
 * x402 resource-binding v1. Canonical JSON leaf (not the earlier binary sketch).
 * Fields: schema_version, pay_to, asset, amount_raw, network, resource_url,
 * body_hash=0, requirements_hash (named projection: payTo/amount/asset/network/
 * resource/scheme — not the verbatim accepts[] blob; mimeType/timeout/extra-only
 * diffs collide). Omitted on purpose: payer (unknown here), tx_signature/slot
 * (a leaf cannot contain its own tx), salt (v1 has none; adding one is v2).
 * This seat stamps extra.twzrd_resource_bind. If seller extra.memo is unset,
 * it also sets extra.memo to rb1:<base64url(32-byte leaf)> (≤48 chars).
 * ExactSvmScheme hardcodes 20k CU; Memo costs ~1320+358/byte, so a 76-char
 * twzrd-rb-v1:<hex> memo (~28.5k CU) can never settle — that form never
 * landed and is not honored. Stamp omits extra.memo if encoded length
 * exceeds RESOURCE_BIND_MEMO_MAX. Facilitator only checks extra.memo when
 * the seller published one — never overwrite a seller memo. Hard bind:
 * evaluateResourceBind({ tx_memo }) — tx_memo is UTF-8 decoded from the
 * settled tx Memo IX, never the client's extra.memo stamp — or
 * { tx_contains_hash: true }. Hard is memo inclusion only; transfer legs
 * are NOT verified at this seat.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./intent.js";

export const RESOURCE_BIND_DOMAIN = "twzrd:x402-resource-binding:v1";
export const RESOURCE_BIND_EXTRA_KEY = "twzrd_resource_bind";
export const RESOURCE_BIND_MEMO_PREFIX = "rb1:";
/** Memo program CU ≈ 1320 + 358*bytes. 48 B ≈ 18.5k < ExactSvm 20k budget. */
export const RESOURCE_BIND_MEMO_MAX = 48;
export const ZERO_BODY_HASH = "0".repeat(64);
export type BindStrength = "hard" | "soft" | "refuse";
export type ResourceBindReq = {
  payTo?: string; pay_to?: string; network?: string; amount?: string;
  maxAmountRequired?: string; asset?: string; resource?: string; scheme?: string;
  extra?: Record<string, unknown>;
};
export type ResourceBindDecision = {
  strength: BindStrength;
  evidence_level: "tx_included" | "client_stamped" | "unbound";
  fact_type: "resource_bound";
  leaf_hash: string | null;
  extra_stamped: boolean;
  reason: string;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const refuse = (reason: string, leaf_hash: string | null = null): ResourceBindDecision => ({
  strength: "refuse", evidence_level: "unbound", fact_type: "resource_bound",
  leaf_hash, extra_stamped: false, reason,
});

export function canonicalResourceUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  const pairs = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of pairs) u.searchParams.append(k, v);
  return u.toString();
}

export function resourceBindLeafHash(req: ResourceBindReq): string {
  const amount = req.amount ?? req.maxAmountRequired ?? "";
  const payTo = req.payTo ?? req.pay_to ?? "";
  const raw = req.resource ?? "";
  const leaf = {
    amount_raw: amount, asset: req.asset ?? "", body_hash: ZERO_BODY_HASH,
    network: req.network ?? "", pay_to: payTo,
    requirements_hash: sha256(canonicalJson({
      amount, asset: req.asset ?? "", network: req.network ?? "",
      payTo, resource: req.resource ?? "", scheme: req.scheme ?? "",
    })),
    resource_url: raw ? canonicalResourceUrl(raw) : "", schema_version: 1,
  };
  return sha256(`${RESOURCE_BIND_DOMAIN}\n${canonicalJson(leaf)}`);
}

export function resourceBindMemo(leaf_hash: string): string {
  const bytes = Buffer.from(leaf_hash, "hex");
  if (bytes.length !== 32) throw new Error("leaf_hash must be 32-byte hex");
  return `${RESOURCE_BIND_MEMO_PREFIX}${bytes.toString("base64url")}`;
}

export function memoContainsResourceBind(memo: string, leaf_hash: string): boolean {
  return memo === resourceBindMemo(leaf_hash);
}

export function stampResourceBind(req: ResourceBindReq): ResourceBindDecision {
  if (!(req.payTo ?? req.pay_to) || !(req.amount ?? req.maxAmountRequired) || !req.resource) {
    return refuse("missing payTo/amount/resource");
  }
  let leaf_hash: string;
  try { leaf_hash = resourceBindLeafHash(req); }
  catch { return refuse("uncanonical resource URL"); }
  const extra: Record<string, unknown> = { ...(req.extra ?? {}), [RESOURCE_BIND_EXTRA_KEY]: leaf_hash };
  const sellerMemo = extra.memo;
  const memoFree = sellerMemo == null || sellerMemo === "";
  let memo: string | undefined;
  if (memoFree) {
    memo = resourceBindMemo(leaf_hash);
    if (memo.length <= RESOURCE_BIND_MEMO_MAX) extra.memo = memo;
  }
  req.extra = extra;
  return {
    strength: "soft", evidence_level: "client_stamped", fact_type: "resource_bound",
    leaf_hash, extra_stamped: true,
    reason: !memoFree
      ? "seller extra.memo kept; bind hash only on extra.twzrd_resource_bind"
      : extra.memo
        ? "hash on extra.memo for ExactSvmScheme memo IX (seller did not publish extra.memo)"
        : "bind hash stamped; memo omitted (over compute-safe cap)",
  };
}

export function evaluateResourceBind(obs: {
  leaf_hash: string; tx_contains_hash?: boolean; body_hash?: string;
  extra_stamped?: boolean;
  /** UTF-8 payload of the settled tx Memo IX. Not extra.memo. */
  tx_memo?: string;
}): ResourceBindDecision {
  if (obs.body_hash && obs.body_hash !== ZERO_BODY_HASH) {
    return refuse("v1 forbids nonzero body_hash", obs.leaf_hash);
  }
  const hard = !!obs.tx_contains_hash ||
    (!!obs.tx_memo && memoContainsResourceBind(obs.tx_memo, obs.leaf_hash));
  return {
    strength: hard ? "hard" : "soft",
    evidence_level: hard ? "tx_included" : "client_stamped",
    fact_type: "resource_bound", leaf_hash: obs.leaf_hash,
    extra_stamped: !!obs.extra_stamped,
    reason: hard
      ? "memo inclusion only; transfer legs NOT verified at this seat"
      : "client stamped; tx not verified",
  };
}
