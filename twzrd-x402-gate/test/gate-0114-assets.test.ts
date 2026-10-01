import assert from "node:assert/strict";
import test from "node:test";
import { TwzrdUnpricedAssetError, x402RequirementsToIntent } from "../src/index.js";

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const PAY = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

test("USDC converts at 6 decimals", () => {
  const i = x402RequirementsToIntent({ scheme: "exact", network: NET, asset: USDC, payTo: PAY, amount: "1500000" } as never);
  assert.equal(i.amount, "1.5");
});

test("a non-USDC asset has no USD price: 5 wSOL is not $500", () => {
  assert.throws(
    () => x402RequirementsToIntent({ scheme: "exact", network: NET, asset: WSOL, payTo: PAY, amount: "500000000" } as never),
    (e: unknown) => e instanceof TwzrdUnpricedAssetError && e.code === "twzrd_non_usdc_asset",
  );
});

test("a non-integer or oversized-looking amount is refused, not passed through", () => {
  for (const amount of ["Infinity", "1e30", "-5", "1.5", "0x10"]) {
    assert.throws(() => x402RequirementsToIntent({ scheme: "exact", network: NET, asset: USDC, payTo: PAY, amount } as never), Error);
  }
});

import { createTwzrdCloudflareBaseApproval } from "../src/cloudflare-base.js";

const BWASH = "0x1111111111111111111111111111111111111111";
const BCLEAN = "0xfB9819456bd9248A9D3c9E12F4cb7bBda5fc2578";
const BUSDC = "0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913";
const ok = { decision: "allow", trust_score: 80, score: 80, recommended_cap_usdc: 100, wash_flagged: false };
const wash = { decision: "block", trust_score: 0, score: 0, wash_flagged: true };
const seen: string[] = [];
const intel = (async (_u: unknown, init: { body: string }) => {
  const w = JSON.parse(init.body).seller_wallet as string;
  seen.push(w);
  return new Response(JSON.stringify({ readiness_card: w === BWASH ? wash : ok }), { status: 200 });
}) as unknown as typeof fetch;
const entry = (network: string, payTo: string, amount = "1000") => ({ scheme: "exact", network, asset: BUSDC, payTo, amount });

test("Base worker: a spelling-variant Base sibling is scored, not skipped", async () => {
  for (const variant of ["BASE", "base", "eip155:8453 ", " Eip155:8453"]) {
    seen.length = 0;
    const approve = createTwzrdCloudflareBaseApproval({ fetch: intel });
    const r = await approve({ accepts: [entry("eip155:8453", BCLEAN), entry(variant, BWASH)] });
    assert.equal(r, false, variant);
    assert.ok(seen.includes(BWASH), `${variant} sibling reached intel`);
  }
});

test("Base worker: amounts that overflow Number or are malformed are refused", async () => {
  const approve = createTwzrdCloudflareBaseApproval({ fetch: intel });
  for (const amount of ["9".repeat(400), "1e30", "-1", "1.5", "Infinity"]) {
    assert.equal(await approve({ accepts: [entry("eip155:8453", BCLEAN, amount)] }), false, amount);
  }
  assert.equal(await approve({ accepts: [entry("eip155:8453", BCLEAN, "1000")] }), true);
});

test("Base worker: Solana siblings are not this Worker's to score", async () => {
  seen.length = 0;
  const approve = createTwzrdCloudflareBaseApproval({ fetch: intel });
  await approve({ accepts: [entry("eip155:8453", BCLEAN), { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC", amount: "1000" }] });
  assert.deepEqual(seen, [BCLEAN]);
});
