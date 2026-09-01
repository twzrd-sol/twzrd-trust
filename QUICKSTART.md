# Quickstart — spend control for an x402 agent in 10 minutes

TWZRD is the spend-control layer for agents that pay over [x402](https://x402.org)
on Solana (and Base). One call wraps any paid fetch: it intercepts the 402,
decides **allow / warn / block** against your policy *before anything is
signed*, lets **your** wallet sign (TWZRD never holds keys), and binds the
settled payment to the exact offer it paid for — a receipt any third party can
verify from public chain data.

Every code sample below was executed against the published package and live
endpoints before this document was committed.

## 1. Install

```bash
npm install twzrd-x402-gate@0.9.2 x402-solana@3.0.0
```

## 2. First call — nothing to configure

A URL that isn't a 402 passes straight through. A 402 beyond your policy is
blocked **with zero signer invocations** — the block happens before any wallet
code runs:

```js
import { twzrd } from "twzrd-x402-gate";

// Free endpoints pass through untouched
const free = await twzrd.safeFetch("https://intel.twzrd.xyz/health", {
  maxSpend: "0.01",
});
// free.verdict === "allow", free.signerInvocations === 0, free.response.status === 200

// A live 402 over your cap is refused before signing
const gated = await twzrd.safeFetch(
  "https://intel.twzrd.xyz/v1/intel/quick/35ramn32ufUApgbcgopVe5muHqNftHN1L3BfBNsDzGsx",
  { maxSpend: "0.0001", allowNetworks: ["solana"] },
);
// gated.verdict === "block", gated.reason === "over_max_spend",
// gated.signerInvocations === 0  — your wallet was never asked to sign
```

## 3. Let it pay — your wallet, injected

TWZRD never holds or sees keys. You pass a `pay` callback; it is invoked only
after the policy gate allows, and `signerInvocations` counts exactly how many
times your signer was reached:

```js
import { twzrd } from "twzrd-x402-gate";

// ── 1. Target & Payment Handler ──────────────────────────────────────
// Target x402 resource (supply the endpoint you are calling):
const targetUrl = "https://intel.twzrd.xyz/v1/intel/quick/35ramn32ufUApgbcgopVe5muHqNftHN1L3BfBNsDzGsx";

// Wire your x402 signing client here (e.g. @x402/fetch or x402-solana).
// The pay callback receives the 402 payment requirements and selected offer:
const payHandler = async ({ url, paymentRequired, selected }) => {
  // [SUPPLY YOUR WALLET/SIGNER HERE]:
  // Perform the payment with your keypair and return { transactionBase64, response }
  // Example with a custom client:
  // return await myWallet.payX402(url, paymentRequired, selected);

  const response = await fetch(url);
  return {
    transactionBase64: undefined, // base64 wire transaction if settle proof is required
    response,
  };
};

// ── 2. Execute safeFetch with spend controls ────────────────────────
const result = await twzrd.safeFetch(targetUrl, {
  maxSpend: "0.10",                  // per-call cap AND cumulative budget (same number)
  allowNetworks: ["solana", "base"], // allowed payment networks
  requireOfferBinding: false,        // set true to require a chain-verifiable bind-v1 receipt
  agentId: "my-agent",               // ledger key
  ledgerFile: "./spend-ledger.jsonl",// durable hash-chained spend record (optional)
  pay: payHandler,
});

console.log("Verdict:", result.verdict);                     // "allow" | "warn" | "block"
console.log("Signer invocations:", result.signerInvocations); // 0 on block, 1 on allowed pay
```

With `requireOfferBinding: true`, the settled transaction is decoded and the
payment's memo + transfer legs are checked against the offer that was scored.
`strength: "hard"` means the binding is provable from chain data alone.

## 4. What the policy enforces

- **`maxSpend`** — both the per-call cap and the cumulative budget, tracked
  per agent, per merchant, and per mandate. Over-budget blocks before signing.
- **`allowNetworks`** — offers on other networks never reach selection.
- **Merchant intel** (optional `preflight`) — wire in TWZRD's free scoring
  (`https://intel.twzrd.xyz/v1/intel/preflight`) and wash-flagged sellers
  return `block` before payment; borderline ones return `warn`.
- **`requireOfferBinding`** — no verifiable receipt, no allow.

Blocks are always `signerInvocations: 0`. Prompt injection cannot renegotiate
caps that sit outside the model's reach.

## 5. Verify a receipt yourself — no trust in TWZRD required

Every bind-v1 receipt is checkable by anyone from public data:

```bash
curl -s -X POST https://intel.twzrd.xyz/v1/intel/resource_bind/verify \
  -H 'content-type: application/json' \
  -d '{"signature": "<settled tx signature>", "paymentRequired": <the 402 JSON>}'
# → { "strength": "hard", "evidence_level": "tx_included", ... }
```

Or reimplement the leaf from the spec and recompute it — the whole procedure,
with real mainnet transactions to check against, is in [REVIEW.md](./REVIEW.md).
Two independent external implementations have already reproduced it.

## Where things live

| Thing | Where |
|---|---|
| This SDK on npm | `twzrd-x402-gate` (named export `twzrd`) |
| Implementation + tests | [`twzrd-x402-gate/`](./twzrd-x402-gate/) in this repo |
| External review map, mainnet ground truth | [REVIEW.md](./REVIEW.md) |
| The 7-day integration milestone | [MILESTONE.md](./MILESTONE.md) |
| Live verifier + merchant intel | `https://intel.twzrd.xyz` (free) |

Questions or a broken sample: open an issue on this repo. A sample that does
not run exactly as shown is a bug.
