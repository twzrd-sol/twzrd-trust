/**
 * x402 resource-binding v1. Canonical JSON leaf (not the earlier binary sketch).
 * Fields: schema_version, pay_to, asset, amount_raw, network, resource_url,
 * body_hash=0, requirements_hash (named projection: payTo/amount/asset/network/
 * resource/scheme — not the verbatim accepts[] blob; mimeType/timeout/extra-only
 * diffs collide). Omitted on purpose: payer (unknown here), tx_signature/slot
 * (a leaf cannot contain its own tx), salt (v1 has none; adding one is v2).
 * This seat stamps extra.twzrd_resource_bind in memory. It does not write a
 * Solana memo. Hard bind is evaluateResourceBind({ tx_contains_hash: true }).
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./intent.js";

export const RESOURCE_BIND_DOMAIN = "twzrd:x402-resource-binding:v1";
export const RESOURCE_BIND_EXTRA_KEY = "twzrd_resource_bind";
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

export function stampResourceBind(req: ResourceBindReq): ResourceBindDecision {
  if (!(req.payTo ?? req.pay_to) || !(req.amount ?? req.maxAmountRequired) || !req.resource) {
    return refuse("missing payTo/amount/resource");
  }
  let leaf_hash: string;
  try { leaf_hash = resourceBindLeafHash(req); }
  catch { return refuse("uncanonical resource URL"); }
  req.extra = { ...(req.extra ?? {}), [RESOURCE_BIND_EXTRA_KEY]: leaf_hash };
  return {
    strength: "soft", evidence_level: "client_stamped", fact_type: "resource_bound",
    leaf_hash, extra_stamped: true,
    reason: "hash stamped on extra; tx inclusion not observed at this seat",
  };
}

export function evaluateResourceBind(obs: {
  leaf_hash: string; tx_contains_hash?: boolean; body_hash?: string; extra_stamped?: boolean;
}): ResourceBindDecision {
  if (obs.body_hash && obs.body_hash !== ZERO_BODY_HASH) {
    return refuse("v1 forbids nonzero body_hash", obs.leaf_hash);
  }
  const hard = !!obs.tx_contains_hash;
  return {
    strength: hard ? "hard" : "soft",
    evidence_level: hard ? "tx_included" : "client_stamped",
    fact_type: "resource_bound", leaf_hash: obs.leaf_hash,
    extra_stamped: !!obs.extra_stamped,
    reason: hard ? "tx contains leaf hash" : "client stamped; tx not verified",
  };
}
