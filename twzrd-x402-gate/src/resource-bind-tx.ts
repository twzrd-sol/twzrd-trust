/**
 * Memo + TransferChecked from one SVM wire tx. Hash-only evaluate stays
 * memo-inclusion. Legs-hard requires memo match AND mint/amount/dest-ATA.
 * Decodes presented bytes; does not prove the tx landed. Caller must confirm
 * inclusion (fetch by signature, err null) before treating hard as chain evidence.
 *
 * The legs check also holds the transaction to an instruction allowlist. A
 * bound transfer may carry, and nothing else:
 *   - ComputeBudget SetComputeUnitLimit and SetComputeUnitPrice, one of each,
 *     no accounts;
 *   - Memo instructions with no accounts and non-empty UTF-8 data: one bind
 *     memo (rb1: / rb2:) and one other memo (the x402 SVM client attaches one
 *     memo of its own to every transaction);
 *   - one Associated Token Account create or create-idempotent whose account
 *     is ATA(pay_to, asset) under the transfer's token program;
 *   - one SPL Token or Token-2022 TransferChecked with exactly four accounts.
 * Every other instruction, an instruction whose program or accounts are not in
 * the static account list, and a transaction with address lookup tables are
 * refused with BOUND_TX_INSTRUCTION_REFUSED + a fixed code. The first
 * violation in instruction order is the one reported. Fee size is not
 * bounded here: a compute unit price is accepted at any value.
 */
import {
  evaluateResourceBind, memoContainsResourceBind, pickBindMemo,
  RESOURCE_BIND_MEMO_PREFIX, RESOURCE_BIND_V2_MEMO_PREFIX,
  type ResourceBindDecision,
} from "./resource-bind.js";
import { isStrictBase64 } from "./strict-base64.js";

export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";

/** Prefix of every reason the instruction allowlist refuses with; a fixed code follows it. */
export const BOUND_TX_INSTRUCTION_REFUSED = "bound tx instruction refused: ";

export type ResourceBindAmountScheme = "exact" | "upto";

export type ResourceBindLeafFields = {
  leaf_hash: string;
  pay_to: string;
  asset: string;
  amount_raw: string;
  scheme?: string; // optional under Compat A
  payer?: string;
};

export function normalizeResourceBindScheme(
  scheme: unknown,
): ResourceBindAmountScheme | "unknown" | "missing" {
  if (scheme == null) return "missing";
  const s = String(scheme).trim().toLowerCase();
  if (s === "") return "missing";
  if (s === "exact" || s === "upto") return s;
  return "unknown";
}

export function transferAmountMatchesLeaf(
  trAmount: string,
  leaf: Pick<ResourceBindLeafFields, "amount_raw" | "scheme">,
): boolean {
  const scheme = normalizeResourceBindScheme(leaf.scheme);
  let paid: bigint, cap: bigint;
  try {
    paid = BigInt(trAmount);
    cap = BigInt(leaf.amount_raw);
  } catch {
    return false;
  }
  if (scheme === "upto") return paid <= cap; // includes 0
  if (scheme === "exact" || scheme === "missing") return paid === cap;
  return false; // unknown
}

export type SvmTransferLegs = {
  mint: string; dest: string; authority: string; amount: string; tokenProgram: string;
};

type Ix = { programAddressIndex?: number; accountIndices?: number[]; data?: Uint8Array | number[] | ArrayBuffer };

function asBytes(data: Ix["data"]): Uint8Array | null {
  if (!data) return null;
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
}

type AtaCreate = { ata: string; owner: string; mint: string; tokenProgram: string };

type Observed = {
  memos: string[];
  transfer: SvmTransferLegs | null;
  /** First allowlist violation in instruction order; null when there is none. */
  violation: string | null;
  /** The one ATA create the allowlist admitted, for the recipient check. */
  ataCreate: AtaCreate | null;
};

type Seen = { limit: boolean; price: boolean; bindMemo: boolean; plainMemo: boolean; ata: boolean; transfer: boolean };

function utf8(d: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(d);
  } catch {
    return null;
  }
}

/**
 * One instruction against the allowlist. Returns the violation code, or null
 * when a bound transfer may carry this instruction. `seen` counts what earlier
 * instructions already used up.
 */
function classify(
  program: string, memoProgram: string, d: Uint8Array, keys: string[], seen: Seen,
  admit: (ata: AtaCreate) => void,
): string | null {
  if (program === COMPUTE_BUDGET) {
    if (keys.length > 0) return "compute_budget_has_accounts";
    if (d[0] === 2 && d.byteLength === 5) {
      if (seen.limit) return "duplicate_compute_unit_limit";
      seen.limit = true;
      return null;
    }
    if (d[0] === 3 && d.byteLength === 9) {
      if (seen.price) return "duplicate_compute_unit_price";
      seen.price = true;
      return null;
    }
    return "compute_budget_instruction_not_allowed";
  }
  if (program === memoProgram) {
    if (keys.length > 0) return "memo_has_accounts";
    if (d.byteLength === 0) return "memo_empty";
    const text = utf8(d);
    if (text === null) return "memo_not_utf8";
    const bind = text.startsWith(RESOURCE_BIND_MEMO_PREFIX) || text.startsWith(RESOURCE_BIND_V2_MEMO_PREFIX);
    if (bind) {
      if (seen.bindMemo) return "duplicate_bind_memo";
      seen.bindMemo = true;
      return null;
    }
    if (seen.plainMemo) return "duplicate_memo";
    seen.plainMemo = true;
    return null;
  }
  if (program === ASSOCIATED_TOKEN) {
    // Empty data and [0] are Create, [1] is CreateIdempotent. RecoverNested ([2]) is not a create.
    const create = d.byteLength === 0 || (d.byteLength === 1 && (d[0] === 0 || d[0] === 1));
    if (!create) return "ata_instruction_not_allowed";
    // funder, ata, owner, mint, system program, token program
    if (keys.length !== 6 || keys[4] !== SYSTEM) return "ata_create_bad_accounts";
    if (seen.ata) return "duplicate_ata_create";
    seen.ata = true;
    admit({ ata: keys[1], owner: keys[2], mint: keys[3], tokenProgram: keys[5] });
    return null;
  }
  if (program === TOKEN || program === TOKEN22) {
    // TransferChecked: opcode 12, u64 amount, u8 decimals.
    if (d[0] !== 12 || d.byteLength !== 10) return "token_instruction_not_allowed";
    // source, mint, destination, authority. More accounts are multisig signers or transfer-hook accounts.
    if (keys.length !== 4) return "transfer_bad_accounts";
    if (seen.transfer) return "duplicate_transfer";
    seen.transfer = true;
    return null;
  }
  return `program_not_allowed:${program}`;
}

async function observe(transaction: string): Promise<Observed | null> {
  // The exact string the payload carries, canonical base64 only: no trim.
  const tx = transaction;
  if (typeof tx !== "string" || tx.length < 32 || !isStrictBase64(tx)) return null;
  try {
    const svm = await import("@x402/svm");
    const kit = await import("@solana/kit");
    const decoded = svm.decodeTransactionFromPayload({ transaction: tx });
    const compiled = kit.getCompiledTransactionMessageDecoder().decode(decoded.messageBytes as never) as {
      staticAccounts?: Array<{ toString(): string }>; instructions?: Ix[];
      addressTableLookups?: unknown[];
    };
    const accounts = (compiled.staticAccounts ?? []).map((a) => a.toString());
    const memoProgram = svm.MEMO_PROGRAM_ADDRESS ?? MEMO_PROGRAM_ADDRESS;
    const memos: string[] = [];
    let transfer: SvmTransferLegs | null = null;
    let ataCreate: AtaCreate | null = null;
    // Looked-up accounts are named by a table this check cannot read.
    let violation: string | null = compiled.addressTableLookups?.length ? "address_lookup_tables_not_allowed" : null;
    const seen: Seen = { limit: false, price: false, bindMemo: false, plainMemo: false, ata: false, transfer: false };
    for (const ix of compiled.instructions ?? []) {
      const program = ix.programAddressIndex == null ? undefined : accounts[ix.programAddressIndex];
      if (program === undefined) {
        violation ??= "instruction_program_unresolved";
        continue;
      }
      const d = asBytes(ix.data) ?? new Uint8Array(0);
      const keys = (ix.accountIndices ?? []).map((i) => accounts[i]);
      violation ??= keys.some((k) => k === undefined)
        ? "instruction_account_unresolved"
        : classify(program, memoProgram, d, keys, seen, (ata) => { ataCreate = ata; });
      if (program === memoProgram) {
        if (d.byteLength) memos.push(new TextDecoder().decode(d));
        continue;
      }
      if (transfer) continue;
      if ((program !== TOKEN && program !== TOKEN22) || d[0] !== 12 || d.byteLength < 10) continue;
      if (keys.length < 4) continue;
      const amount = new DataView(d.buffer, d.byteOffset + 1, 8).getBigUint64(0, true).toString();
      transfer = { mint: keys[1], dest: keys[2], authority: keys[3], amount, tokenProgram: program };
    }
    return { memos, transfer, violation, ataCreate };
  } catch { return null; }
}

export async function extractSvmMemoFromTransaction(transaction: string): Promise<string | null> {
  const o = await observe(transaction);
  if (!o?.memos.length) return null;
  return pickBindMemo(o.memos);
}

export async function extractSvmTransferLegs(transaction: string): Promise<SvmTransferLegs | null> {
  return (await observe(transaction))?.transfer ?? null;
}

export async function evaluateResourceBindFromSvmTx(
  transaction: string, leaf_hash: string,
): Promise<ResourceBindDecision> {
  const tx_memo = await extractSvmMemoFromTransaction(transaction);
  return evaluateResourceBind({ leaf_hash, tx_memo: tx_memo ?? undefined, extra_stamped: false });
}

function refuse(leaf_hash: string, reason: string): ResourceBindDecision {
  return {
    strength: "refuse", evidence_level: "unbound", fact_type: "resource_bound",
    leaf_hash, extra_stamped: false, reason,
  };
}

export async function evaluateResourceBindLegsFromSvmTx(
  transaction: string, leaf: ResourceBindLeafFields,
): Promise<ResourceBindDecision> {
  const o = await observe(transaction);
  if (!o) return evaluateResourceBind({ leaf_hash: leaf.leaf_hash, extra_stamped: false });
  if (o.violation) return refuse(leaf.leaf_hash, BOUND_TX_INSTRUCTION_REFUSED + o.violation);
  const tx_memo = pickBindMemo(o.memos);
  const tr = o.transfer;
  if (!tr) return refuse(leaf.leaf_hash, "no TransferChecked in tx");
  if (normalizeResourceBindScheme(leaf.scheme) === "unknown") {
    return refuse(leaf.leaf_hash, "scheme unknown");
  }
  if (tr.mint !== leaf.asset || !transferAmountMatchesLeaf(tr.amount, leaf)) {
    return refuse(leaf.leaf_hash, "transfer mint/amount mismatch vs leaf");
  }
  if (leaf.payer && tr.authority !== leaf.payer) {
    return refuse(leaf.leaf_hash, "transfer authority mismatch vs leaf.payer");
  }
  try {
    const token = await import("@solana-program/token");
    const { address } = await import("@solana/kit");
    const [ata] = await token.findAssociatedTokenPda({
      owner: address(leaf.pay_to), mint: address(leaf.asset), tokenProgram: address(tr.tokenProgram),
    });
    if (ata !== tr.dest) return refuse(leaf.leaf_hash, "dest ATA mismatch vs ATA(pay_to, mint)");
    const made = o.ataCreate;
    if (made && (made.ata !== ata || made.owner !== leaf.pay_to || made.mint !== leaf.asset
      || made.tokenProgram !== tr.tokenProgram)) {
      return refuse(leaf.leaf_hash, BOUND_TX_INSTRUCTION_REFUSED + "ata_create_not_for_bound_recipient");
    }
  } catch {
    return refuse(leaf.leaf_hash, "dest ATA derive failed");
  }
  if (!tx_memo || !memoContainsResourceBind(tx_memo, leaf.leaf_hash)) {
    return {
      strength: "soft", evidence_level: "client_stamped", fact_type: "resource_bound",
      leaf_hash: leaf.leaf_hash, extra_stamped: false, reason: "legs match; memo unbound",
    };
  }
  return {
    strength: "hard", evidence_level: "tx_included", fact_type: "resource_bound",
    leaf_hash: leaf.leaf_hash, extra_stamped: false,
    reason: "memo + transfer dest/amount/asset match leaf (same tx)",
  };
}
