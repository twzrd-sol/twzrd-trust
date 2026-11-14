#!/usr/bin/env node
/**
 * Read one Solana settlement transaction from an RPC you choose and print who
 * paid whom in USDC, so you can compare it with what a TWZRD receipt binds
 * (`preimage.payer`, `preimage.settlement_tx`). See docs/verify-intel-receipt.md.
 *
 * Node standard library only. One read-only JSON-RPC call (getTransaction at
 * finalized commitment); it signs nothing and spends nothing. The answer is as
 * the RPC reports it: use an endpoint you trust, or ask two.
 *
 * Usage:
 *   node docs/proofs/examples/check-settlement.mjs <receipt.json> [rpc url]
 *
 * Exit code: 0 the transaction is finalized, succeeded, and the receipt's payer
 * paid USDC in it; 1 it does not match; 2 usage, malformed input or RPC failure.
 */
import { readFileSync } from "node:fs";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const [file, rpc = "https://api.mainnet-beta.solana.com"] = process.argv.slice(2);

function fail(message) {
  console.error(`check-settlement: ${message}`);
  process.exit(2);
}
if (!file) fail("usage: check-settlement.mjs <receipt.json> [rpc url]");

let preimage;
try {
  preimage = JSON.parse(readFileSync(file, "utf8")).preimage ?? {};
} catch (e) {
  fail(e.message);
}
const signature = String(preimage.settlement_tx ?? "");
const payer = String(preimage.payer ?? "");
if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) fail("receipt.preimage.settlement_tx is not a transaction signature");

// The leaf binds the last 32 ASCII bytes of the signature string, hex-encoded.
const anchor = Buffer.from(signature.slice(-32), "ascii").toString("hex");
const anchorMatches = anchor === String(preimage.settlement_anchor ?? "").toLowerCase();

let tx;
try {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (body.error) fail(`rpc error: ${body.error.message}`);
  tx = body.result;
} catch (e) {
  fail(`rpc request failed: ${e.message}`);
}
if (!tx) {
  console.log("transaction : not found at finalized commitment");
  process.exit(1);
}

const usdcByOwner = (list) =>
  Object.fromEntries((list ?? []).filter((b) => b.mint === USDC_MINT).map((b) => [b.owner, BigInt(b.uiTokenAmount.amount)]));
const before = usdcByOwner(tx.meta.preTokenBalances);
const after = usdcByOwner(tx.meta.postTokenBalances);
const deltas = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .map((owner) => [owner, (after[owner] ?? 0n) - (before[owner] ?? 0n)])
  .filter(([, d]) => d !== 0n);

const succeeded = tx.meta.err === null;
const payerDelta = deltas.find(([owner]) => owner === payer)?.[1] ?? 0n;

console.log(`transaction : ${signature}`);
console.log(`slot        : ${tx.slot}`);
console.log(`block time  : ${new Date(tx.blockTime * 1000).toISOString()}`);
console.log(`status      : ${succeeded ? "success" : "FAILED"} (finalized)`);
console.log(`fee payer   : ${tx.transaction.message.accountKeys[0].pubkey}`);
for (const [owner, d] of deltas) console.log(`USDC delta  : ${owner} ${d > 0n ? "+" : ""}${d}`);
console.log(`receipt     : payer ${payer}, signed at ${new Date(Number(preimage.timestamp_unix) * 1000).toISOString()}`);
console.log(`anchor      : ${anchorMatches ? "matches" : "DOES NOT MATCH"} (settlement_anchor is the last 32 characters of settlement_tx)`);
const ok = succeeded && anchorMatches && payerDelta < 0n;
console.log(`RESULT      : ${ok ? "MATCH (the receipt's payer paid USDC in the transaction the receipt names)" : "MISMATCH"}`);
process.exit(ok ? 0 : 1);
