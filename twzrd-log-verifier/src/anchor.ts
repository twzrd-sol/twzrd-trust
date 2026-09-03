/*
 * Solana anchor verification: a Signed Tree Head is anchored by a mainnet
 * transaction whose SPL Memo payload commits to (log_id, tree_size, root)
 * and which is signed by the published anchor authority.
 *
 * The RPC endpoint is only a data source — the memo binding is checked
 * locally and the authority must appear among the transaction's signers, so
 * a malicious RPC can hide an anchor but cannot forge one.
 */
import { verifySth, type SignedTreeHead } from "./sth.js";
import { hexToBytes, bytesToHex, type FetchLike } from "./util.js";
import { HASH_LEN } from "./merkle.js";
import type { LogKeyDirectory } from "./keydir.js";

export const ANCHOR_MEMO_PREFIX = "twzrd-log-anchor:v1:";
export const MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", // Memo v1
]);
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export interface AnchorPayload {
  log_id: string;
  tree_size: number;
  root: string; // lowercase hex, no 0x
}

/**
 * Parse `twzrd-log-anchor:v1:<log_id>:<tree_size>:<root_hex>`.
 * Parsed from the end so a log_id containing ':' cannot shift fields.
 * Returns null for anything that is not a well-formed anchor memo.
 */
export function parseAnchorMemo(memo: string): AnchorPayload | null {
  if (typeof memo !== "string" || !memo.startsWith(ANCHOR_MEMO_PREFIX)) return null;
  const rest = memo.slice(ANCHOR_MEMO_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const secondLastColon = rest.lastIndexOf(":", lastColon - 1);
  if (secondLastColon < 0) return null;
  const logId = rest.slice(0, secondLastColon);
  const sizeStr = rest.slice(secondLastColon + 1, lastColon);
  const rootHex = rest.slice(lastColon + 1).toLowerCase();
  if (logId.length === 0) return null;
  if (!/^[0-9]+$/.test(sizeStr)) return null;
  const treeSize = Number(sizeStr);
  if (!Number.isSafeInteger(treeSize)) return null;
  if (!/^[0-9a-f]{64}$/.test(rootHex)) return null;
  return { log_id: logId, tree_size: treeSize, root: rootHex };
}

export function formatAnchorMemo(payload: AnchorPayload): string {
  const root = hexToBytes(payload.root);
  if (root.length !== HASH_LEN) throw new Error("anchor root must be 32 bytes");
  return `${ANCHOR_MEMO_PREFIX}${payload.log_id}:${payload.tree_size}:${bytesToHex(root)}`;
}

export function anchorMatchesSth(payload: AnchorPayload, sth: SignedTreeHead): string[] {
  const errors: string[] = [];
  if (payload.log_id !== String(sth.log_id)) {
    errors.push(`anchor log_id ${JSON.stringify(payload.log_id)} != STH log_id ${JSON.stringify(String(sth.log_id))}`);
  }
  if (payload.tree_size !== Number(sth.tree_size)) {
    errors.push(`anchor tree_size ${payload.tree_size} != STH tree_size ${sth.tree_size}`);
  }
  const sthRoot = String(sth.root || "").toLowerCase().replace(/^0x/, "");
  if (payload.root !== sthRoot) {
    errors.push(`anchor root ${payload.root} != STH root ${sthRoot}`);
  }
  return errors;
}

export interface FetchedAnchorTx {
  memos: string[];
  signers: string[];
  slot: number | null;
  blockTime: number | null;
}

/** Fetch a transaction over plain JSON-RPC and extract memo payloads + signers. */
export async function fetchAnchorTransaction(
  txSignature: string,
  rpcUrl: string = DEFAULT_RPC_URL,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<FetchedAnchorTx> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        txSignature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as {
    error?: { message?: string };
    result?: {
      slot?: number;
      blockTime?: number;
      transaction?: {
        message?: {
          accountKeys?: Array<{ pubkey?: string; signer?: boolean }>;
          instructions?: Array<{
            program?: string;
            programId?: string;
            parsed?: unknown;
          }>;
        };
      };
    } | null;
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message || "unknown"}`);
  if (!body.result) throw new Error("transaction not found (or RPC pruned it)");

  const msg = body.result.transaction?.message || {};
  const signers = (msg.accountKeys || [])
    .filter((k) => k && k.signer === true && typeof k.pubkey === "string")
    .map((k) => k.pubkey as string);
  const memos: string[] = [];
  for (const ix of msg.instructions || []) {
    const isMemo = ix.program === "spl-memo" || MEMO_PROGRAM_IDS.has(String(ix.programId || ""));
    if (isMemo && typeof ix.parsed === "string") memos.push(ix.parsed);
  }
  return {
    memos,
    signers,
    slot: typeof body.result.slot === "number" ? body.result.slot : null,
    blockTime: typeof body.result.blockTime === "number" ? body.result.blockTime : null,
  };
}

export interface AnchorVerifyResult {
  valid: boolean;
  errors: string[];
  sth_valid: boolean;
  memo_found: boolean;
  authority_signed: boolean;
  slot: number | null;
  block_time: number | null;
}

/**
 * Full anchor check: STH signature, on-chain memo binding, authority signer.
 * A valid result proves the STH's (log_id, tree_size, root) existed on Solana
 * no later than `block_time`, published by the pinned anchor authority.
 */
export async function verifyAnchor(opts: {
  sth: SignedTreeHead;
  txSignature: string;
  /** Pinned key, or a pinned key directory when heads carry `key_id`. */
  sthPubkey: string | LogKeyDirectory;
  anchorAuthority: string;
  rpcUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<AnchorVerifyResult> {
  const out: AnchorVerifyResult = {
    valid: false,
    errors: [],
    sth_valid: false,
    memo_found: false,
    authority_signed: false,
    slot: null,
    block_time: null,
  };

  const sthRes = verifySth(opts.sth, opts.sthPubkey);
  out.sth_valid = sthRes.valid;
  if (!sthRes.valid) out.errors.push(...sthRes.errors.map((e) => `sth: ${e}`));

  let tx: FetchedAnchorTx;
  try {
    tx = await fetchAnchorTransaction(opts.txSignature, opts.rpcUrl, opts.fetchImpl);
  } catch (e) {
    out.errors.push(`fetch: ${(e as Error).message}`);
    return out;
  }
  out.slot = tx.slot;
  out.block_time = tx.blockTime;

  for (const memo of tx.memos) {
    const parsed = parseAnchorMemo(memo);
    if (!parsed) continue;
    const mismatches = anchorMatchesSth(parsed, opts.sth);
    if (mismatches.length === 0) {
      out.memo_found = true;
      break;
    }
    out.errors.push(...mismatches);
  }
  if (!out.memo_found && tx.memos.length === 0) {
    out.errors.push("transaction contains no memo instruction");
  } else if (!out.memo_found) {
    out.errors.push("no memo in the transaction matches this STH");
  }

  out.authority_signed = tx.signers.includes(opts.anchorAuthority);
  if (!out.authority_signed) {
    out.errors.push(
      `anchor authority ${opts.anchorAuthority} is not a signer of the transaction (signers: ${tx.signers.join(", ") || "none"})`,
    );
  }

  out.valid = out.sth_valid && out.memo_found && out.authority_signed;
  return out;
}
