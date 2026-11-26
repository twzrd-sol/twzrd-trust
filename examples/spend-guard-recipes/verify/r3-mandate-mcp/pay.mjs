// The payer the sidecar loads with --pay-module (the README's pattern). Test build: a throwaway
// key generated in memory at start, never written; each signature appends one line to SIGN_LOG.
import { appendFileSync } from "node:fs";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(generatePrivateKey());
const signer = { address: account.address, signTypedData: async (m) => {
  if (process.env.SIGN_LOG) appendFileSync(process.env.SIGN_LOG, "sign " + new Date().toISOString() + "\n");
  return account.signTypedData(m);
} };
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
export const wrapPay = (guarded) => wrapFetchWithPayment(guarded, client);
