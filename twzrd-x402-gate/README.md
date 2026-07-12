# twzrd-x402-gate

**TWZRD is the default `onBeforePaymentCreation` policy engine for official x402 clients.**

Agent-side firewall: after the client selects the exact payment requirement and **before**
payment payload creation / wallet signing — free preflight + merchant_card wash refuse.
Chain-neutral envelope; **Solana-deep** reputation only (Base/EVM = explicit `unknown`).

## Canonical integration (official x402 client)

```typescript
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { installTwzrdX402ClientHook } from "twzrd-x402-gate";

const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(svmSigner));
// Optional: client.register("eip155:*", new ExactEvmScheme(evmSigner));

installTwzrdX402ClientHook(client, {
  gateOnCanSpend: false, // decision-only default (warn allowed)
  refuseWashFlagged: true,
});
// Strict opt-in: gateOnCanSpend: true — also block when can_spend=false

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
await fetchWithPayment("https://merchant.example/paid");
```

```text
official x402 client receives 402
  → selects exact requirement
  → onBeforePaymentCreation
  → TWZRD (network + payTo + amount + resource)
  → local policy allow | warn | block
  → agent-owned wallet signs same requirement
```

No AgentCash. No marketplace. No second probe. No TWZRD custody.

### MCP (`@x402/mcp`)

Wire `twzrdOnPaymentRequested` / prefer `onPaymentRequired` + `onBeforePayment` per
[lifecycle hooks](https://docs.x402.org/advanced-concepts/lifecycle-hooks). Same policy core.

### Raw-fetch composition (injectible pay client only)

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";
import { wrapFetchWithPayment } from "@x402/fetch"; // or @x402/svm helper

// Guard RAW fetch, then hand to a client that still surfaces 402 to the guard layer
// — OR prefer installTwzrdX402ClientHook on x402Client (above).
const payingFetch = installTwzrdAutoGate((guarded) =>
  wrapFetchWithPayment(guarded, client),
);
```

## Buyer flow (trustless, fail-open) — locked sequence

Canonical path for every agent that spends USDC on Solana x402:

| Step | Call | Cost | What gates pay |
|------|------|------|----------------|
| 1 | `POST /v1/intel/preflight` | free | `decision=block` → refuse (`twzrd_decision_block`). Score floor / optional `can_spend` also deny. |
| 2 | `GET /v1/intel/merchant_card/{payTo}` | free | `wash_flagged: true` → refuse by default (`twzrd_wash_flagged`). **Only tightens** step 1. |
| 3 | Optional paid trust | $0.05 / $0.001 | On `warn` or high-value: `GET /v1/intel/trust/{payTo}` or `quickCheck`. Never required for the free refuse path. |
| 4 | Pay (or refuse) | resource price | Only if steps 1–2 approved (and any opt-in paid escalate did not block). |

**Fail-open (no invent):**
- Preflight HTTP/network error → default fail-closed in gate 0.2+ (`TWZRD_FAIL_OPEN=true` restores legacy allow-on-outage).
- Merchant card unreachable / non-2xx / missing `wash_flagged` → `washFlagged=null` → **do not refuse on wash** (preflight decision stands).
- Only a successful card with `wash_flagged: true` triggers wash refuse or soft cap.

**Wash policy (exact):**
- Prior preflight deny → unchanged (wash never loosens a block).
- `refuseWashFlagged=false` or wash not true → keep preflight approval.
- `wash_flagged=true` + no cap → `approved=false`, `reason=twzrd_wash_flagged`, `verdict=block`.
- `wash_flagged=true` + `washMaxUsdc` set + `priceUsdc <= cap` → allow, `washCapped=true`, reason `twzrd_wash_capped_{price}_le_{cap}`.
- `wash_flagged=true` + price above cap (or price unknown) → refuse with `twzrd_wash_flagged_above_cap_*`.

**Order note:** `onWarnUpsell` (points at paid `/trust`) fires on preflight `warn` **before** the merchant_card wash check. A wash-flagged seller that preflighted as `warn` may still get the upsell hook, then be refused on step 2.

Dogfood:
- Free only (wash refuse): `npm run wash-dogfood` → [`examples/wash-refuse-dogfood.ts`](./examples/wash-refuse-dogfood.ts)
- Official client + Path E hook (live Solana ≤$0.001): `npm run official-dogfood` → [`examples/official-x402-dogfood.ts`](./examples/official-x402-dogfood.ts). Needs `@x402/fetch` `@x402/svm` `@x402/core` `@solana/kit` `@scure/base` and a funded Solana key (`SVM_KEYPAIR_PATH` or `~/.agentcash/solana-wallet.json`). `--block` exercises hard `gateOnCanSpend` abort with $0 spend.

## Install

```bash
npm install twzrd-x402-gate
```

### Experimental CLI: `twzrd-safe-fetch` (AgentCash advisory pre-check)

> **Not a challenge-bound firewall.** Classification: `advisory_precheck`.
>
> AgentCash CLI internalizes 402 handling. This tool can only decide whether to
> **invoke** AgentCash after scoring a **probe** challenge. AgentCash then makes a
> **second** request and may sign a different recipient/network/amount (TOCTOU).
> JSON output always sets `requirementScoredMatchesRequirementSigned: false`.
>
> Secure integrations: `installTwzrdAutoGate` over **raw** fetch + injectible pay
> client, or `twzrdOnPaymentRequested` (MCP). Do **not** wrap AgentCash's paying
> fetch with `withTwzrdGuard`.

```bash
# Advisory: block AgentCash invocation when can_spend=false
npx twzrd-safe-fetch https://example/paid --gate-on-can-spend --payment-network solana --json

# Dry-run: preflight only, zero USDC
npx twzrd-safe-fetch 'https://intel.twzrd.xyz/v1/intel/quick/<pubkey>' --dry-run --json
```

```text
probe request → TWZRD scores challenge A → (if allowed) AgentCash request → may sign challenge B
```

- Exit `2` = policy blocked (AgentCash never started).
- Exit `0` = passthrough / dry-run allowed / AgentCash returned success (binding unproven).
- Base/EVM: explicit `decision=unknown` (see Networks).

Library: `import { safeFetch } from "twzrd-x402-gate/safe-fetch"`.

## Quickstart: `installTwzrdAutoGate` (default-on)

`installTwzrdAutoGate` is the one-liner form of "guard the raw fetch, then hand it to your
x402 client." It takes a `payWrap` function — whatever composes your paying client on top of
a fetch — and returns a fetch that's already gated: a blocked seller throws before your client
ever gets a chance to sign.

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";
import { wrapFetchWithPayment } from "@x402/svm";

const payingFetch = installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));

// Use payingFetch everywhere you'd call a paid resource:
const response = await payingFetch("https://api.exa.ai/search");
```

`payWrap` receives the **guarded** fetch (the guard has already run by the time your client
sees a 402) — this is the only correct composition order. Building it the other way round
(guarding an already-paying fetch) is a no-op; see [Compatibility note](#compatibility-note).
Any x402 client that composes over an underlying `fetch` works the same way — swap in
whatever `payWrap` your client's API expects (agentcash, ClawRouter, PayAI, a custom
`@x402/svm` scheme, etc.).

Default **ON**. Disable with `TWZRD_AUTO_GATE=0` (env, deploy-time kill switch) or
`{ disabled: true }` (per-call, e.g. in tests) — the raw fetch is handed straight to
`payWrap`, unguarded.

What happens on every HTTP 402 the raw fetch returns:
1. Reads the Solana-network entry from `accepts[]` (falls back to first entry) to get the seller wallet.
2. Calls `POST /v1/intel/preflight` — free, no auth. `decision=block` (or score floor) throws — `payWrap`'s client never signs.
3. Calls `GET /v1/intel/merchant_card/{payTo}` — free, no auth. `wash_flagged: true` refuses by default (only tightens step 2; fail-open if the card is unreachable — no invent).
4. Otherwise returns the 402 to `payWrap`'s client, which pays normally.

Non-402 responses pass through unchanged.

### Networks (Solana-deep, chain-neutral envelope)

The gate **recognizes** multi-chain 402s but only **reputation-scores Solana mainnet**.

| Network | Reputation scored? | Default policy (`unsupportedNetworkMode`) |
|---------|-------------------|-------------------------------------------|
| Solana mainnet | Yes — free preflight + merchant_card | allow/block from intel |
| Base / other EVM (`eip155:*`) | **No** | `observe` (default): `decision=unknown`, `policyAction=allow`, telemetry `unsupported_network_seen` |
| Base / EVM in `strict` mode | No | `policyAction=block` before sign |

This is intentional: Base listing abundance ≠ Solana behavioral history. Unsupported is never
represented as a TWZRD trust `allow`. Set `TWZRD_UNSUPPORTED_NETWORK_MODE=strict` (or
`{ unsupportedNetworkMode: "strict" }`) to hard-block unscored networks.

Dual-chain accepts still prefer the Solana entry for scoring (same as payment clients that
prefer Solana when available).

### Lower-level: `withTwzrdGuard`

`installTwzrdAutoGate` is built on `withTwzrdGuard` — the fetch wrapper itself, if you want to
manage the raw/paying composition yourself:

```typescript
import { withTwzrdGuard } from "twzrd-x402-gate";
import { wrapFetchWithPayment } from "@x402/svm";

const raw = globalThis.fetch;               // MUST still surface HTTP 402
const guarded = withTwzrdGuard(raw);        // guard sits upstream
const safeFetch = wrapFetchWithPayment(guarded, buyerWallet);

const response = await safeFetch("https://api.exa.ai/search");
```

What the guard does on HTTP 402:
1. Reads the Solana-network entry from `accepts[]` (falls back to first entry) to get the seller wallet.
2. Free `POST /v1/intel/preflight` — `decision=block` / score floor deny.
3. Free `GET /v1/intel/merchant_card/{payTo}` — `wash_flagged:true` **refuses by default**
   (`reason: twzrd_wash_flagged`). Fail-open if the card is unreachable (no invent).
4. If approved: returns the original 402 for the x402 client to pay.

Opt out of wash refuse: `withTwzrdGuard(fetch, { refuseWashFlagged: false })` or
`TWZRD_REFUSE_WASH_FLAGGED=0`. Soft cap instead of hard refuse: `washMaxUsdc` /
`TWZRD_WASH_MAX_USDC`.

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

The hook accepts the real `@x402/mcp` v2 `PaymentRequestedContext`
(`{ toolName, arguments, paymentRequired }`) — wire it directly:

```typescript
import { createx402MCPClient } from "@x402/mcp";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { twzrdOnPaymentRequested } from "twzrd-x402-gate";

const client = createx402MCPClient({
  name: "my-agent",
  version: "1.0.0",
  schemes: [/* e.g. registered SVM scheme */],
  autoPayment: true,
  onPaymentRequested: (ctx) => twzrdOnPaymentRequested(ctx), // false = deny before signing
});
```

The legacy flat shape (`{ accepts, context }`) is still accepted. Prior to
0.6.1, only the flat shape was read — wired into the real `@x402/mcp` runtime
the hook saw `accepts: undefined` and fail-closed-blocked every payment (safe,
but a 100% false-block).

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

A 402 whose payment requirements yield **no identifiable seller wallet** (missing/empty `payTo`, or an unparseable `accepts[]`) is a different case from "unknown seller" — it always **blocks** with `reason: twzrd_unidentifiable_payment_recipient`, without ever calling the preflight network. This is unconditional (not affected by `failOpen`): `failOpen` governs what happens when the TWZRD *service* is unreachable, not what happens when the caller can't say who they're paying.

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
| `disabled` (`installTwzrdAutoGate` only) | `TWZRD_AUTO_GATE=0`/`false` | `false` | Bypass the guard entirely — `payWrap` gets the raw, unguarded fetch |
| `attribution` | `TWZRD_ATTRIBUTION_INTEGRATION` + `TWZRD_ATTRIBUTION_RUN_ID` | — | Opt-in run attribution (see below) |

## Run attribution (optional, for integration correlation)

When you set `attribution`, the gate stamps **only the TWZRD preflight request** (never the
paid `/v1/intel/trust` call or the resource fetch) with correlation headers:

```
X-TWZRD-Integration: <integration>
X-TWZRD-Run-Id:      <runId>
X-TWZRD-Client:      twzrd-x402-gate/<version>
```

```ts
installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, wallet), {
  attribution: {
    integration: "payai-x402-solana-pr38",
    runId: crypto.randomUUID(), // echo this in your transcript / issue comment
  },
});
```

This is **correlation evidence, not proof of adoption** — the `runId` is caller-supplied and
spoofable. A run counts as an external execution only when the same `runId` (1) appears in the
integrator's own transcript, (2) is observed server-side with a real policy decision, and (3)
comes from non-internal lineage. No PII, secret, wallet, or payload is added; both fields must
be set or nothing is stamped.

## Compatibility note

**Proxied x402 clients** (AgentCash's `.fetch`, ClawRouter `:8402`): these clients handle
402 internally and return 200. The guard never sees a 402 if it wraps the client's *output* —
it must wrap the client's *input*. `installTwzrdAutoGate` enforces this composition order by
construction: it guards the raw fetch first, then hands the guarded fetch to your `payWrap`.
If you're composing `withTwzrdGuard` manually instead, pass the raw (non-paying) fetch to
`withTwzrdGuard`, then wrap its output in your x402 client — never the reverse. Or call
`evaluate_x402_resource` explicitly before routing through the proxy.

## Why pre-spend, not post-pay

`GET /v1/intel/trust/{wallet}` is the **paid** ($0.05 USDC) deep-intel surface — not a gate.
`POST /v1/intel/preflight` is the **free** `ReadinessCard` for the pre-spend decision.
This package only ever calls the free preflight; you decide whether to proceed before any
USDC leaves your wallet.

## License

MIT
