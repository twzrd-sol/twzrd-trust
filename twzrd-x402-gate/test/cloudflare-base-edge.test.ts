/** Worker/Viem-shaped Base payment fixture: block means no EVM signature. */
import assert from "node:assert/strict";

import {
  createTwzrdCloudflareBaseApproval,
  TwzrdBasePaymentBlockedError,
  withTwzrdBasePreflight,
} from "../src/cloudflare-base.js";

const CHECKSUMMED_PAY_TO = "0x3803A19280DeeFe533D177C4A169412BD341101b";

const requirements = {
  resource: "https://worker.example/paid-tool",
  accepts: [{ network: "eip155:8453", payTo: CHECKSUMMED_PAY_TO, amount: "1000" }],
};

function blockedFetch(calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        readiness_card: {
          decision: "block",
          trust_score: 7,
          reason_codes: ["BASE_FIXTURE_UNTRUSTED"],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function run() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let signatures = 0;
  const viemAccount = {
    signTypedData: async () => {
      signatures += 1;
      return "0xsignature" as const;
    },
  };
  const options = { intelBase: "https://intel.fixture", fetch: blockedFetch(calls) };

  await assert.rejects(
    () => withTwzrdBasePreflight(requirements, options, () => viemAccount.signTypedData()),
    (error: unknown) =>
      error instanceof TwzrdBasePaymentBlockedError &&
      error.verdict.decision === "block" &&
      error.verdict.riskScore === 7 &&
      error.verdict.reasons.includes("BASE_FIXTURE_UNTRUSTED"),
  );
  assert.equal(signatures, 0, "a blocked Base payTo must never reach signTypedData");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://intel.fixture/v1/intel/preflight");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.seller_wallet, CHECKSUMMED_PAY_TO);
  assert.equal(body.chain_id, 8453);
  assert.equal(body.chain, "base");

  // Lowercase EVM addresses are equally valid inputs and must reach the same
  // preflight boundary rather than being rejected by address normalization.
  const lower = {
    ...requirements,
    accepts: [{ ...requirements.accepts[0], payTo: CHECKSUMMED_PAY_TO.toLowerCase() }],
  };
  assert.equal(await createTwzrdCloudflareBaseApproval(options)(lower), false);
  assert.equal(calls.length, 2);

  console.log("cloudflare-base-edge.test.ts: ALL PASSED (block -> zero EVM signatures)");
}

run().catch((error) => {
  console.error("cloudflare-base-edge.test.ts FAILED:", error);
  process.exit(1);
});
