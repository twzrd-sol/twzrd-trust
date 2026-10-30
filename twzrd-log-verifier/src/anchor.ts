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
 * Trust model. The transaction is fetched as raw bytes and these facts are
 * checked here, from the bytes, so the RPC cannot forge them:
 *   - the bytes are the transaction asked for (first signature == txSignature);
 *   - every required signature verifies (Ed25519 over the message), so the
 *     anchor authority really signed this message;
 *   - the head binding, parsed from the raw instruction data and static
 *     account keys.
 * These facts are taken on the RPC's word, because transaction bytes cannot
 * establish them: that the transaction is in the finalized chain, that it
 * succeeded (`meta.err`), its slot and its block time. A malicious RPC can
 * hide an anchor, report a failed or never-landed transaction as landed, or
 * misstate its time; it cannot produce an authority signature or a binding
 * the authority never signed. Use an RPC you trust, or compare several.
 */
import nacl from "tweetnacl";
import { verifySth, type SignedTreeHead } from "./sth.js";
import {
  hexToBytes,
  bytesToHex,
  b58decode,
  b58encode,
  PUBKEY_LEN,
  SIGNATURE_LEN,
  type FetchLike,
} from "./util.js";
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

// --- raw transaction parsing -------------------------------------------------

/** Solana's compact-u16 length prefix (1 to 3 bytes, 7 bits each, little-endian). */
function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated transaction (compact-u16)");
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 14) throw new Error("malformed transaction (compact-u16 longer than 3 bytes)");
  }
  return [value, pos];
}

function need(buf: Uint8Array, pos: number, n: number, what: string): void {
  if (pos + n > buf.length) throw new Error(`truncated transaction (${what})`);
}

/** One instruction of a parsed transaction, with program and accounts resolved to base58 keys. */
export interface RawInstruction {
  program_id: string;
  accounts: string[];
  data: Uint8Array;
}

/** A serialized Solana transaction, parsed here from its bytes. */
export interface ParsedTransaction {
  /** `"legacy"`, or the version number of a versioned message (0 today). */
  version: "legacy" | number;
  signatures: Uint8Array[];
  /** The signed message bytes (everything after the signatures). */
  message: Uint8Array;
  num_required_signatures: number;
  /** The message's static account keys, base58. The first `num_required_signatures` are the signers. */
  static_keys: string[];
  instructions: RawInstruction[];
}

/**
 * Parse a serialized transaction (legacy or versioned message). Address-table
 * lookups of a versioned message are not resolved: anchors use static keys
 * only, so an instruction that references a looked-up account throws.
 * Nothing is verified here; see `verifyTransactionSignatures`.
 */
export function parseRawTransaction(raw: Uint8Array): ParsedTransaction {
  let pos: number;
  let nsig: number;
  [nsig, pos] = readCompactU16(raw, 0);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < nsig; i++) {
    need(raw, pos, SIGNATURE_LEN, `signature ${i}`);
    signatures.push(raw.subarray(pos, pos + SIGNATURE_LEN));
    pos += SIGNATURE_LEN;
  }
  const message = raw.subarray(pos);
  let m = 0;
  need(message, m, 1, "message prefix");
  let version: "legacy" | number = "legacy";
  if ((message[0] & 0x80) !== 0) {
    version = message[0] & 0x7f;
    m = 1;
  }
  need(message, m, 3, "message header");
  const numRequired = message[m];
  m += 3;
  let nkeys: number;
  [nkeys, m] = readCompactU16(message, m);
  const staticKeys: string[] = [];
  for (let i = 0; i < nkeys; i++) {
    need(message, m, PUBKEY_LEN, `account key ${i}`);
    staticKeys.push(b58encode(message.subarray(m, m + PUBKEY_LEN)));
    m += PUBKEY_LEN;
  }
  need(message, m, HASH_LEN, "recent blockhash");
  m += HASH_LEN;
  let nix: number;
  [nix, m] = readCompactU16(message, m);
  const keyAt = (idx: number, what: string): string => {
    if (idx >= staticKeys.length) {
      throw new Error(
        `${what} references account index ${idx} beyond the ${staticKeys.length} static keys (address-table lookups are not supported for anchors)`,
      );
    }
    return staticKeys[idx];
  };
  const instructions: RawInstruction[] = [];
  for (let i = 0; i < nix; i++) {
    need(message, m, 1, `instruction ${i} program index`);
    const programIdx = message[m++];
    let nacc: number;
    [nacc, m] = readCompactU16(message, m);
    need(message, m, nacc, `instruction ${i} accounts`);
    const accounts: string[] = [];
    for (let j = 0; j < nacc; j++) accounts.push(keyAt(message[m + j], `instruction ${i}`));
    m += nacc;
    let dlen: number;
    [dlen, m] = readCompactU16(message, m);
    need(message, m, dlen, `instruction ${i} data`);
    instructions.push({
      program_id: keyAt(programIdx, `instruction ${i} program`),
      accounts,
      data: message.subarray(m, m + dlen),
    });
    m += dlen;
  }
  if (nsig !== numRequired) {
    throw new Error(`transaction carries ${nsig} signatures but its header requires ${numRequired}`);
  }
  if (numRequired > staticKeys.length) {
    throw new Error(`transaction header requires ${numRequired} signers but has ${staticKeys.length} account keys`);
  }
  return { version, signatures, message, num_required_signatures: numRequired, static_keys: staticKeys, instructions };
}

/**
 * Verify every required signature of a parsed transaction (Ed25519 over the
 * message bytes, signer i = static key i). Returns the signers, base58, in
 * order; throws on the first signature that does not verify, since no such
 * transaction can exist on chain and an RPC that returns one is lying.
 */
export function verifyTransactionSignatures(tx: ParsedTransaction): string[] {
  const signers: string[] = [];
  for (let i = 0; i < tx.num_required_signatures; i++) {
    const key = tx.static_keys[i];
    if (!nacl.sign.detached.verify(tx.message, tx.signatures[i], b58decode(key))) {
      throw new Error(`signature ${i} does not verify for account ${key}: not a transaction Solana could have accepted`);
    }
    signers.push(key);
  }
  return signers;
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
  /** Accounts whose Ed25519 signature over the message verified here, from the bytes. */
  signers: string[];
  /** false when the transaction failed (`meta.err` set) or carried no status: it anchored nothing. RPC-reported. */
  succeeded: boolean;
  /** RPC-reported. */
  slot: number | null;
  /** RPC-reported. */
  blockTime: number | null;
  version: "legacy" | number;
}

/**
 * Fetch a transaction over plain JSON-RPC as raw bytes, check that the bytes
 * are the transaction asked for (its first signature is `txSignature`),
 * verify every required signature, and extract memos, anchor_head
 * instructions and signers from the bytes. Only `succeeded`, `slot` and
 * `blockTime` come from the RPC's word.
 */
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
      params: [txSignature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "finalized" }],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = (await res.json()) as {
    error?: { message?: string };
    result?: {
      slot?: number;
      blockTime?: number;
      meta?: { err?: unknown } | null;
      transaction?: unknown;
    } | null;
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message || "unknown"}`);
  if (!body.result) throw new Error("transaction not found (or RPC pruned it)");

  const enc = body.result.transaction;
  if (!Array.isArray(enc) || typeof enc[0] !== "string" || enc[1] !== "base64") {
    throw new Error("RPC did not return the transaction as base64 bytes");
  }
  const raw = new Uint8Array(Buffer.from(enc[0], "base64"));
  const tx = parseRawTransaction(raw);
  if (tx.signatures.length === 0) throw new Error("transaction carries no signatures");
  const identity = b58encode(tx.signatures[0]);
  if (identity !== txSignature) {
    throw new Error(`RPC returned transaction ${identity}, not the requested ${txSignature}`);
  }
  const signers = verifyTransactionSignatures(tx);

  const memos: string[] = [];
  const anchorHeads: FetchedAnchorHead[] = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (const ix of tx.instructions) {
    if (MEMO_PROGRAM_IDS.has(ix.program_id)) {
      try {
        memos.push(utf8.decode(ix.data));
      } catch {
        // not UTF-8: not an anchor memo
      }
      continue;
    }
    const payload = parseAnchorHeadData(ix.data);
    if (payload) anchorHeads.push({ program_id: ix.program_id, accounts: ix.accounts, payload });
  }
  const meta = body.result.meta;
  return {
    memos,
    anchorHeads,
    signers,
    succeeded: meta !== undefined && meta !== null && meta.err === null,
    slot: typeof body.result.slot === "number" ? body.result.slot : null,
    blockTime: typeof body.result.blockTime === "number" ? body.result.blockTime : null,
    version: tx.version,
  };
}

/** Facts `verifyAnchor` establishes from the STH and the transaction bytes, with no trust in the RPC. */
export type AnchorLocalFact = "sth_signature" | "transaction_identity" | "authority_signature" | "head_binding";
/** Facts `verifyAnchor` can only take as the RPC reports them. */
export type AnchorRpcFact = "inclusion" | "success" | "slot" | "block_time";
export const ANCHOR_RPC_REPORTED_FACTS: readonly AnchorRpcFact[] = ["inclusion", "success", "slot", "block_time"];

export interface AnchorVerifyResult {
  valid: boolean;
  errors: string[];
  sth_valid: boolean;
  /** Which binding matched the head: the program's anchor_head instruction, or a memo. */
  anchor_kind: "anchor_head" | "memo" | null;
  anchor_head_found: boolean;
  memo_found: boolean;
  /** RPC-reported (`meta.err`). */
  tx_succeeded: boolean;
  /** The authority's Ed25519 signature over this transaction's message verified from the bytes. */
  authority_signed: boolean;
  /** RPC-reported. */
  slot: number | null;
  /** RPC-reported. */
  block_time: number | null;
  /** The RPC the transaction was read from. */
  rpc_url: string;
  /** What was checked here, from the bytes. Each entry is present only when that check passed. */
  verified_locally: AnchorLocalFact[];
  /** What rests on `rpc_url`'s word. Empty when nothing was fetched. */
  rpc_reported: AnchorRpcFact[];
}

/**
 * Full anchor check: STH signature, a successful transaction, a binding to
 * this head (an `anchor_head` instruction of the pinned program whose
 * authority account is the pinned authority, or an anchor memo), and the
 * authority's verified signature on the transaction.
 *
 * A valid result establishes from the bytes that the pinned anchor authority
 * signed a transaction binding this STH's (log_id, tree_size, root). That the
 * transaction is in the finalized chain, succeeded, and landed at `slot` /
 * `block_time` is as reported by `rpc_url`; the "no later than block_time"
 * bound is only as good as that RPC.
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
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;
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
    rpc_url: rpcUrl,
    verified_locally: [],
    rpc_reported: [],
  };

  const sthRes = verifySth(opts.sth, opts.sthPubkey);
  out.sth_valid = sthRes.valid;
  if (sthRes.valid) out.verified_locally.push("sth_signature");
  else out.errors.push(...sthRes.errors.map((e) => `sth: ${e}`));

  let tx: FetchedAnchorTx;
  try {
    tx = await fetchAnchorTransaction(opts.txSignature, rpcUrl, opts.fetchImpl);
  } catch (e) {
    out.errors.push(`transaction: ${(e as Error).message}`);
    return out;
  }
  out.verified_locally.push("transaction_identity");
  out.rpc_reported.push(...ANCHOR_RPC_REPORTED_FACTS);
  out.slot = tx.slot;
  out.block_time = tx.blockTime;
  out.tx_succeeded = tx.succeeded;
  if (!tx.succeeded) out.errors.push("transaction failed or has no status (as reported by the RPC), so it anchored nothing");

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
  if (out.anchor_kind !== null) out.verified_locally.push("head_binding");
  if (out.anchor_kind === null && heads.length === 0 && tx.memos.length === 0) {
    out.errors.push(`transaction contains no anchor_head instruction of ${program} and no memo instruction`);
  } else if (out.anchor_kind === null) {
    out.errors.push("no anchor_head instruction or memo in the transaction matches this STH");
  }

  out.authority_signed = tx.signers.includes(opts.anchorAuthority);
  if (out.authority_signed) out.verified_locally.push("authority_signature");
  else {
    out.errors.push(
      `anchor authority ${opts.anchorAuthority} did not sign the transaction (verified signers: ${tx.signers.join(", ") || "none"})`,
    );
  }

  out.valid = out.sth_valid && out.tx_succeeded && out.anchor_kind !== null && out.authority_signed;
  return out;
}
