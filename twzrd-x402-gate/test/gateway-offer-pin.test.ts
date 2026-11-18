/**
 * Circle Gateway batching offers are pinned to Gateway's wallet contract (0.26.0, F3/F4).
 *
 * Circle's BatchEvmScheme signs the EIP-712 domain with the `extra.verifyingContract`
 * and `extra.version` the seller names, and a validBefore stretched by
 * `maxTimeoutSeconds`. In 0.25.x a Base offer naming verifyingContract 0x1111…1111
 * was signed through installTwzrdX402ClientHook in observe AND strict (stress run s2).
 * The check sits in resolveRequirementFields, so every seat that refuses on
 * `conflict` refuses it, before intel and in every mode.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate_x402_resource } from "../src/evaluate.js";
import {
  GATEWAY_MAX_TIMEOUT_SECONDS,
  gatewayBatchRefusal,
  resolveRequirementFields,
} from "../src/payto.js";
import { safeFetch } from "../src/safe-fetch.js";
import { evaluateBeforePaymentCreation } from "../src/x402-client-hook.js";

const MAINNET_GATEWAY = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const TESTNET_GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const ATTACKER = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x3803A19280DeeFe533D177C4A169412BD341101b";

const gatewayOffer = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: BASE_USDC,
  amount: "10000",
  payTo: SELLER,
  resource: "https://seller.example/api",
  maxTimeoutSeconds: 345600,
  extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: MAINNET_GATEWAY, ...extra },
  ...top,
});

/** Intel that allows SELLER and counts calls. */
function allowIntel() {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const u = String(input instanceof Request ? input.url : input);
    urls.push(u);
    if (u.startsWith("https://seller.example/")) {
      return new Response(JSON.stringify({ x402Version: 2, accepts: currentAccepts }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ readiness_card: { decision: "allow", can_spend: true, trust_score: 90, wash_flagged: false } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, intelCalls: () => urls.filter((u) => !u.startsWith("https://seller.example/")).length };
}
let currentAccepts: unknown[] = [];
const quiet = { refuseWashFlagged: false, refuseWashUnknown: false } as const;

test("gatewayBatchRefusal", () => {
  assert.equal(gatewayBatchRefusal(gatewayOffer()), undefined);
  assert.equal(gatewayBatchRefusal(gatewayOffer({ verifyingContract: MAINNET_GATEWAY.toLowerCase() })), undefined);
  assert.equal(gatewayBatchRefusal(gatewayOffer({ verifyingContract: TESTNET_GATEWAY })), undefined);
  assert.equal(gatewayBatchRefusal(gatewayOffer({ version: "2" })), undefined);
  assert.equal(gatewayBatchRefusal(gatewayOffer({ version: undefined })), undefined, "Circle reads a missing version as 1");
  assert.equal(gatewayBatchRefusal(gatewayOffer({}, { maxTimeoutSeconds: undefined })), undefined);
  assert.equal(gatewayBatchRefusal(gatewayOffer({}, { maxTimeoutSeconds: GATEWAY_MAX_TIMEOUT_SECONDS })), undefined);

  assert.equal(gatewayBatchRefusal(gatewayOffer({ verifyingContract: ATTACKER })), "gateway_verifying_contract_refused");
  assert.equal(gatewayBatchRefusal(gatewayOffer({ verifyingContract: undefined })), "gateway_verifying_contract_refused");
  assert.equal(gatewayBatchRefusal(gatewayOffer({ verifyingContract: BASE_USDC })), "gateway_verifying_contract_refused");
  assert.equal(gatewayBatchRefusal(gatewayOffer({ version: "9" })), "gateway_version_refused");
  assert.equal(gatewayBatchRefusal(gatewayOffer({ version: 1 })), "gateway_version_refused");
  for (const t of [GATEWAY_MAX_TIMEOUT_SECONDS + 1, -1, 1.5, "604800", Number.POSITIVE_INFINITY]) {
    assert.equal(gatewayBatchRefusal(gatewayOffer({}, { maxTimeoutSeconds: t })), "gateway_timeout_refused", String(t));
  }

  // Not a Gateway batching offer: untouched (EIP-3009 exact names the token contract).
  assert.equal(gatewayBatchRefusal({ ...gatewayOffer(), extra: { name: "USD Coin", version: "2", verifyingContract: ATTACKER } }), undefined);
  assert.equal(gatewayBatchRefusal({ ...gatewayOffer(), extra: undefined }), undefined);
  assert.equal(resolveRequirementFields(gatewayOffer({ verifyingContract: ATTACKER })).conflict, "gateway_verifying_contract_refused");
});

for (const mode of ["observe", "strict"] as const) {
  test(`client hook (the s2 seat) refuses an attacker verifyingContract in ${mode}, before intel`, async () => {
    for (const extra of [{ verifyingContract: ATTACKER }, { version: "2", verifyingContract: ATTACKER }]) {
      const intel = allowIntel();
      const r = await evaluateBeforePaymentCreation(gatewayOffer(extra), {
        fetch: intel.fetch, unsupportedNetworkMode: mode, ...quiet,
      });
      assert.equal(r?.abort, true, JSON.stringify(r));
      assert.match(String(r?.reason), /gateway_verifying_contract_refused/);
      assert.equal(intel.intelCalls(), 0);
    }
  });

  test(`client hook lets a Gateway-pinned offer through to intel in ${mode}`, async () => {
    const intel = allowIntel();
    const r = await evaluateBeforePaymentCreation(gatewayOffer(), {
      fetch: intel.fetch, unsupportedNetworkMode: mode, ...quiet,
    });
    assert.ok(!r || r.abort !== true, JSON.stringify(r));
    assert.ok(intel.intelCalls() >= 1);
  });
}

test("evaluate_x402_resource refuses it", async () => {
  const intel = allowIntel();
  const r = await evaluate_x402_resource("https://seller.example/api", gatewayOffer({ verifyingContract: ATTACKER }), {
    fetch: intel.fetch, ...quiet,
  });
  assert.equal(r.approved, false);
  assert.equal(r.reason, "gateway_verifying_contract_refused");
});

test("safeFetch refuses an attacker Gateway offer listed beside a pinned one", async () => {
  currentAccepts = [gatewayOffer(), gatewayOffer({ verifyingContract: ATTACKER })];
  const intel = allowIntel();
  let payerCalls = 0;
  const r = await safeFetch({
    url: "https://seller.example/api",
    fetch: intel.fetch,
    deliveryCapture: false,
    ...quiet,
    runPayer: async () => {
      payerCalls += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  });
  assert.equal(r.phase, "blocked");
  assert.equal(r.error, "alternate_offer_refused:gateway_verifying_contract_refused");
  assert.equal(payerCalls, 0);
});
