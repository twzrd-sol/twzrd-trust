/**
 * twzrd.safeFetch `allowNetworks`: an offer is on an allowed network only when
 * its network id is that network, in full.
 *
 * The check was a substring test. `allowNetworks: ["eip155:1"]` let a seller's
 * eip155:137 offer through, and "eip155:8453" or "base" let eip155:84532
 * through, so a buyer who had narrowed payments to one chain signed for
 * another.
 *
 * Run: npx tsx --test test/spend-control-allow-networks.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMemorySpendLedger } from "../src/policy-runtime.js";
import { twzrd } from "../src/spend-control.js";

const EVM_SELLER = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const SOL_SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const BASE_USDC = "0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const URL_PAID = "https://merchant.example/paid";

const evm = (network: string, over: Record<string, unknown> = {}) => ({
  scheme: "exact", network, payTo: EVM_SELLER, amount: "1000", asset: BASE_USDC, resource: URL_PAID, ...over,
});
const sol = (network: string) => ({
  scheme: "exact", network, payTo: SOL_SELLER, amount: "1000", asset: SOL_USDC, resource: URL_PAID,
});

async function call(allowNetworks: string[], accepts: Array<Record<string, unknown>>) {
  const paid: Array<{ paymentRequired: unknown; selected: Record<string, unknown> }> = [];
  const result = await twzrd.safeFetch(URL_PAID, {
    fetch: (async () =>
      new Response(JSON.stringify({ x402Version: 2, accepts }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    maxSpend: "0.01",
    allowNetworks,
    ledger: createMemorySpendLedger(),
    pay: async (args) => {
      paid.push({ paymentRequired: args.paymentRequired, selected: args.selected });
      return { response: new Response("paid", { status: 200 }) };
    },
  });
  return { result, paid };
}

test("an allowed network id does not admit an id that merely contains it", async () => {
  const cases: Array<[string[], Record<string, unknown>]> = [
    [["eip155:1"], evm("eip155:137")],
    [["eip155:1"], evm("eip155:10")],
    [["eip155:1"], evm("eip155:11155111")],
    [["eip155:8453"], evm("eip155:84532")],
    [["eip155:8453"], evm("eip155:18453")],
    [["base"], evm("eip155:84532")],
    [["base"], evm("base-sepolia")],
    [["base"], evm("eip155:137", { resource: "https://merchant.example/base/8453" })],
    [["polygon"], evm("polygon-amoy")],
    [["eip155"], evm("eip155:137")],
    [["solana"], evm("eip155:137?solana")],
    [[""], evm("eip155:137")],
  ];
  for (const [allow, offer] of cases) {
    const label = `${JSON.stringify(allow)} vs ${String(offer.network)}`;
    const { result, paid } = await call(allow, [offer]);
    assert.equal(result.verdict, "block", label);
    assert.equal(result.reason, "network_not_allowed", label);
    assert.equal(result.signerInvocations, 0, label);
    assert.equal(paid.length, 0, label);
  }
});

test("the same network under another spelling, and the family aliases, are still admitted", async () => {
  const cases: Array<[string[], Record<string, unknown>]> = [
    [["eip155:8453"], evm("eip155:8453")],
    [["eip155:8453"], evm("base")],
    [["eip155:8453"], evm("BASE-MAINNET")],
    [["base"], evm("eip155:8453")],
    [["Base "], evm(" EIP155:8453")],
    [["evm"], evm("eip155:8453")],
    [["solana"], sol("solana")],
    [["solana"], sol("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")],
    [["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], sol("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")],
    [["eip155:1", "solana"], sol("solana")],
  ];
  for (const [allow, offer] of cases) {
    const label = `${JSON.stringify(allow)} vs ${String(offer.network)}`;
    const { result } = await call(allow, [offer]);
    assert.notEqual(result.reason, "network_not_allowed", label);
  }
});

test("a 402 that mixes an allowed network with a look-alike pays the allowed entry only", async () => {
  const { result, paid } = await call(["eip155:8453"], [
    evm("eip155:84532", { payTo: "0x1111111111111111111111111111111111111111", amount: "9000" }),
    evm("eip155:8453"),
  ]);
  assert.notEqual(result.reason, "network_not_allowed");
  for (const p of paid) {
    assert.equal(p.selected.network, "eip155:8453");
    const offered = (p.paymentRequired as { accepts: Array<{ network: string; payTo: string }> }).accepts;
    assert.deepEqual(offered.map((o) => o.network), ["eip155:8453"]);
    assert.equal(offered[0].payTo, EVM_SELLER);
  }
});
