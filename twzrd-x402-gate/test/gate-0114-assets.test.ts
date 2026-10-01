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
