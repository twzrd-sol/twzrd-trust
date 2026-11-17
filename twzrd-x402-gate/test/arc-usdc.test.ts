/**
 * Arc USDC in the gate's USDC table.
 *
 * Circle's Gateway offers x402 `exact` payments on Arc (eip155:5042) and Arc
 * testnet (eip155:5042002) in USDC at 0x3600…0000, 6 decimals. Before this
 * change the gate had no Arc USDC set, so:
 *  - buyer-fetch, guarded fetch with a spend rule and the mandate refused an
 *    Arc USDC offer as `unsupported_or_non_usdc_asset`, and
 *  - any other Arc ERC-20 was priced as amount / 1e6, as if it were USDC.
 * After it, Arc USDC prices exactly and any other Arc asset has no USD price.
 * Arc stays unscored: classifyNetwork still says network_not_scored, so the
 * unsupported-network mode (observe / strict) decides, as for every other
 * unscored EVM chain. Nothing here widens what TWZRD claims to have scored.
 *
 * The offers below are copied from Circle's live list,
 * GET https://gateway-api.circle.com/v1/x402/supported (mainnet) and
 * https://gateway-api-testnet.circle.com/v1/x402/supported, read 2026-11-17.
 * Run: npx tsx test/arc-usdc.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { x402RequirementsToIntent } from "../src/intent-adapters.js";
import { classifyNetwork } from "../src/network.js";
import { hasUsdcTable, isBatchSettlement, isUsdcRequirement, priceUsdcFromAmountMicro } from "../src/payto.js";
import { twzrdApprovePayment } from "../src/policy.js";

const SELLER = "0x1111111111111111111111111111111111111111";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const OTHER_ERC20 = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

// Circle Gateway `kinds[]` entries, trimmed to the fields a requirement carries.
const GATEWAY_EXTRA = {
  name: "GatewayWalletBatched",
  version: "1",
  verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
  minValiditySeconds: 604800,
};
const CIRCLE_KINDS = [
  { network: "eip155:5042", usdc: { symbol: "USDC", address: ARC_USDC, decimals: 6 } },
  { network: "eip155:5042002", usdc: { symbol: "USDC", address: ARC_USDC, decimals: 6 } },
  { network: "eip155:8453", usdc: { symbol: "USDC", address: BASE_USDC, decimals: 6 } },
] as const;

/** A 402 `accepts[]` entry as a Circle Gateway seller would send it. */
const offer = (network: string, asset: string, amount = "10000") => ({
  x402Version: 2,
  scheme: "exact",
  network,
  asset,
  amount,
  payTo: SELLER,
  maxTimeoutSeconds: 604800,
  resource: "https://seller.example/paid",
  extra: GATEWAY_EXTRA,
});

/** Intel stub that records calls and answers allow. */
function intel() {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const body = /\/merchant_card\//.test(String(url))
      ? { wash_flagged: false, confidence: "full" }
      : { readiness_card: { decision: "allow", trust_score: 90, score: 90, can_spend: true, recommended_cap_usdc: 1 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function run() {
  // --- Circle's live offers: every one is USDC the gate can price, none is batch-settlement ---
  for (const k of CIRCLE_KINDS) {
    const o = offer(k.network, k.usdc.address);
    assert.equal(k.usdc.decimals, 6, `${k.network}: Circle lists 6 decimals`);
    assert.equal(isUsdcRequirement(o), true, `${k.network}: Circle's USDC`);
    assert.equal(hasUsdcTable(o), true, `${k.network}: has a USDC set`);
    assert.equal(isBatchSettlement(o), false, `${k.network}: Gateway uses scheme exact`);
    assert.equal(priceUsdcFromAmountMicro(o.amount, o), 0.01, `${k.network}: 10000 base units = $0.01`);
  }

  // --- Arc: only Circle's USDC, only on Arc, only by CAIP-2 id ---
  {
    assert.equal(isUsdcRequirement(offer("eip155:5042", ARC_USDC.toUpperCase().replace("0X", "0x"))), true, "hex compared case-insensitively");
    assert.equal(isUsdcRequirement(offer("eip155:5042", OTHER_ERC20)), false, "another ERC-20 on Arc");
    assert.equal(isUsdcRequirement(offer("eip155:5042", BASE_USDC)), false, "Base's USDC named on Arc");
    assert.equal(isUsdcRequirement(offer("eip155:8453", ARC_USDC)), false, "Arc's USDC named on Base");
    assert.equal(isUsdcRequirement(offer("eip155:137", ARC_USDC)), false, "Arc's address on a chain with no set");
    assert.equal(isUsdcRequirement(offer("arc", ARC_USDC)), false, "no alias: classifyNetwork has none");
    assert.equal(isUsdcRequirement(offer(" EIP155:5042 ", ARC_USDC)), true, "trimmed, lowercased like Base");
  }

  // --- the pricing fix: another Arc asset no longer reads as USDC ---
  {
    assert.equal(priceUsdcFromAmountMicro("100000", { network: "eip155:5042", asset: OTHER_ERC20 }), undefined);
    assert.equal(priceUsdcFromAmountMicro("100000", { network: "eip155:5042002", asset: OTHER_ERC20 }), undefined);
    assert.throws(
      () => x402RequirementsToIntent(offer("eip155:5042", OTHER_ERC20) as never),
      /not USDC; no USD price/,
      "intent adapter refuses an unpriced Arc asset",
    );
    const intent = x402RequirementsToIntent(offer("eip155:5042", ARC_USDC, "2500") as never);
    assert.equal(intent.amount, "0.0025");
    // Unchanged for chains with no set: best-effort reading, nothing capped in USDC there.
    assert.equal(priceUsdcFromAmountMicro("100000", { network: "eip155:137", asset: OTHER_ERC20 }), 0.1);
  }

  // --- Arc stays unscored: the table prices, it does not score ---
  for (const network of ["eip155:5042", "eip155:5042002"]) {
    const c = classifyNetwork(network, SELLER);
    assert.equal(c.kind, "evm");
    assert.equal(c.reputationScored, false, `${network} must not be reputation-scored`);
    assert.equal(c.reason, "network_not_scored");
  }

  // --- policy: strict refuses an Arc USDC payment before intel; observe never claims a scored allow ---
  {
    const f = intel();
    const strict = await twzrdApprovePayment(
      { payTo: SELLER, chain: "eip155:5042", priceUsdc: 0.01, asset: ARC_USDC },
      resolveConfig({ fetch: f, unsupportedNetworkMode: "strict" }),
    );
    assert.equal(strict.approved, false);
    assert.equal(strict.policyAction, "block");
    assert.equal(strict.reputationScored, false);
    assert.equal(f.calls.length, 0, "strict: no intel call");

    const observe = await twzrdApprovePayment(
      { payTo: SELLER, chain: "eip155:5042", priceUsdc: 0.01, asset: ARC_USDC },
      resolveConfig({ fetch: intel(), unsupportedNetworkMode: "observe", refuseWashFlagged: false }),
    );
    assert.equal(observe.reputationScored, false, "observe: never a scored decision on Arc");
    assert.notEqual(observe.verdict, "allow", "observe: an unscored chain is not a reputation allow");
  }

  console.log("arc-usdc: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
