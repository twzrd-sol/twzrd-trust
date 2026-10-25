/*
 * Solana anchor verification: a Signed Tree Head is anchored by a successful
 * mainnet transaction that commits to (log_id, tree_size, root) and is signed
 * by the published anchor authority.
 *
 * The live log anchors through the evidence-ledger program: one
 * `anchor_head` instruction carrying (tree_size, timestamp_unix, root,
 * log_id), which the program accepts only from the ledger's authority and
 * only after the runtime's ed25519 precompile has checked the head's
 * signature in the same transaction. The SPL Memo form
 * (`twzrd-log-anchor:v1:...`) of the v0.2 spec draft is still accepted.
 *
 * The RPC endpoint is only a data source — the binding is checked locally
 * and the authority must appear among the transaction's signers, so a
 * malicious RPC can hide an anchor but cannot forge one.
 */
import { verifySth, type SignedTreeHead } from "./sth.js";
import { hexToBytes, bytesToHex, b58decode, type FetchLike } from "./util.js";
import { HASH_LEN } from "./merkle.js";
import type { LogKeyDirectory } from "./keydir.js";

export const ANCHOR_MEMO_PREFIX = "twzrd-log-anchor:v1:";
export const MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", // Memo v1
]);
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
/** The evidence-ledger program the live log anchors through (`anchor_program_id`). */
export const EVIDENCE_LEDGER_PROGRAM_ID = "BzBAYJxUtJp6mUkJPjEYjd8vdb2FUGnAfB5X9LqrQ72W";
/** sha256("global:anchor_head")[0..8], the program's instruction discriminator. */
export const ANCHOR_HEAD_DISCRIMINATOR = Uint8Array.of(0x6d, 0xab, 0x20, 0x3d, 0xc5, 0x98, 0xeb, 0x71);
const MAX_LOG_ID = 64;

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

export interface AnchorHeadPayload extends AnchorPayload {
  timestamp_unix: number;
}

function u64At(view: DataView, offset: number): number | null {
  const v = view.getBigUint64(offset, true);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/**
 * Decode `anchor_head` instruction data: the discriminator, then
 * `[tree_size u64 LE][timestamp_unix u64 LE][root 32][log_id_len u8][log_id UTF-8]`.
 * Returns null for anything that is not exactly that (trailing bytes included).
 */
export function parseAnchorHeadData(data: Uint8Array): AnchorHeadPayload | null {
  if (data.length < 58) return null;
  if (ANCHOR_HEAD_DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const treeSize = u64At(view, 8);
  const timestamp = u64At(view, 16);
  const len = data[56];
  if (!treeSize || timestamp === null || len === 0 || len > MAX_LOG_ID || data.length !== 57 + len) return null;
  let logId: string;
  try {
    logId = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(57));
  } catch {
    return null;
  }
  return { log_id: logId, tree_size: treeSize, timestamp_unix: timestamp, root: bytesToHex(data.subarray(24, 56)) };
}

export function formatAnchorMemo(payload: AnchorPayload): string {
  const root = hexToBytes(payload.root);
  if (root.length !== HASH_LEN) throw new Error("anchor root must be 32 bytes");
  return `${ANCHOR_MEMO_PREFIX}${payload.log_id}:${payload.tree_size}:${bytesToHex(root)}`;
}

/** Field mismatches between an anchor and a head; `timestamp_unix` is compared when the anchor carries it. */
export function anchorMatchesSth(payload: AnchorPayload | AnchorHeadPayload, sth: SignedTreeHead): string[] {
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
  if ("timestamp_unix" in payload && payload.timestamp_unix !== Number(sth.timestamp_unix)) {
    errors.push(`anchor timestamp_unix ${payload.timestamp_unix} != STH timestamp_unix ${sth.timestamp_unix}`);
  }
  return errors;
}

export interface FetchedAnchorHead {
  program_id: string;
  /** [authority, payer, ledger, root entry, system program, instructions sysvar] */
  accounts: string[];
  payload: AnchorHeadPayload;
}

export interface FetchedAnchorTx {
  memos: string[];
  anchorHeads: FetchedAnchorHead[];
  signers: string[];
  /** false when the transaction failed (`meta.err` set) or carried no status: it anchored nothing. */
  succeeded: boolean;
  slot: number | null;
  blockTime: number | null;
}

/** Fetch a transaction over plain JSON-RPC and extract memos, anchor_head instructions and signers. */
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
      meta?: { err?: unknown } | null;
      transaction?: {
        message?: {
          accountKeys?: Array<{ pubkey?: string; signer?: boolean }>;
          instructions?: Array<{
            program?: string;
            programId?: string;
            parsed?: unknown;
            accounts?: unknown[];
            data?: unknown;
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
  const anchorHeads: FetchedAnchorHead[] = [];
  for (const ix of msg.instructions || []) {
    const isMemo = ix.program === "spl-memo" || MEMO_PROGRAM_IDS.has(String(ix.programId || ""));
    if (isMemo && typeof ix.parsed === "string") memos.push(ix.parsed);
    if (typeof ix.data !== "string") continue;
    let payload: AnchorHeadPayload | null = null;
    try {
      payload = parseAnchorHeadData(b58decode(ix.data));
    } catch {
      continue; // not base58: some other program's data
    }
    if (payload) {
      const accounts = (ix.accounts || []).filter((a): a is string => typeof a === "string");
      anchorHeads.push({ program_id: String(ix.programId || ""), accounts, payload });
    }
  }
  const meta = body.result.meta;
  return {
    memos,
    anchorHeads,
    signers,
    succeeded: meta !== undefined && meta !== null && meta.err === null,
    slot: typeof body.result.slot === "number" ? body.result.slot : null,
    blockTime: typeof body.result.blockTime === "number" ? body.result.blockTime : null,
  };
}

export interface AnchorVerifyResult {
  valid: boolean;
  errors: string[];
  sth_valid: boolean;
  /** Which binding matched the head: the program's anchor_head instruction, or a memo. */
  anchor_kind: "anchor_head" | "memo" | null;
  anchor_head_found: boolean;
  memo_found: boolean;
  tx_succeeded: boolean;
  authority_signed: boolean;
  slot: number | null;
  block_time: number | null;
}

/**
 * Full anchor check: STH signature, a successful transaction, a binding to
 * this head (an `anchor_head` instruction of the pinned program whose
 * authority account is the pinned authority, or an anchor memo), and the
 * authority among the signers. A valid result proves the STH's
 * (log_id, tree_size, root) existed on Solana no later than `block_time`,
 * published by the pinned anchor authority.
 */
export async function verifyAnchor(opts: {
  sth: SignedTreeHead;
  txSignature: string;
  /** Pinned key, or a pinned key directory when heads carry `key_id`. */
  sthPubkey: string | LogKeyDirectory;
  anchorAuthority: string;
  /** The program an anchor_head must belong to (default: the evidence-ledger program). */
  anchorProgramId?: string;
  /** Optional ledger account pin (`anchor_ledger_pda`); checked against the instruction's ledger account. */
  ledger?: string;
  rpcUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<AnchorVerifyResult> {
  const out: AnchorVerifyResult = {
    valid: false,
    errors: [],
    sth_valid: false,
    anchor_kind: null,
    anchor_head_found: false,
    memo_found: false,
    tx_succeeded: false,
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
  out.tx_succeeded = tx.succeeded;
  if (!tx.succeeded) out.errors.push("transaction failed or has no status, so it anchored nothing");

  const program = opts.anchorProgramId ?? EVIDENCE_LEDGER_PROGRAM_ID;
  const heads = tx.anchorHeads.filter((h) => h.program_id === program);
  for (const h of heads) {
    const mismatches = anchorMatchesSth(h.payload, opts.sth);
    if (h.accounts[0] !== opts.anchorAuthority) {
      mismatches.push(`anchor_head authority ${h.accounts[0]} != pinned authority ${opts.anchorAuthority}`);
    }
    if (opts.ledger !== undefined && h.accounts[2] !== opts.ledger) {
      mismatches.push(`anchor_head ledger ${h.accounts[2]} != pinned ledger ${opts.ledger}`);
    }
    if (mismatches.length === 0) {
      out.anchor_head_found = true;
      break;
    }
    out.errors.push(...mismatches);
  }
  if (!out.anchor_head_found) {
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
  }
  out.anchor_kind = out.anchor_head_found ? "anchor_head" : out.memo_found ? "memo" : null;
  if (out.anchor_kind === null && heads.length === 0 && tx.memos.length === 0) {
    out.errors.push(`transaction contains no anchor_head instruction of ${program} and no memo instruction`);
  } else if (out.anchor_kind === null) {
    out.errors.push("no anchor_head instruction or memo in the transaction matches this STH");
  }

  out.authority_signed = tx.signers.includes(opts.anchorAuthority);
  if (!out.authority_signed) {
    out.errors.push(
      `anchor authority ${opts.anchorAuthority} is not a signer of the transaction (signers: ${tx.signers.join(", ") || "none"})`,
    );
  }

  out.valid = out.sth_valid && out.tx_succeeded && out.anchor_kind !== null && out.authority_signed;
  return out;
}
