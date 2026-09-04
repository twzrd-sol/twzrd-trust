/*
 * Log client: fetch the descriptor, heads, and proofs, then verify them.
 *
 * Trust rule enforced structurally here: the log descriptor is served by the
 * log's own domain, so the keys it advertises are NOT a root of trust. A caller
 * that pins keys out-of-band always wins — descriptor keys are never consulted
 * for verification in that case. A caller that pins nothing must opt in with
 * `trustDescriptorKeys: true`, which is trust-on-first-use and is reported as
 * such, so nobody gets TOFU by accident.
 */
import { verifySth, type SignedTreeHead } from "./sth.js";
import { verifyInclusion, verifyConsistency } from "./merkle.js";
import { hexToBytes, type FetchLike } from "./util.js";
import {
  validateLogKeyDirectory,
  type LogKeyDirectory,
  type LogKeyEntry,
} from "./keydir.js";

export const LOG_DESCRIPTOR_PATH = "/.well-known/twzrd-log";
export const DEFAULT_ENDPOINTS = {
  sth: "/v1/log/sth",
  inclusion: "/v1/log/proof/inclusion",
  consistency: "/v1/log/proof/consistency",
  anchors: "/v1/log/anchors",
} as const;

export interface LogDescriptor {
  version: number;
  log_id: string;
  /** v0.2 key directory. */
  keys?: LogKeyEntry[];
  /** v0.1 single-key form, still accepted. */
  sth_pubkey?: string;
  anchor_authority?: string;
  anchor_memo_prefix?: string;
  anchor_cadence_seconds?: number;
  endpoints?: Partial<Record<keyof typeof DEFAULT_ENDPOINTS, string>>;
}

export interface InclusionProofResponse {
  leaf_index: number;
  tree_size: number;
  audit_path: string[];
  sth?: SignedTreeHead;
}

/**
 * The `log_inclusion` block a paid response carries once its leaf is merged:
 * the proof plus the signed head it targets, so a buyer verifies offline.
 * Served alongside `twzrd_receipt`; `anchor` is null until the head is anchored.
 */
export interface LogInclusionBlock extends InclusionProofResponse {
  log_id?: string;
  leaf?: string;
  sth: SignedTreeHead;
  anchor?: { cluster?: string; tx_signature: string; slot?: number } | null;
  verify?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

function endpoint(descriptor: LogDescriptor | undefined, name: keyof typeof DEFAULT_ENDPOINTS): string {
  const custom = descriptor?.endpoints?.[name];
  return typeof custom === "string" && custom.length > 0 ? custom : DEFAULT_ENDPOINTS[name];
}

export async function fetchLogDescriptor(
  baseUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<LogDescriptor> {
  const doc = (await getJson(joinUrl(baseUrl, LOG_DESCRIPTOR_PATH), fetchImpl)) as LogDescriptor;
  if (!doc || typeof doc !== "object") throw new Error("log descriptor is not an object");
  if (typeof doc.log_id !== "string" || doc.log_id.length === 0) {
    throw new Error("log descriptor has no log_id");
  }
  return doc;
}

/** Build a pinnable key directory out of a descriptor's advertised keys. */
export function keyDirectoryFromDescriptor(descriptor: LogDescriptor): LogKeyDirectory {
  if (!Array.isArray(descriptor.keys) || descriptor.keys.length === 0) {
    throw new Error(
      "descriptor advertises no key directory (v0.1 descriptors carry only sth_pubkey)",
    );
  }
  const dir: LogKeyDirectory = {
    version: Number(descriptor.version) || 1,
    log_id: String(descriptor.log_id),
    keys: descriptor.keys,
  };
  const errors = validateLogKeyDirectory(dir);
  if (errors.length > 0) {
    throw new Error(`descriptor key directory is invalid: ${errors.join("; ")}`);
  }
  return dir;
}

export interface TrustResolution {
  trusted: string | LogKeyDirectory;
  /** true when the keys came from the server's own descriptor (trust-on-first-use). */
  tofu: boolean;
}

/**
 * Decide which keys to verify against. A caller-supplied pin always wins; the
 * descriptor is only consulted when the caller explicitly opts into TOFU.
 */
export function resolveTrust(opts: {
  trusted?: string | LogKeyDirectory;
  descriptor?: LogDescriptor;
  trustDescriptorKeys?: boolean;
}): TrustResolution {
  if (opts.trusted !== undefined) return { trusted: opts.trusted, tofu: false };
  if (!opts.trustDescriptorKeys) {
    throw new Error(
      "no pinned key: pass `trusted` (a base58 key or a pinned key directory), or set " +
        "`trustDescriptorKeys: true` to accept the keys the log advertises about itself (TOFU)",
    );
  }
  const descriptor = opts.descriptor;
  if (!descriptor) throw new Error("trustDescriptorKeys was set but no descriptor was fetched");
  if (Array.isArray(descriptor.keys) && descriptor.keys.length > 0) {
    return { trusted: keyDirectoryFromDescriptor(descriptor), tofu: true };
  }
  if (typeof descriptor.sth_pubkey === "string" && descriptor.sth_pubkey.length > 0) {
    return { trusted: descriptor.sth_pubkey, tofu: true };
  }
  throw new Error("descriptor advertises neither `keys` nor `sth_pubkey`");
}

export async function fetchSth(
  baseUrl: string,
  opts: { descriptor?: LogDescriptor; fetchImpl?: FetchLike } = {},
): Promise<SignedTreeHead> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const doc = await getJson(joinUrl(baseUrl, endpoint(opts.descriptor, "sth")), fetchImpl);
  return doc as SignedTreeHead;
}

export async function fetchInclusionProof(
  baseUrl: string,
  leafHex: string,
  opts: { descriptor?: LogDescriptor; fetchImpl?: FetchLike } = {},
): Promise<InclusionProofResponse> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const leaf = String(leafHex).toLowerCase().replace(/^0x/, "");
  const url = `${joinUrl(baseUrl, endpoint(opts.descriptor, "inclusion"))}?leaf=${encodeURIComponent(leaf)}`;
  return (await getJson(url, fetchImpl)) as InclusionProofResponse;
}

export async function fetchConsistencyProof(
  baseUrl: string,
  oldSize: number,
  newSize: number,
  opts: { descriptor?: LogDescriptor; fetchImpl?: FetchLike } = {},
): Promise<string[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = joinUrl(baseUrl, endpoint(opts.descriptor, "consistency"));
  const url = `${base}?old_size=${encodeURIComponent(String(oldSize))}&new_size=${encodeURIComponent(String(newSize))}`;
  const doc = (await getJson(url, fetchImpl)) as { path?: unknown } | unknown[];
  const path = Array.isArray(doc) ? doc : (doc as { path?: unknown }).path;
  if (!Array.isArray(path)) throw new Error("consistency response has no `path` array");
  return path.map(String);
}

/** Pull the 32-byte hex leaf out of a receipt, or an API response wrapping one. */
export function extractReceiptLeaf(receiptDoc: unknown): string {
  let doc = receiptDoc as Record<string, unknown>;
  if (
    doc &&
    typeof doc === "object" &&
    !doc.leaf &&
    typeof doc.twzrd_receipt === "object" &&
    doc.twzrd_receipt
  ) {
    doc = doc.twzrd_receipt as Record<string, unknown>;
  }
  const leaf = String(doc?.leaf || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(leaf)) {
    throw new Error("receipt has no 64-hex-char .leaf field (is this a keccak-leaf receipt?)");
  }
  return leaf;
}

export interface ReceiptInLogResult {
  valid: boolean;
  errors: string[];
  leaf: string;
  tofu: boolean;
  sth_valid: boolean;
  inclusion_valid: boolean;
  key_id?: string;
  leaf_index?: number;
  tree_size?: number;
  sth?: SignedTreeHead;
}

/**
 * End-to-end: is this receipt in the log, under a head the pinned key signed?
 *
 * A `false` here is not automatically misbehavior — a receipt served within the
 * merge-delay SLA is legitimately not in the tree yet (the endpoint 404s). The
 * `errors` say which case it is.
 */
export async function verifyReceiptInLog(opts: {
  baseUrl: string;
  leaf?: string;
  receipt?: unknown;
  trusted?: string | LogKeyDirectory;
  trustDescriptorKeys?: boolean;
  descriptor?: LogDescriptor;
  fetchImpl?: FetchLike;
}): Promise<ReceiptInLogResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const leaf =
    opts.leaf !== undefined
      ? String(opts.leaf).toLowerCase().replace(/^0x/, "")
      : extractReceiptLeaf(opts.receipt);

  const out: ReceiptInLogResult = {
    valid: false,
    errors: [],
    leaf,
    tofu: false,
    sth_valid: false,
    inclusion_valid: false,
  };
  if (!/^[0-9a-f]{64}$/.test(leaf)) {
    out.errors.push("leaf must be 64 hex chars");
    return out;
  }

  let descriptor = opts.descriptor;
  if (!descriptor) {
    try {
      descriptor = await fetchLogDescriptor(opts.baseUrl, fetchImpl);
    } catch (e) {
      // A descriptor is optional when the caller pinned keys and the endpoints
      // are at their default paths.
      if (opts.trusted === undefined) {
        out.errors.push(`descriptor: ${(e as Error).message}`);
        return out;
      }
    }
  }

  let trust: TrustResolution;
  try {
    trust = resolveTrust({ ...opts, descriptor });
  } catch (e) {
    out.errors.push((e as Error).message);
    return out;
  }
  out.tofu = trust.tofu;

  let proof: InclusionProofResponse;
  try {
    proof = await fetchInclusionProof(opts.baseUrl, leaf, { descriptor, fetchImpl });
  } catch (e) {
    out.errors.push(`inclusion proof: ${(e as Error).message}`);
    return out;
  }

  let sth = proof.sth;
  if (!sth) {
    try {
      sth = await fetchSth(opts.baseUrl, { descriptor, fetchImpl });
    } catch (e) {
      out.errors.push(`sth: ${(e as Error).message}`);
      return out;
    }
  }
  // Same check a buyer runs on the block a paid response carries: one code path.
  return { ...verifyLogInclusion({ ...proof, sth }, trust.trusted, { leaf }), tofu: trust.tofu };
}

function normLeaf(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/^0x/, "");
}

/**
 * Offline: verify the `log_inclusion` block a paid response already carries —
 * no round-trip to the log, nothing to trust but the pinned key. `doc` may be
 * the whole paid response (`{ twzrd_receipt, log_inclusion }`), a bare block,
 * or a bare proof with `opts.leaf`. Every leaf named — the receipt's, the
 * block's, the caller's — must agree: a proof for some other leaf, attached to
 * your receipt, proves nothing about it. Same result shape as
 * `verifyReceiptInLog`, minus the fetch.
 */
export function verifyLogInclusion(
  doc: unknown,
  trusted: string | LogKeyDirectory,
  opts: { leaf?: string } = {},
): ReceiptInLogResult {
  const top = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const inner = top.log_inclusion;
  const block = (inner && typeof inner === "object" ? inner : top) as Partial<LogInclusionBlock>;
  const receipt = top.twzrd_receipt as Record<string, unknown> | undefined;
  const named = [
    opts.leaf !== undefined ? normLeaf(opts.leaf) : undefined,
    receipt && typeof receipt === "object" && receipt.leaf ? normLeaf(receipt.leaf) : undefined,
    block.leaf ? normLeaf(block.leaf) : undefined,
  ].filter((l): l is string => l !== undefined);
  const distinct = [...new Set(named)];
  const out: ReceiptInLogResult = {
    valid: false,
    errors: [],
    leaf: distinct[0] ?? "",
    tofu: false,
    sth_valid: false,
    inclusion_valid: false,
  };
  if (distinct.length === 0) {
    out.errors.push("no leaf: pass opts.leaf or a document that names one (twzrd_receipt.leaf / log_inclusion.leaf)");
    return out;
  }
  if (distinct.length > 1) {
    out.errors.push(`leaf mismatch: ${distinct.map((l) => `0x${l}`).join(" != ")} — this proof is for a different leaf`);
    return out;
  }
  const leaf = distinct[0];
  if (!/^[0-9a-f]{64}$/.test(leaf)) {
    out.errors.push("leaf must be 64 hex chars");
    return out;
  }
  const sth = block.sth;
  if (!sth || typeof sth !== "object") {
    out.errors.push("no sth: the block must carry the signed head its proof targets");
    return out;
  }
  out.sth = sth;
  out.leaf_index = Number(block.leaf_index);
  out.tree_size = Number(block.tree_size ?? sth.tree_size);
  if (!Number.isInteger(out.leaf_index) || out.leaf_index < 0) {
    out.errors.push("leaf_index must be a non-negative integer");
    return out;
  }

  const sthRes = verifySth(sth, trusted);
  out.sth_valid = sthRes.valid;
  out.key_id = sthRes.key_id;
  if (!sthRes.valid) out.errors.push(...sthRes.errors.map((e) => `sth: ${e}`));

  // The proof must target the head we just authenticated, or it proves nothing.
  if (out.tree_size !== Number(sth.tree_size)) {
    out.errors.push(
      `proof targets tree_size ${out.tree_size} but the signed head is at ${sth.tree_size}`,
    );
    return out;
  }

  try {
    out.inclusion_valid = verifyInclusion(
      hexToBytes(leaf),
      out.leaf_index,
      out.tree_size,
      (block.audit_path || []).map((h) => hexToBytes(String(h))),
      hexToBytes(String(sth.root)),
    );
  } catch (e) {
    out.errors.push(`audit path: ${(e as Error).message}`);
    return out;
  }
  if (!out.inclusion_valid) out.errors.push("inclusion proof does not verify against the signed root");

  out.valid = out.sth_valid && out.inclusion_valid && out.errors.length === 0;
  return out;
}

/** Fetch + verify a consistency proof between two heads of one log. */
export async function verifyHeadsConsistent(
  baseUrl: string,
  older: SignedTreeHead,
  newer: SignedTreeHead,
  opts: { descriptor?: LogDescriptor; fetchImpl?: FetchLike } = {},
): Promise<{ consistent: boolean; path: string[] }> {
  const path = await fetchConsistencyProof(
    baseUrl,
    Number(older.tree_size),
    Number(newer.tree_size),
    opts,
  );
  const consistent = verifyConsistency(
    Number(older.tree_size),
    hexToBytes(String(older.root)),
    Number(newer.tree_size),
    hexToBytes(String(newer.root)),
    path.map((h) => hexToBytes(String(h))),
  );
  return { consistent, path };
}
