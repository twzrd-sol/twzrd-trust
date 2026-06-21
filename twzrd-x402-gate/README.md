# twzrd-x402-gate

Buyer-side x402 **trust gate**. Run a free [TWZRD preflight](https://intel.twzrd.xyz) (`ReadinessCard`)
**before** signing USDC to any x402 merchant. Wraps `fetch` (HTTP 402) and the `@x402/mcp`
`onPaymentRequested` hook. Fail-open by default so an unreachable preflight never hard-blocks a payment.

This is the independent **pre-spend** layer — it does not settle, route, or hold funds. It works where
your code receives an exposed 402 (e.g. direct `@x402/fetch` or raw merchant calls). 

**ClawRouter / `@blockrun/clawrouter` note:** The local :8402 proxy signs internally and returns 200 (no
outer 402 is visible). Use the pre-proxy hook from the `twzrd-clawrouter` skill (explicit call before the
proxy) or an upstream `onBeforePayment` if ClawRouter exposes one. Same internalization applies to
AgentCash's `fetch` (it handles 402 internally) — verify before assuming a wrapper sees it. The MCP
`onPaymentRequested` hook covers clients that expose a payment callback.

## Install

```bash
npm install twzrd-x402-gate
```

## Usage

### Wrap any fetch that may receive a 402

```ts
import { wrapFetchWithTwzrdGate, resolveConfig } from "twzrd-x402-gate";

const gatedFetch = wrapFetchWithTwzrdGate(fetch, resolveConfig());

// On HTTP 402, the gate reads payTo from the x402 `accepts[0]`, runs preflight,
// and THROWS if policy denies. On allow it returns the original 402 so your
// x402 client attaches payment and retries as usual.
const res = await gatedFetch("https://merchant.example/paid");
```

### As the @x402/mcp payment hook

```ts
import { defaultGate } from "twzrd-x402-gate";

const client = createX402MCPClient({
  onPaymentRequested: defaultGate.onPaymentRequested, // returns false to deny
});
```

### Direct decision (no network wiring)

```ts
import { createTwzrdGate } from "twzrd-x402-gate";

const gate = createTwzrdGate();
const { approved, reason, card } = await gate.approvePayment({
  payTo: "SELLER_WALLET_FROM_402",
  resourceUrl: "https://merchant.example/paid",
  priceUsdc: 0.003,
});
if (!approved) abort(reason);
```

## Policy

A payment is **denied** when any of these hold (mirrors `scripts/twzrd_gate_agentcash_fetch.sh`):

1. `decision ∈ blockDecisions` (default: `block`)
2. `can_spend === false` — **only when `gateOnCanSpend` is true (default)**
3. `trust_score < preflightMinScore` (default: `40`)

Otherwise approved (`warn` is allowed with reason `twzrd_warn_allowed`). On preflight HTTP/network
failure the gate **fails open** (approves) unless `failOpen` is disabled.

> **ClawRouter / free-tier note:** the free preflight returns `can_spend=false` for most sellers
> (including well-known ones), so the default policy will deny most unknown ClawRouter/BlockRun
> sellers. To follow the "gate only on `decision=block`" policy documented in the `twzrd-clawrouter`
> skill, set `gateOnCanSpend: false` (or `TWZRD_GATE_ON_CAN_SPEND=false`).

## Config (overrides or env)

| Option | Env | Default |
|---|---|---|
| `intelBase` | `TWZRD_INTEL_BASE` | `https://intel.twzrd.xyz` |
| `preflightMinScore` | `TWZRD_PREFLIGHT_MIN_SCORE` | `40` |
| `blockDecisions` | `TWZRD_BLOCK_DECISIONS` | `block` |
| `failOpen` | `TWZRD_FAIL_OPEN` | `true` (`false`/`0` to disable) |
| `gateOnCanSpend` | `TWZRD_GATE_ON_CAN_SPEND` | `true` (`false`/`0` = gate only on `decision`) |
| `fetch` | — | global `fetch` |

## Why pre-spend, not post-pay

`GET /v1/intel/trust/{wallet}` is the **paid** (0.05 USDC) deep-intel surface — it is *not* a gate.
`POST /v1/intel/preflight` is the **free** `ReadinessCard` for the pre-spend decision. This package
only ever calls the free preflight; you decide whether to proceed before any USDC leaves your wallet.

## License

MIT
