import { resolve } from "node:path";
import { createBuyerFetch, BuyerFetchBlockedError } from "./buyer-fetch.js";

/** Real x402 client + synthetic 402. No keys, network requests, or payment. */
export async function runBuyerDemo(directory = ".twzrd") {
  const { x402Client } = await import("@x402/fetch").catch(cause => {
    throw new Error("Install the demo's optional peers: npm install @x402/core @x402/fetch", { cause });
  });
  const network = "eip155:8453" as const;
  const seller = "0x1111111111111111111111111111111111111111";
  let signerInvocations = 0;
  let paidRequests = 0;
  const client = new x402Client();
  client.setSpendControls(false);
  client.register(network, {
    scheme: "exact",
    async createPaymentPayload() {
      signerInvocations++;
      throw new Error("Demo failed: the signer was invoked");
    },
  });
  const decisionFile = resolve(directory, "demo-decisions.jsonl");
  const guarded = createBuyerFetch({
    client, maxPricePerCall: "0.001", allowedRecipients: [seller],
    decisionFile, spendLedgerFile: resolve(directory, "demo-spend.jsonl"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has("payment-signature")) paidRequests++;
      return new Response(null, { status: 402, headers: {
        "payment-required": Buffer.from(JSON.stringify({
          x402Version: 2, resource: { url: "https://merchant.example/paid" },
          accepts: [{ scheme: "exact", network, payTo: seller,
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "50000", maxTimeoutSeconds: 60, extra: {} }],
        })).toString("base64"),
      } });
    },
  });
  try { await guarded("https://merchant.example/paid"); }
  catch (error) {
    if (error instanceof BuyerFetchBlockedError && error.reason === "price_cap_exceeded" && signerInvocations === 0 && paidRequests === 0) {
      return { mode: "offline_fixture", decision: "block", reason: error.reason,
        signer_invocations: signerInvocations, paid_requests: paidRequests,
        usdc_spent: 0, decision_file: decisionFile };
    }
    throw error;
  }
  throw new Error("Demo failed: an over-cap payment was not refused");
}
