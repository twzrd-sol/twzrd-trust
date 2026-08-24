/**
 * Decode Memo IX UTF-8 from an exact-SVM wire tx. Optional @x402/svm + @solana/kit.
 * Hard from this seat is memo inclusion only; transfer dest/amount/asset/payer
 * are NOT matched against the leaf (that is a later slice).
 */
import {
  evaluateResourceBind,
  RESOURCE_BIND_MEMO_PREFIX,
  type ResourceBindDecision,
} from "./resource-bind.js";

export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

type CompiledIx = {
  programAddressIndex?: number;
  data?: Uint8Array | number[] | ArrayBuffer;
};

function utf8(data: CompiledIx["data"]): string | null {
  if (!data) return null;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  if (bytes.byteLength === 0) return null;
  return new TextDecoder().decode(bytes);
}

export async function extractSvmMemoFromTransaction(
  transaction: string,
): Promise<string | null> {
  const tx = transaction.trim();
  if (!tx || tx.length < 32 || !/^[A-Za-z0-9+/]+=*$/.test(tx)) return null;
  try {
    const svm = await import("@x402/svm");
    const kit = await import("@solana/kit");
    const decoded = svm.decodeTransactionFromPayload({ transaction: tx });
    const compiled = kit.getCompiledTransactionMessageDecoder().decode(
      // kit brands messageBytes; wire bytes are the same buffer.
      decoded.messageBytes as never,
    ) as {
      staticAccounts?: Array<{ toString(): string }>;
      instructions?: CompiledIx[];
    };
    const accounts = compiled.staticAccounts ?? [];
    const memos: string[] = [];
    for (const ix of compiled.instructions ?? []) {
      const idx = ix.programAddressIndex;
      if (idx == null) continue;
      const program = accounts[idx]?.toString();
      if (program !== (svm.MEMO_PROGRAM_ADDRESS ?? MEMO_PROGRAM_ADDRESS)) continue;
      const text = utf8(ix.data);
      if (text) memos.push(text);
    }
    if (memos.length === 0) return null;
    return memos.find((m) => m.startsWith(RESOURCE_BIND_MEMO_PREFIX)) ?? memos[0];
  } catch {
    return null;
  }
}

export async function evaluateResourceBindFromSvmTx(
  transaction: string,
  leaf_hash: string,
): Promise<ResourceBindDecision> {
  const tx_memo = await extractSvmMemoFromTransaction(transaction);
  return evaluateResourceBind({
    leaf_hash,
    tx_memo: tx_memo ?? undefined,
    extra_stamped: false,
  });
}
