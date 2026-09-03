# twzrd-x402-gate — Quickstart (15 minutes, 0 USDC)

Refuses payment to a wash-flagged merchant **before your wallet signs**. Free intel, no
API key, no signup, no config — every `TWZRD_*` env var is an optional override. If intel
is unreachable the gate never *invents* a wash flag (the wash check fails open); a failed
preflight blocks the payment by default (`TWZRD_FAIL_OPEN=true` to allow).

**Pin:** `twzrd-x402-gate@0.9.3` + stock PayAI client `x402-solana@3.0.0` (official
`beforePayment` seat). `@x402/core` Path E remains supported; refuse script is fallback.

## 1. Stock PayAI client (default seat — copy-paste)

```bash
npm install twzrd-x402-gate@0.9.3 x402-solana@3.0.0
```

> **ESM-only.** The package ships `import` conditions only — a CommonJS
> `require()` (e.g. a default `npm init -y` project without `"type": "module"`)
> fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Set `"type": "module"` in your
> package.json, use `.mjs`, or bundle ESM.

```typescript
import { createX402Client } from "x402-solana";
import { createTwzrdBeforePaymentHook } from "twzrd-x402-gate";

const client = createX402Client({
  wallet,
  network: "solana",
  beforePayment: createTwzrdBeforePaymentHook({ refuseWashFlagged: true }),
});
```

Equivalent: `beforePayment: installTwzrdAutoGate("x402-solana", { refuseWashFlagged: true })`.
Then: `await client.fetch("https://merchant.example/paid");`

## 1b. Official `@x402/core` client (Path E)

```bash
npm install twzrd-x402-gate@0.9.3 @x402/core @x402/fetch @x402/svm
```

```typescript
import { x402Client } from "@x402/core/client";
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const client = new x402Client();
// refuseWashFlagged defaults true; gateOnCanSpend stays false unless you opt in
installTwzrdAutoGate(client, { refuseWashFlagged: true });
// then register schemes + wrapFetchWithPayment as usual
```

## 2. Prove it blocked something (spends nothing)

```bash
# Stock-client seat proof (beforePayment, signer_invocation_count=0)
# needs x402-solana@3.0.0 installed - the harness fallback runs but does not
# clear closure (its negative arm counts a would-be sign)
npm run x402-solana-before-payment-proof
# writes block-proof-<run_id>.json — hook: beforePayment

# @x402/core Path E proof (onBeforePaymentCreation)
npm run autogate-block-proof
```

That JSON is your receipt: a bad merchant intercepted with 0 USDC at risk.

Both proofs resolve their bad-seller fixture live: a `wash_flagged` merchant when
one is available, else a live `decision=block` seller (the wash overlay is
corpus-derived and drifts). The proof's public abort reason differs by basis:
`TWZRD_TRUST_GATE_BLOCK: wash_flagged` (wash) vs
`TWZRD_TRUST_GATE_BLOCK: decision_block` (readiness decision). The raw hook
abort string is prefixed `[twzrd]` — treat any reason matching
`TWZRD_TRUST_GATE_BLOCK|twzrd_decision_block|twzrd_wash_flagged` as a gate refuse.

**Fallback only:** `npx twzrd-gate-eval-refuse` / `npm run gate-eval-refuse` still works for
CLI smoke, but it is **not** the primary install story — agents that only summarize
`next_action.command` without seating a gate on a signer path never clears W1.

## 3. See your own seat

Every preflight is stamped `X-Twzrd-Caller: twzrd-x402-gate/<version>` — your seat
identity in TWZRD's metrics. To make runs attributable to *you* (recommended):

```typescript
createTwzrdBeforePaymentHook({
  refuseWashFlagged: true,
  attribution: { integration: "<your-host-or-project>", runId: "<uuid-per-run>" },
});
```

## 3b. Turn on Path A (buyer cash, not the rail)

Refuse stays free until you wire a paying fetch. Then warn + material amount
buys the $0.05 V6 (or $0.001 quick below $2.50). Facilitator settle hooks stay
free.

```typescript
import { wrapFetchWithPayment } from "@x402/svm";

const x402Fetch = wrapFetchWithPayment(fetch, wallet);
createTwzrdBeforePaymentHook({
  refuseWashFlagged: true,
  x402Fetch, // Path A defaults on
  // requireReceipt: false, escalateOnWarn: false  // opt out
});
```

`installTwzrdAutoGate((g) => wrapFetchWithPayment(g, wallet))` auto-wires the
payWrap as `x402Fetch`.

## 4. The only three knobs you need

| Knob | Effect |
|------|--------|
| `TWZRD_AUTO_GATE=0` | Kill switch — gate fully off, payments proceed unguarded. Read per call on the x402-client / x402-solana / MPP seats; the fetch (payWrap) seat resolves it once when the fetch is composed, in both directions — rebuild the fetch to change it. |
| `refuseWashFlagged: false` | Stop refusing wash-flagged merchants (default `true`) |
| `gateOnCanSpend: true` | Opt-in hard cap: also block when `can_spend=false` (default `false`) |

Everything else (thresholds, wash caps, fail posture, settle guard): [README](./README.md).

## What this will NOT do

- **No Base/EVM reputation.** Non-Solana networks get an explicit `unknown` (payment
  allowed, observed) unless you set `TWZRD_UNSUPPORTED_NETWORK_MODE=strict`.
- **No delivery guarantee.** It screens the merchant before you pay, nothing after.
- **Not a wallet.** It never holds keys or signs — it only decides if your signer runs.
