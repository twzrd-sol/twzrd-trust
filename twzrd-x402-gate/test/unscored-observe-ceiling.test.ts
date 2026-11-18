/**
 * Observe mode on a network TWZRD does not score (0.26.0).
 *
 * Before 0.26.0 observe allowed an unscored network with no ceiling and no asset
 * check: an Arc offer for 1e16 base units of USDC asked the signer to sign, and a
 * non-USDC asset on an unscored EVM chain was allowed. Now observe pays only that
 * network's listed USDC, at most unscoredMaxUsdc per call (default 0.10). A
 * merchant card that answers 404 stays an allow, under that ceiling.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { DEFAULT_UNSCORED_MAX_USDC, resolveConfig } from "../src/config.js";
import { priceUsdcFromAmountMicro } from "../src/payto.js";
import { twzrdApprovePayment } from "../src/policy.js";
import type { TwzrdGateConfig } from "../src/types.js";

const ARC = "eip155:5042";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const NOT_USDC = "0x2222222222222222222222222222222222222222";
const SELLER = "0x3803A19280DeeFe533D177C4A169412BD341101b";

/** Every intel call answers 404: the merchant card has no record of this seller. */
function card404() {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ detail: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

async function approve(amount: string | undefined, extra: Partial<TwzrdGateConfig> = {}, asset = ARC_USDC) {
  const intel = card404();
  const priceUsdc = amount === undefined ? undefined : priceUsdcFromAmountMicro(amount, { network: ARC, asset });
  const r = await twzrdApprovePayment(
    { payTo: SELLER, chain: ARC, asset, priceUsdc, resourceUrl: "https://seller.example/api" },
    resolveConfig({ fetch: intel.fetch, ...extra }),
  );
  return { r, intel };
}

const savedEnv = process.env.TWZRD_UNSCORED_MAX_USDC;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TWZRD_UNSCORED_MAX_USDC;
  else process.env.TWZRD_UNSCORED_MAX_USDC = savedEnv;
});

test("the default ceiling is 0.10 USDC", () => {
  delete process.env.TWZRD_UNSCORED_MAX_USDC;
  assert.equal(DEFAULT_UNSCORED_MAX_USDC, 0.1);
  assert.equal(resolveConfig({}).unscoredMaxUsdc, 0.1);
});

test("an Arc USDC offer for 1e16 base units refuses before the signer (was signed in 0.25.x)", async () => {
  const { r, intel } = await approve("10000000000000000");
  assert.equal(r.approved, false);
  assert.match(r.reason, /^twzrd_over_unscored_cap_10000000000_gt_0\.1$/);
  assert.equal(intel.urls.length, 0, "refused before intel");
});

test("a card 404 on Arc is a capped allow: $0.01 pays, $1 refuses", async () => {
  const small = await approve("10000");
  assert.equal(small.r.approved, true, small.r.reason);
  assert.equal(small.r.reputationScored, false);
  assert.ok(small.intel.urls.length >= 1, "the merchant card was asked");

  const big = await approve("1000000");
  assert.equal(big.r.approved, false);
  assert.equal(big.r.reason, "twzrd_over_unscored_cap_1_gt_0.1");
});

test("the ceiling applies at the boundary as <=", async () => {
  const { r } = await approve("100000");
  assert.equal(r.approved, true, r.reason);
});

test("unscoredMaxUsdc: null turns the ceiling off and ignores the env", async () => {
  process.env.TWZRD_UNSCORED_MAX_USDC = "0.01";
  const { r } = await approve("1000000", { unscoredMaxUsdc: null });
  assert.equal(r.approved, true, r.reason);
});

test("TWZRD_UNSCORED_MAX_USDC applies when the option is left out; the option wins", async () => {
  process.env.TWZRD_UNSCORED_MAX_USDC = "2";
  assert.equal((await approve("1000000")).r.approved, true);
  assert.equal((await approve("1000000", { unscoredMaxUsdc: 0.5 })).r.approved, false);
  process.env.TWZRD_UNSCORED_MAX_USDC = "not a number";
  assert.equal(resolveConfig({}).unscoredMaxUsdc, 0.1, "an unreadable env value keeps the default");
  process.env.TWZRD_UNSCORED_MAX_USDC = "-1";
  assert.equal(resolveConfig({}).unscoredMaxUsdc, 0.1, "a negative env value keeps the default");
  assert.equal(resolveConfig({ unscoredMaxUsdc: Number.NaN }).unscoredMaxUsdc, 0.1);
});

test("a non-USDC asset on an unscored network refuses before intel (F2)", async () => {
  const { r, intel } = await approve("10000", {}, NOT_USDC);
  assert.equal(r.approved, false);
  assert.equal(r.reason, "twzrd_non_usdc_asset");
  assert.equal(intel.urls.length, 0);
});

test("an unknown price refuses while a ceiling is set", async () => {
  const { r } = await approve(undefined);
  assert.equal(r.approved, false);
  assert.equal(r.reason, "twzrd_unscored_price_unknown");
  const off = await approve(undefined, { unscoredMaxUsdc: null });
  assert.equal(off.r.approved, true, off.r.reason);
});

test("strict is unchanged: an unscored network refuses before any of this", async () => {
  const { r, intel } = await approve("10000", { unsupportedNetworkMode: "strict" });
  assert.equal(r.approved, false);
  assert.equal(r.reason, "network_not_scored");
  assert.equal(intel.urls.length, 0);
});
