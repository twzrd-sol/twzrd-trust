/** Fresh consumer of the public entry (`twzrd` from package index), not src/spend-control. */
import assert from "node:assert/strict";
import { twzrd } from "../src/index.js";

const fetch402: typeof fetch = (async () =>
  new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "solana", payTo: "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk", amount: "100000", resource: "https://m/p" }],
  }), { status: 402, headers: { "content-type": "application/json" } })) as typeof fetch;

const blocked = await twzrd.safeFetch("https://m/p", {
  fetch: fetch402, maxSpend: "0.01", allowNetworks: ["solana"],
});
assert.equal(blocked.verdict, "block");
assert.equal(blocked.signerInvocations, 0);
console.log("consumer-twzrd-safe-fetch", blocked.verdict);
