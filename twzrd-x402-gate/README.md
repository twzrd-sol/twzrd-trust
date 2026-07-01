# twzrd-x402-gate

Agent-side x402 **firewall**. TWZRD sits in the path before any 402 payment leaves your
agent's wallet — free preflight decides `allow / warn / block` before USDC moves.

```typescript
import { withTwzrdGuard } from "twzrd-x402-gate";

const safeFetch = withTwzrdGuard(myX402Fetch);
// Every 402 intercepted → free TWZRD preflight → throws on block, proceeds on warn/allow.
```

## Install

```bash
npm install twzrd-x402-gate
```

## Quickstart: `withTwzrdGuard`

Wrap any fetch that will receive x402 responses. The guard intercepts every HTTP 402, runs a
free TWZRD preflight on the seller wallet, and throws `[twzrd] blocked: ...` before your
wallet signs anything.

```typescript
import { withTwzrdGuard } from "twzrd-x402-gate";
import { createAgentcashFetch } from "agentcash";

// Pass the x402-capable fetch IN — the guard sits upstream of it.
const x402Fetch = createAgentcashFetch({ apiKey: process.env.AGENTCASH_API_KEY });
const safeFetch = withTwzrdGuard(x402Fetch);

// Use safeFetch everywhere you'd call a paid resource:
const response = await safeFetch("https://api.exa.ai/search");
```

What the guard does on HTTP 402:
1. Reads the Solana-network entry from `accepts[]` (falls back to first entry) to get the seller wallet.
2. Calls `POST /v1/intel/preflight` — free, no auth.
3. `decision=block` - throws `[twzrd] blocked: ...`.
4. `decision=warn` or `allow` - returns the original 402 for the x402 client to pay.

Non-402 responses pass through unchanged.

### Auto-receipt on warn (revenue path)

```typescript
const safeFetch = withTwzrdGuard(x402Fetch, {
  autoReceipt: true,   // on warn or allow, auto-buy the $0.05 TWZRD trust receipt
  x402Fetch,           // the paying fetch — TWZRD earns the fee on-chain
  onReceipt: (receipt, tx) => {
    // receipt is a twzrd_receipt (V6 + ERC-8004 reputation_credential)
    console.log("Trust receipt captured:", tx);
  },
});
```

`autoReceipt` is **off by default** — it spends the **buyer's** USDC, so you opt in. When on,
every warn/allow verdict settles $0.05 USDC to TWZRD and returns a signed V6 trust credential
for the counterparty before you pay the resource.

**`x402Fetch` is yours to supply** (this package is dependency-free). Wire the proven
`@x402/svm` sponsored-feePayer client — the same one `twzrd-mcp-server` uses:

```typescript
import { wrapFetchWithPayment } from "@x402/svm";
const x402Fetch = wrapFetchWithPayment(fetch, buyerWallet); // settles 402 challenges
```

Gate it behind your own ROI policy (e.g. only auto-buy the receipt for payments above a
threshold). Runnable, no-spend demo: [`examples/auto-receipt.ts`](./examples/auto-receipt.ts)
(`npm run autoreceipt-demo`). A bundled/sponsored `x402Fetch` (so integrators need no wallet)
is the next step.

### Quick tier ($0.001) — cheap paid qualify

The reputation ladder has three rungs: **free** preflight (`allow/warn/block`), **$0.001**
`quickCheck` (tier + score, no receipt), **$0.05** `autoReceipt` (full intel + signed V6
receipt). When the free preflight is inconclusive (`warn` / unknown seller) and you want a
cheap *paid* confirmation before committing — without paying 50× for the portable receipt —
use `quickCheck`:

```typescript
import { quickCheck } from "twzrd-x402-gate";

const q = await quickCheck(sellerWallet, { x402Fetch }); // settles $0.001 to /v1/intel/quick
if (q.available && (q.tier === "Gold" || q.tier === "Platinum")) {
  // tier is high enough — proceed with the larger payment
}
```

`quickCheck` is **fail-soft** — it never throws; any gap (no `x402Fetch`, unreachable, settle
failure) returns `available: false`, so a quick-tier hiccup can't break your flow. The hard
allow/warn/block decision stays the free preflight's job.

### Autonomous risk-escalation — `escalateOnWarn` (pay-to-confirm on warn)

The free preflight leaves an unknown/uncertain seller at `warn`, which **proceeds** by
default. `escalateOnWarn` closes the loop autonomously: on a proceeding `warn`, the guard
settles the cheap **$0.001** quick tier and **re-decides on the paid score** — below the
floor the payment is **blocked**, at/above it proceeds. The paid call fires from your
agent's own risk policy (no human), and the paid signal actually gates the spend (unlike
`autoReceipt`, which is upsell-only and never changes the decision).

```ts
const safeFetch = withTwzrdGuard(x402Fetch, {
  escalateOnWarn: {
    minSpendUsdc: 0.01,   // don't pay $0.001 to vet a sub-cent buy
    blockBelowScore: 40,  // block when the paid quick score is below this (default: preflightMinScore)
  },
  x402Fetch,              // settles the $0.001 quick charge
});
// warn + paid score < 40  -> throws "[twzrd-guard] payment blocked: twzrd_escalated_warn_block ..."
// warn + paid score >= 40 -> proceeds (result.escalated=true, result.escalatedScore set)
```

Opt-in, **fail-soft** (if the quick tier can't answer, the base `warn` is preserved), and it
**only tightens** — a `warn` may become a block, but an `allow` or `block` is never changed.
This is the autonomous demand loop: an uncertain counterparty is vetted with real paid intel,
automatically, before your agent commits.

### Sponsored payer — use the paid rungs with no wallet (prototype)

`createSponsoredX402Fetch` lets a **sponsor** settle the paid rungs on the agent's behalf, so
an integrator can call `quickCheck` / `autoReceipt` with **no wallet of their own**:

```typescript
import { createSponsoredX402Fetch, quickCheck } from "twzrd-x402-gate";

// `settle` = the funded backend (your @x402/svm fetch, or a TWZRD treasury sponsor endpoint).
const x402Fetch = createSponsoredX402Fetch({ settle });
const q = await quickCheck(seller, { x402Fetch }); // sponsor pays — caller holds no wallet
```

Two backends plug into `settle`: **gas-sponsored** (live via `@x402/svm` — agent pays USDC, the
resource server's `feePayer` covers SOL gas, the model `twzrd-mcp-server` uses) and
**full-sponsor** (a TWZRD treasury endpoint pays on the agent's behalf — the true no-wallet
path). The full-sponsor endpoint + treasury is **founder-gated** (who funds it + per-agent
budget caps); this ships the client seam + a dry-run so the wiring is ready.
No-spend demo: [`examples/sponsored-payer.ts`](./examples/sponsored-payer.ts) (`npm run sponsored-demo`).

## `evaluate_x402_resource` — standalone preflight

Use when you already have the `paymentRequirements` object from a parsed 402 body:

```typescript
import { evaluate_x402_resource } from "twzrd-x402-gate";

const result = await evaluate_x402_resource(
  "https://api.exa.ai/search",
  paymentRequirements, // X402PaymentRequirements from the 402 body
);

console.log(result.decision);    // "allow" | "warn" | "block"
console.log(result.trustScore);  // number | null
console.log(result.approved);    // boolean
console.log(result.receiptUrl);  // "https://intel.twzrd.xyz/v1/intel/trust/<payTo>"

if (!result.approved) throw new Error(`Blocked: ${result.reason}`);
```

With `autoReceipt`:

```typescript
const result = await evaluate_x402_resource(url, requirements, {
  autoReceipt: true,
  x402Fetch: myPayingFetch,
  onReceipt: (receipt, tx) => storeCredential(receipt),
});
// result.receipt — twzrd_receipt (V6 + ERC-8004 reputation_credential)
// result.receiptTx — on-chain settlement tx
// result.receiptFeeCaptured — true when fee landed
```

## Lower-level APIs

### Direct approval call

```typescript
import { createTwzrdGate } from "twzrd-x402-gate";

const gate = createTwzrdGate();
const { approved, reason, card } = await gate.approvePayment({
  payTo: "SELLER_WALLET_FROM_402",
  resourceUrl: "https://merchant.example/paid",
  priceUsdc: 0.003,
});
if (!approved) abort(reason);
```

### `@x402/mcp` payment hook

```typescript
import { defaultGate } from "twzrd-x402-gate";

const client = createX402MCPClient({
  onPaymentRequested: defaultGate.onPaymentRequested, // returns false to deny
});
```

### `wrapFetchWithTwzrdGate`

```typescript
import { wrapFetchWithTwzrdGate, resolveConfig } from "twzrd-x402-gate";

// Alternative fetch wrapper — same interception logic, no autoReceipt.
const gatedFetch = wrapFetchWithTwzrdGate(fetch, resolveConfig());
```

`withTwzrdGuard` is preferred — it composes with `autoReceipt` and `onReceipt`.
`wrapFetchWithTwzrdGate` remains for codebases that can't migrate.

## Policy

A payment is **blocked** when:
1. `decision ∈ blockDecisions` (default: `["block"]`)
2. `trust_score < preflightMinScore` (default: `40`)
3. `can_spend === false` — **only** when `gateOnCanSpend: true` (default `false`, opt-in)

`warn` is allowed unless overridden. Preflight network failure **fails closed** by default (a preflight outage blocks the payment, so an intel hiccup never silently approves a spend); set `failOpen: true` / `TWZRD_FAIL_OPEN=true` to opt into legacy allow-on-outage.

> **`can_spend` note:** the free preflight returns `can_spend=false` for most sellers
> not yet in the TWZRD corpus, including legitimate ones. The default is decision-only
> gating so unknown sellers on platforms like Agentic.Market are not blocked by default.
> Set `gateOnCanSpend: true` for strict mode.

## Config

| Option | Env | Default | Description |
|---|---|---|---|
| `intelBase` | `TWZRD_INTEL_BASE` | `https://intel.twzrd.xyz` | Preflight API base |
| `preflightMinScore` | `TWZRD_PREFLIGHT_MIN_SCORE` | `40` | Block below this score |
| `blockDecisions` | `TWZRD_BLOCK_DECISIONS` | `block` | Decisions that throw |
| `failOpen` | `TWZRD_FAIL_OPEN` | `false` | `true` opts into legacy allow-on-outage; default blocks (fail-closed) |
| `gateOnCanSpend` | `TWZRD_GATE_ON_CAN_SPEND` | `false` | Also block when `can_spend=false` |
| `autoReceipt` | — | `false` | Auto-buy $0.05 TWZRD receipt on warn/allow |
| `x402Fetch` | — | — | x402-capable fetch for `autoReceipt` |
| `onReceipt` | — | — | Callback after receipt is captured |

## Compatibility note

**Proxied x402 clients** (AgentCash's `.fetch`, ClawRouter `:8402`): these clients handle
402 internally and return 200. The guard never sees a 402. Pass the raw (non-paying) fetch
to `withTwzrdGuard`, then wrap its output in your x402 client. Or call
`evaluate_x402_resource` explicitly before routing through the proxy.

## Why pre-spend, not post-pay

`GET /v1/intel/trust/{wallet}` is the **paid** ($0.05 USDC) deep-intel surface — not a gate.
`POST /v1/intel/preflight` is the **free** `ReadinessCard` for the pre-spend decision.
This package only ever calls the free preflight; you decide whether to proceed before any
USDC leaves your wallet.

## License

MIT
