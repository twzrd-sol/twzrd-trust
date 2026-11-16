// The two payment rails, and the demo sellers' addresses on each.
//
// The USDC contract (Base) and mint (Solana) are the mainnet ones in the
// gate's USDC table. Nothing in this example moves them: the seller is a
// loopback HTTP server and the demo signer holds no key.
import { createHash } from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 text of a byte string (the alphabet Solana addresses use). */
export function base58(bytes) {
  const buf = Buffer.from(bytes);
  let n = buf.length ? BigInt(`0x${buf.toString("hex")}`) : 0n;
  let text = "";
  while (n > 0n) {
    text = BASE58_ALPHABET[Number(n % 58n)] + text;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

/**
 * A demo seller address: the sha256 of a public label, as an EVM address (the
 * last 20 bytes) or a Solana address (all 32 bytes, base58). Nobody holds a
 * key for an address made this way. RAILS below carries the results;
 * test/showcase.test.mjs derives them again.
 */
export function demoAddress(seller, railId) {
  const digest = createHash("sha256").update(`x402-guard-showcase/${seller}-seller/${railId}`).digest();
  return railId === "base" ? `0x${digest.subarray(12).toString("hex")}` : base58(digest);
}

/** A demo Solana address made the same way from `x402-guard-showcase/<label>`. Nobody holds a key for it either. */
export function demoKey(label) {
  return base58(createHash("sha256").update(`x402-guard-showcase/${label}`).digest());
}

export const RAILS = Object.freeze({
  base: Object.freeze({
    id: "base",
    title: "Base USDC",
    network: "eip155:8453",
    allowNetworks: Object.freeze(["base"]),
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    // Wrapped ETH on Base: a real token, not USDC.
    nonUsdc: "0x4200000000000000000000000000000000000006",
    sellers: Object.freeze({
      good: "0xcde0e468335d18200ff764219b14d5c8be703176",
      flagged: "0xf4c55eca802585be9a7ddc6e6989a5a596995de3",
    }),
  }),
  solana: Object.freeze({
    id: "solana",
    title: "Solana USDC",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    allowNetworks: Object.freeze(["solana"]),
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    // Wrapped SOL: a real mint, not USDC.
    nonUsdc: "So11111111111111111111111111111111111111112",
    sellers: Object.freeze({
      good: "2WBvtM5caeqGYzEsL1bpBykRBZT117YtBekYFwdrw6kw",
      flagged: "4Pp6jnLy2bXjSBJbk7hHUBxSyRc6tuWPKQpuXqNqTbSX",
    }),
    // The x402-solana seat's buyer (demoKey("buyer/solana")), and the fee payer
    // the seller names in each Solana offer's extra.feePayer, which x402-solana
    // requires (demoKey("fee-payer/solana")). The buyer and both sellers are on
    // the ed25519 curve, as a wallet's address is, so token account addresses
    // derive from them.
    buyer: "6kuZ92r2eBnqnbDmgHYmR8SmoUgMQFtXTuQre7qzaCy8",
    feePayer: "Em4M5LpQjSpvMKNdEqATth57fvUzfhXPNZYpLMqQmDbq",
  }),
});

export const RAIL_IDS = Object.freeze(Object.keys(RAILS));
