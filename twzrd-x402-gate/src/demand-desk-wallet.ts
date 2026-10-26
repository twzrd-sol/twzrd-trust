import { createHash } from "node:crypto";
import { verifyDemandDeskAuthorization, type DemandDeskAuthorizationExpectation } from "./demand-desk-authorization.js";

export type DemandDeskWalletContext = { authorization: unknown; messageHash: string };
export type DemandDeskWalletAdapter<T> = {
  /** These callbacks must decode the transaction itself, not caller metadata. */
  messageBytes(tx: T): Uint8Array;
  expectation(tx: T): DemandDeskAuthorizationExpectation;
  signTransaction(tx: T): Promise<T>;
  sendTransaction(tx: T): Promise<string>;
  /** Authenticated local mandate/revocation check, immediately before signing. */
  isActive(): boolean;
};

export function demandDeskMessageHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Exclusive capability facade for SVM and ElizaOS wallet providers. The raw
 * signer is retained only in this closure. Verification and signer invocation
 * have no asynchronous gap; batch calls validate every item before signing any.
 * Durable replay enforcement belongs to the Desk, not this stateless facade.
 */
export function createDemandDeskWallet<T>(adapter: DemandDeskWalletAdapter<T>) {
  function assert(tx: T, context: DemandDeskWalletContext): void {
    if (!adapter.isActive()) throw new Error("mandate_inactive");
    if (!context || demandDeskMessageHash(adapter.messageBytes(tx)) !== context.messageHash) {
      throw new Error("transaction_message_mismatch");
    }
    const result = verifyDemandDeskAuthorization(context.authorization, adapter.expectation(tx));
    if (!result.ok) throw new Error(`demand_desk_${result.code}`);
  }
  async function signTransaction(tx: T, context: DemandDeskWalletContext): Promise<T> {
    assert(tx, context);
    return adapter.signTransaction(tx);
  }
  return Object.freeze({
    signTransaction,
    async signAllTransactions(items: readonly { transaction: T; context: DemandDeskWalletContext }[]): Promise<T[]> {
      for (const item of items) assert(item.transaction, item.context);
      const signed: T[] = [];
      for (const item of items) signed.push(await signTransaction(item.transaction, item.context));
      return signed;
    },
    async signAndSendTransaction(tx: T, context: DemandDeskWalletContext): Promise<string> {
      const signed = await signTransaction(tx, context);
      assert(signed, context);
      return adapter.sendTransaction(signed);
    },
  });
}
