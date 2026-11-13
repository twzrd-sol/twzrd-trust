/**
 * Base Worker seat: a 402 is approved only when every entry the EVM signer
 * could pay is a Base entry that was scored.
 *
 * The seat scored the Base entries and then approved the whole 402. The client
 * behind it signs any exact-EVM entry and takes the first one it can pay. A
 * seller that put an Ethereum-mainnet offer to its own address first and a
 * clean Base offer second had the clean one scored and the mainnet one signed.
 *
 * Run: npx tsx --test test/cloudflare-base-unvetted-offer.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTwzrdCloudflareBaseApproval,
  TwzrdBasePaymentBlockedError,
  withTwzrdBasePreflight,
} from "../src/cloudflare-base.js";

const ATTACKER = "0x1111111111111111111111111111111111111111";
const CLEAN = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const BASE_USDC = "0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913";
const MAINNET_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SOLANA_SELLER = "7G73PLhKvAPBGTzG5ESAE4coE7QrVeTTKfhTxQZbyGgC";

const cleanBase = { scheme: "exact", network: "eip155:8453", payTo: CLEAN, amount: "1000", asset: BASE_USDC };
const mainnet = { scheme: "exact", network: "eip155:1", payTo: ATTACKER, amount: "50000", asset: MAINNET_USDC };

/** Intel that allows every seller it is asked about, and records who it was asked about. */
function allowAll() {
  const asked: string[] = [];
  const intelFetch = (async (_url: unknown, init: { body: string }) => {
    asked.push(JSON.parse(init.body).seller_wallet as string);
    return new Response(
      JSON.stringify({
        readiness_card: { decision: "allow", trust_score: 90, score: 90, recommended_cap_usdc: 100, wash_flagged: false },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { asked, fetch: intelFetch };
}

async function decide(accepts: unknown[], failOpen = false) {
  const intel = allowAll();
  const requirements = { resource: "https://worker.example/paid-tool", accepts: accepts as Array<Record<string, unknown>> };
  const approved = await createTwzrdCloudflareBaseApproval({ fetch: intel.fetch, failOpen })(requirements);
  let signed = 0;
  let reasons: string[] | undefined;
  try {
    await withTwzrdBasePreflight(requirements, { fetch: intel.fetch, failOpen }, async () => {
      signed += 1;
    });
  } catch (error) {
    assert.ok(error instanceof TwzrdBasePaymentBlockedError, String(error));
    reasons = error.verdict.reasons;
  }
  return { approved, signed, reasons, asked: intel.asked };
}

test("the reported 402: an Ethereum-mainnet offer ahead of a clean Base offer is refused", async () => {
  const r = await decide([mainnet, cleanBase]);
  assert.equal(r.approved, false);
  assert.equal(r.signed, 0);
  assert.deepEqual(r.reasons, ["unvetted_payment_option"]);
  assert.deepEqual(r.asked, [], "refused on the offer's shape, before intel");
});

test("the position of the unvetted entry does not matter, and failOpen does not sign it", async () => {
  for (const accepts of [[cleanBase, mainnet], [cleanBase, cleanBase, mainnet]]) {
    const r = await decide(accepts, true);
    assert.equal(r.approved, false);
    assert.equal(r.signed, 0);
    assert.deepEqual(r.reasons, ["unvetted_payment_option"]);
  }
});

test("every entry an EVM signer could pay that is not Base refuses the 402", async () => {
  const at = (entry: Record<string, unknown>) => ({ scheme: "exact", payTo: ATTACKER, amount: "50000", ...entry });
  const cases: Array<[string, unknown]> = [
    ["eip155:137", at({ network: "eip155:137" })],
    ["spelling variant of another chain", at({ network: " EIP155:1 " })],
    ["v1 name: ethereum", at({ network: "ethereum" })],
    ["v1 name: polygon", at({ network: "polygon" })],
    ["v1 name: base-sepolia", at({ network: "base-sepolia" })],
    ["an unrecognized name", at({ network: "mainnet" })],
    ["no network", at({})],
    ["an empty network", at({ network: "" })],
    ["chainId of another chain", at({ chainId: 1 })],
    ["an array network", at({ network: ["eip155:8453"] })],
    ["a Base network with another chain id", at({ network: "eip155:8453", chainId: 1 })],
    ["another network with the Base chain id", at({ network: "eip155:1", chainId: 8453 })],
    ["a Solana name with a chain id", at({ network: "solana", chainId: 1 })],
    ["null", null],
    ["a string", "eip155:8453"],
    ["an array", [cleanBase]],
  ];
  for (const [label, entry] of cases) {
    const r = await decide([entry, cleanBase]);
    assert.equal(r.approved, false, label);
    assert.equal(r.signed, 0, label);
    assert.deepEqual(r.reasons, ["unvetted_payment_option"], label);
  }
});

test("Base entries, alone or beside a rail an EVM signer cannot pay, are still scored and approved", async () => {
  const solanaV2 = { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: SOLANA_SELLER, amount: "1000" };
  const solanaV1 = { scheme: "exact", network: "solana", payTo: SOLANA_SELLER, amount: "1000" };
  const otherRail = { scheme: "exact", network: "stellar:pubnet", payTo: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", amount: "1000" };
  const cases: Array<[string, unknown[]]> = [
    ["Base alone", [cleanBase]],
    ["Base by chain id", [{ scheme: "exact", chainId: 8453, payTo: CLEAN, amount: "1000" }]],
    ["Base by network and chain id", [{ ...cleanBase, chainId: "8453" }]],
    ["Base by v1 name", [{ ...cleanBase, network: "BASE" }]],
    ["two Base entries", [cleanBase, { ...cleanBase, amount: "2000" }]],
    ["Solana sibling first", [solanaV2, cleanBase]],
    ["v1 Solana sibling", [cleanBase, solanaV1]],
    ["another non-EVM rail", [otherRail, cleanBase]],
  ];
  for (const [label, accepts] of cases) {
    const r = await decide(accepts);
    assert.equal(r.approved, true, label);
    assert.equal(r.signed, 1, label);
    assert.ok(r.asked.length > 0 && r.asked.every((wallet) => wallet === CLEAN), `${label}: only Base sellers reach intel`);
  }
});

test("a 402 with no Base entry is still refused", async () => {
  for (const accepts of [[mainnet], [{ scheme: "exact", network: "solana", payTo: SOLANA_SELLER, amount: "1000" }], []]) {
    const r = await decide(accepts);
    assert.equal(r.approved, false);
    assert.equal(r.signed, 0);
  }
});
