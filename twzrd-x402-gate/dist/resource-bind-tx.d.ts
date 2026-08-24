/**
 * Memo + TransferChecked from one SVM wire tx. Hash-only evaluate stays
 * memo-inclusion. Legs-hard requires memo match AND mint/amount/dest-ATA.
 * Decodes presented bytes; does not prove the tx landed. Caller must confirm
 * inclusion (fetch by signature, err null) before treating hard as chain evidence.
 */
import { type ResourceBindDecision } from "./resource-bind.js";
export declare const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export type ResourceBindLeafFields = {
    leaf_hash: string;
    pay_to: string;
    asset: string;
    amount_raw: string;
    payer?: string;
};
export type SvmTransferLegs = {
    mint: string;
    dest: string;
    authority: string;
    amount: string;
    tokenProgram: string;
};
export declare function extractSvmMemoFromTransaction(transaction: string): Promise<string | null>;
export declare function extractSvmTransferLegs(transaction: string): Promise<SvmTransferLegs | null>;
export declare function evaluateResourceBindFromSvmTx(transaction: string, leaf_hash: string): Promise<ResourceBindDecision>;
export declare function evaluateResourceBindLegsFromSvmTx(transaction: string, leaf: ResourceBindLeafFields): Promise<ResourceBindDecision>;
//# sourceMappingURL=resource-bind-tx.d.ts.map