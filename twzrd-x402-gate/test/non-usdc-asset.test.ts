/**
 * 0.11.1: the gate prices every cap in USDC, so a payment requirement that
 * names any other asset on a network with a known USDC set is refused before
 * intel (`twzrd_non_usdc_asset`), and is never priced as amount / 1e6.
 *
 * The defect: `amount` is in the named asset's base units. An 8-decimal mint at
 * amount 100000 read as $0.10 (inside the 0.11.0 unevaluated-seller cap) while
 * the signed transfer moved 0.001 of that token.
 * Run: npx tsx test/non-usdc-asset.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { isUsdcRequirement, priceUsdcFromAmountMicro } from "../src/payto.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { twzrd } from "../src/spend-control.js";
import { evaluateBeforePaymentCreation } from "../src/x402-client-hook.js";

const SELLER = "SeLLeRWa11et1111111111111111111111111111111";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Any other SPL mint (the attack names one with 8 decimals).
const OTHER_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const OTHER_ERC20 = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const POLYGON = "eip155:137";

/** Intel stub that records calls; answers `card` for preflight, no wash for the card lookup. */
function intel(card: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const body = /\/merchant_card\//.test(String(url)) ? { wash_flagged: false } : { readiness_card: card };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
const allowCard = { decision: "allow", trust_score: 90, score: 90, can_spend: true, recommended_cap_usdc: 1 };
const unknownCard = {
  decision: "warn", trust_score: 45, score: null, null_reason: "unknown_subject", can_spend: true, recommended_cap_usdc: 0.1,
};
const req = (network: string, asset: string | undefined, amount = "100000") => ({
  payTo: SELLER, network, amount, resource: "https://seller.example/paid", ...(asset ? { asset } : {}),
});

async function run() {
  // --- pricing ---
  {
    assert.equal(priceUsdcFromAmountMicro("100000", { network: MAINNET, asset: USDC_MAINNET }), 0.1);
    assert.equal(priceUsdcFromAmountMicro("100000", { network: "solana", asset: USDC_MAINNET }), 0.1);
    assert.equal(priceUsdcFromAmountMicro("100000", { network: MAINNET, asset: OTHER_MINT }), undefined);
    assert.equal(priceUsdcFromAmountMicro("100000", { network: MAINNET, asset: USDC_DEVNET }), undefined, "devnet mint on mainnet is some other token");
    assert.equal(priceUsdcFromAmountMicro("100000", { network: "eip155:8453", asset: USDC_BASE.toLowerCase() }), 0.1);
    assert.equal(priceUsdcFromAmountMicro("100000", { network: "eip155:8453", asset: OTHER_ERC20 }), undefined);
    assert.equal(priceUsdcFromAmountMicro("100000", { network: MAINNET }), 0.1, "no asset named: schemes default to USDC");
    assert.equal(priceUsdcFromAmountMicro("100000", { network: POLYGON, asset: OTHER_ERC20 }), 0.1, "no USDC set for this network: unchanged");
    assert.equal(priceUsdcFromAmountMicro("100000"), 0.1, "no requirement: unchanged");
    assert.equal(isUsdcRequirement({ network: MAINNET, asset: "USDC" }), false, "a symbol is not a mint");
  }

  // --- the discriminating case: an EVALUATED allow seller asking in another mint ---
  {
    const f = intel(allowCard);
    const r = await twzrdApprovePayment(
      { payTo: SELLER, chain: MAINNET, priceUsdc: 0.1, asset: OTHER_MINT },
      resolveConfig({ fetch: f }),
    );
    assert.equal(r.approved, false);
    assert.equal(r.reason, "twzrd_non_usdc_asset");
    assert.equal(r.policyAction, "block");
    assert.equal(f.calls.length, 0, "refused before intel");

    // Not an outage: failOpen does not turn it into an allow.
    const r2 = await twzrdApprovePayment(
      { payTo: SELLER, chain: MAINNET, priceUsdc: 0.1, asset: OTHER_MINT },
      resolveConfig({ fetch: intel(allowCard), failOpen: true }),
    );
    assert.equal(r2.reason, "twzrd_non_usdc_asset");
  }

  // --- through the x402 client hook (the PayAI / AutoGate path) ---
  for (const [label, card] of [["evaluated allow", allowCard], ["unevaluated", unknownCard]] as const) {
    const f = intel(card);
    const result = await evaluateBeforePaymentCreation(req(MAINNET, OTHER_MINT), { fetch: f });
    assert.ok(result && result.abort === true, `${label}: must abort`);
    assert.match(String(result.reason), /twzrd_non_usdc_asset/);
    assert.equal(f.calls.length, 0, `${label}: intel not called`);
  }
  {
    // Devnet USDC mint named on a mainnet requirement: refused.
    const result = await evaluateBeforePaymentCreation(req(MAINNET, USDC_DEVNET), { fetch: intel(allowCard) });
    assert.ok(result && result.abort === true);
    assert.match(String(result.reason), /twzrd_non_usdc_asset/);
    // Base, a non-USDC ERC-20: refused.
    const base = await evaluateBeforePaymentCreation(req("eip155:8453", OTHER_ERC20), { fetch: intel(allowCard) });
    assert.ok(base && base.abort === true);
    assert.match(String(base.reason), /twzrd_non_usdc_asset/);
  }
  {
    // Unchanged: mainnet USDC, and no asset named, still reach intel and allow.
    for (const asset of [USDC_MAINNET, undefined]) {
      const f = intel(allowCard);
      const result = await evaluateBeforePaymentCreation(req(MAINNET, asset), { fetch: f });
      assert.ok(!result || result.abort !== true, `asset ${asset}: unexpected abort ${JSON.stringify(result)}`);
      assert.ok(f.calls.length >= 1, "intel consulted");
    }
    // Unchanged: an unscored network keeps its observe allow whatever the asset.
    const f = intel(allowCard);
    const polygon = await evaluateBeforePaymentCreation(req(POLYGON, OTHER_ERC20), {
      fetch: f,
      refuseWashFlagged: false,
    });
    assert.ok(!polygon || polygon.abort !== true, `polygon observe: ${JSON.stringify(polygon)}`);
    assert.equal(f.calls.length, 0);
  }

  // --- evaluate_x402_resource ---
  {
    const r = await evaluate_x402_resource("https://seller.example/paid", req(MAINNET, OTHER_MINT), { fetch: intel(allowCard) });
    assert.equal(r.approved, false);
    assert.equal(r.reason, "twzrd_non_usdc_asset");
  }

  // --- twzrd.safeFetch: its budget counts micro-USDC, so any other asset is refused ---
  {
    let signs = 0;
    const r = await twzrd.safeFetch("https://seller.example/paid", {
      fetch: (async () =>
        new Response(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", ...req("solana", OTHER_MINT, "1000") }] }), {
          status: 402, headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      maxSpend: "0.01",
      pay: async () => { signs += 1; return { response: new Response("ok") }; },
    });
    assert.equal(r.verdict, "block");
    assert.equal(r.reason, "non_usdc_asset");
    assert.equal(signs, 0);
  }

  console.log("non-usdc-asset.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("non-usdc-asset.test.ts FAILED:", e);
  process.exit(1);
});
