# @wzrd_sol/eliza-plugin

ElizaOS plugin for **TWZRD Agent Intel** — free preflight before x402 spends, optional paid
trust receipts, and offline verification. Default path:

```text
seller → preflight → policy → optional trust receipt → sign or refuse
```

## 3-line quickstart

```typescript
import wzrdPlugin from "@wzrd_sol/eliza-plugin";

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// "Preflight seller JUP6Lkb... at 0.25 USDC" → allow / warn / block (free, no wallet)
```

## Install

```bash
npm install @wzrd_sol/eliza-plugin
```

Pair with [`twzrd-x402-gate`](https://www.npmjs.com/package/twzrd-x402-gate) when your agent
signs x402 payments — policy runs at the pre-sign boundary.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WZRD_INTEL_URL` | No | `https://intel.twzrd.xyz` | Agent Intel API (preflight, trust, verify) |

Paid trust (`WZRD_INTEL_TRUST`) needs a paying fetch — wire via `setPayingFetch()` (agentcash,
PayAI, or any x402 client). No TWZRD API key for the free tier.

## Intel actions (supported path)

| Action | Auth / pay | Description |
|--------|------------|-------------|
| `WZRD_INTEL_PREFLIGHT` | Free | ReadinessCard: `decision`, `trust_score`, `can_spend`, `caveats`, `preflight_id` |
| `WZRD_INTEL_TRUST` | x402 (~0.05 USDC) | Paid trust payload + V6 signed receipt + ERC-8004 `reputation_credential` |
| `WZRD_VERIFY_RECEIPT` | Free (offline) | Recompute leaf + Ed25519 verify; no network when pubkey is known |

### Preflight (free, no wallet)

```typescript
import { intelPreflightAction } from "@wzrd_sol/eliza-plugin";

await intelPreflightAction.handler(
  runtime,
  {
    content: {
      seller_wallet: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      price_usdc: 0.25,
      agent_intent: "quote preview",
    },
  },
  state,
  opts,
  callback,
);
```

Example response:

```text
ReadinessCard v1
Decision: allow
Trust score: 72
Can spend: yes
Preflight ID: pf_abc123
Paid deep dive available (0.05 USDC) — use WZRD_INTEL_TRUST
```

Gate on `decision=block` by default. `can_spend=false` is conservative on the free tier —
use strict pre-sign policy (`gateOnCanSpend: true` on `twzrd-x402-gate`) only when you need
affirmative vouching before signature.

### Pre-sign guard (recommended for paying agents)

```typescript
import wzrdPlugin from "@wzrd_sol/eliza-plugin";
import { installTwzrdX402ClientHook } from "twzrd-x402-gate";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
installTwzrdX402ClientHook(client, {
  gateOnCanSpend: false,
  refuseWashFlagged: true,
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
// 402 → select requirement → TWZRD hook → sign or refuse
```

Raw-fetch composition: `installTwzrdAutoGate` from `twzrd-x402-gate` (see package README).

### Pre-spend gate (programmatic)

```typescript
import { preSpendGate, fetchIntelTrust } from "@wzrd_sol/eliza-plugin";

const gate = await preSpendGate({ seller_wallet: sellerPubkey });
if (!gate.allow) return `Blocked (${gate.decision}): ${gate.reason}`;

const trust = await fetchIntelTrust(sellerPubkey, { fetchImpl: myX402Fetch });
```

### Paid trust receipt

```typescript
import wzrdPlugin, { setPayingFetch } from "@wzrd_sol/eliza-plugin";

setPayingFetch(myX402Fetch); // agentcash, PayAI, or custom x402 client

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// "Get the trust receipt for seller JUP6LkbZ..."
```

Without `setPayingFetch`, `WZRD_INTEL_TRUST` returns 402 requirements and manual pay instructions.

**Routing on paid trust** (wash-adjusted):

```typescript
const vc = trust.reputation_credential.credentialSubject;
if (vc.effectiveTrustScore < 30) return "block";
if (vc.distinctCounterparties < 3) return "warn";
if (vc.washFactor < 0.5) return "warn";
```

### Example prompts

- `"Preflight Jupiter Quote Preview before I pay 0.25 USDC to 6EF8rrect..."`
- `"Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"`
- `"Is it safe to call the paid intel endpoint on this seller?"`
- `"Verify this receipt: {leaf, preimage, signature...}"`

## Programmatic SDK

```typescript
import {
  intelPreflight,
  fetchIntelTrust,
  verifyReceipt,
  preSpendGate,
  IntelPaymentRequiredError,
} from "@wzrd_sol/eliza-plugin";

import type {
  ReadinessCard,
  PreflightResponse,
  IntelTrustResponse,
  TwzrdReceipt,
} from "@wzrd_sol/eliza-plugin";
```

## Legacy earn actions (compatibility only)

Legacy earn actions (`WZRD_INFER`, `WZRD_REPORT`, `WZRD_EARN`, `WZRD_CLAIM`, `WZRD_REWARDS`)
remain in the **current package** for existing integrations. They are **not** part of the
supported Agent Intel or conversion path. New Eliza agents should use the intel actions above
and `twzrd-x402-gate` for pre-sign policy — not the CCM earn loop.

## Test

```bash
cd eliza-plugin
npm ci
npm run build
npm test
```

`npm test` runs live free preflight against `intel.twzrd.xyz`, offline receipt verify, and a
mocked paid trust path.

## Links

- [Agent Intel API](https://intel.twzrd.xyz)
- [llms.txt](https://intel.twzrd.xyz/llms.txt)
- [twzrd-x402-gate](https://www.npmjs.com/package/twzrd-x402-gate) — pre-sign seatbelt
- [@wzrd_sol/plugin-trustgate](https://www.npmjs.com/package/@wzrd_sol/plugin-trustgate) — Eliza preflight provider
- [twzrd-trust hub](https://github.com/twzrd-sol/twzrd-trust)

## License

MIT