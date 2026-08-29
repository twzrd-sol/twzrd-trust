/**
 * Memo + TransferChecked from one SVM wire tx. Hash-only evaluate stays
 * memo-inclusion. Legs-hard requires memo match AND mint/amount/dest-ATA.
 * Decodes presented bytes; does not prove the tx landed. Caller must confirm
 * inclusion (fetch by signature, err null) before treating hard as chain evidence.
 */
import {
  evaluateResourceBind, memoContainsResourceBind, RESOURCE_BIND_MEMO_PREFIX,
  type ResourceBindDecision,
} from "./resource-bind.js";

export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type ResourceBindLeafFields = {
  leaf_hash: string; pay_to: string; asset: string; amount_raw: string; payer?: string;
};
export type SvmTransferLegs = {
  mint: string; dest: string; authority: string; amount: string; tokenProgram: string;
};

type Ix = { programAddressIndex?: number; accountIndices?: number[]; data?: Uint8Array | number[] | ArrayBuffer };

function asBytes(data: Ix["data"]): Uint8Array | null {
  if (!data) return null;
  return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
}

async function observe(transaction: string): Promise<{ memos: string[]; transfer: SvmTransferLegs | null } | null> {
  const tx = transaction.trim();
  if (!tx || tx.length < 32 || !/^[A-Za-z0-9+/]+=*$/.test(tx)) return null;
  try {
    const svm = await import("@x402/svm");
    const kit = await import("@solana/kit");
    const decoded = svm.decodeTransactionFromPayload({ transaction: tx });
    const compiled = kit.getCompiledTransactionMessageDecoder().decode(decoded.messageBytes as never) as {
      staticAccounts?: Array<{ toString(): string }>; instructions?: Ix[];
    };
    const accounts = (compiled.staticAccounts ?? []).map((a) => a.toString());
    const memos: string[] = [];
    let transfer: SvmTransferLegs | null = null;
    for (const ix of compiled.instructions ?? []) {
      if (ix.programAddressIndex == null) continue;
      const program = accounts[ix.programAddressIndex];
      const d = asBytes(ix.data);
      if (program === (svm.MEMO_PROGRAM_ADDRESS ?? MEMO_PROGRAM_ADDRESS)) {
        if (d?.byteLength) memos.push(new TextDecoder().decode(d));
        continue;
      }
      if (transfer) continue;
      if ((program !== TOKEN && program !== TOKEN22) || !d || d[0] !== 12 || d.byteLength < 10) continue;
      const keys = (ix.accountIndices ?? []).map((i) => accounts[i]);
      if (keys.length < 4) continue;
      const amount = new DataView(d.buffer, d.byteOffset + 1, 8).getBigUint64(0, true).toString();
      transfer = { mint: keys[1], dest: keys[2], authority: keys[3], amount, tokenProgram: program };
    }
    return { memos, transfer };
  } catch { return null; }
}

export async function extractSvmMemoFromTransaction(transaction: string): Promise<string | null> {
  const o = await observe(transaction);
  if (!o?.memos.length) return null;
  return o.memos.find((m) => m.startsWith(RESOURCE_BIND_MEMO_PREFIX)) ?? o.memos[0];
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
  const tx_memo = o.memos.find((m) => m.startsWith(RESOURCE_BIND_MEMO_PREFIX)) ?? o.memos[0] ?? null;
  const tr = o.transfer;
  if (!tr) return refuse(leaf.leaf_hash, "no TransferChecked in tx");
  let amountOk = false;
  try { amountOk = BigInt(tr.amount) === BigInt(leaf.amount_raw); } catch { amountOk = false; }
  if (tr.mint !== leaf.asset || !amountOk) {
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
