# @wzrd_sol/eliza-plugin

ElizaOS plugin for WZRD Agent Intel — x402 firewall, free preflight checks before spends,
paid trust receipts (V6 + ERC-8004), and the earn loop on Solana.

## 3-line quickstart

```typescript
import wzrdPlugin from '@wzrd_sol/eliza-plugin';
const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// "Preflight seller JUP6Lkb... at 0.25 USDC" → allow/warn/block, free, no wallet
```

## Install

```bash
npm install @wzrd_sol/eliza-plugin
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WZRD_INTEL_URL` | No | `https://intel.twzrd.xyz` | Agent Intel API (preflight, trust, verify) |
| `WZRD_API_URL` | No | `https://api.twzrd.xyz` | Earn API (infer/report/claim) |
| `SOLANA_PRIVATE_KEY` | Earn lane only | — | JSON array of secret key bytes for agent Ed25519 auth |

## Intel actions (primary)

| Action | Auth/Pay | Description |
|--------|----------|-------------|
| `WZRD_INTEL_PREFLIGHT` | Free | ReadinessCard: `decision`, `trust_score`, `can_spend`, `caveats`, `preflight_id` |
| `WZRD_INTEL_TRUST` | x402 (~0.05 USDC) | Paid trust payload + V6 signed receipt + ERC-8004 `reputation_credential` |
| `WZRD_VERIFY_RECEIPT` | Free (offline) | Recompute leaf + Ed25519 verify; no network when pubkey is known |

### Preflight (free, no wallet)

```typescript
import { intelPreflightAction } from '@wzrd_sol/eliza-plugin';

// Reads seller_wallet / price_usdc / agent_intent from message content.
await intelPreflightAction.handler(runtime, {
  content: {
    seller_wallet: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    price_usdc: 0.25,
    agent_intent: 'quote preview',
  },
}, state, opts, callback);
```

Response (formatted text returned to agent):

```
ReadinessCard v1
Decision: allow
Trust score: 72
Can spend: yes
Preflight ID: pf_abc123
Paid deep dive available (0.05 USDC) — use WZRD_INTEL_TRUST
```

### Guard pattern: fire-before-pay with `withTwzrdGuard`

For agents that call x402-gated URLs directly (not via pre-known seller wallet), pair this
plugin with `twzrd-x402-gate` to intercept 402s before any spend:

```typescript
import wzrdPlugin from '@wzrd_sol/eliza-plugin';
import { withTwzrdGuard } from 'twzrd-x402-gate';
import { createAgentcashFetch } from 'agentcash';

// Wrap the paying fetch — guard runs preflight on every 402 before USDC moves.
const x402Fetch = createAgentcashFetch({ apiKey: process.env.AGENTCASH_API_KEY });
const safeFetch = withTwzrdGuard(x402Fetch, {
  autoReceipt: true,   // auto-buy $0.05 TWZRD receipt on warn/allow
  x402Fetch,
});

// Wire safeFetch into any tool or skill that calls paid resources:
const response = await safeFetch('https://api.exa.ai/search');
// → decision=block throws before payment
// → decision=warn/allow: payment proceeds, TWZRD receipt captured
```

Guard flow:
1. `safeFetch` hits the resource, gets HTTP 402.
2. `withTwzrdGuard` reads `accepts[0].payTo` (seller wallet).
3. Calls `POST /v1/intel/preflight` — free, no auth.
4. `block` - throws, no payment made.
5. `warn/allow` - returns the 402 for the x402 client to pay.

### Pre-spend gate (programmatic)

```typescript
import { preSpendGate, fetchIntelTrust } from '@wzrd_sol/eliza-plugin';

// Gate before paying:
const gate = await preSpendGate({ seller_wallet: sellerPubkey });
if (!gate.allow) return `Blocked (${gate.decision}): ${gate.reason}`;

// Then pay and get the receipt:
const trust = await fetchIntelTrust(sellerPubkey, { fetchImpl: myX402Fetch });
```

### Paid trust receipt (agentcash)

```typescript
import wzrdPlugin, { setPayingFetch } from '@wzrd_sol/eliza-plugin';
import { createAgentcashFetch } from 'agentcash';

setPayingFetch(createAgentcashFetch({ apiKey: process.env.AGENTCASH_API_KEY }));

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// "Get the trust receipt for seller JUP6LkbZ..."
// → WZRD_INTEL_TRUST: runs free preflight, pays $0.05 USDC, returns VC
```

### Paid trust receipt (PayAI)

```typescript
import wzrdPlugin, { setPayingFetch } from '@wzrd_sol/eliza-plugin';
import { PayAIClient } from '@payai/client';

const payai = new PayAIClient({ keypairPath: '~/.config/solana/id.json' });
setPayingFetch((url, init) => payai.fetch(url, init));

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
```

Without a paying fetch, `WZRD_INTEL_TRUST` returns the HTTP 402 requirements and an
`npx agentcash@latest fetch ...` one-liner to pay manually.

**`WZRD_INTEL_TRUST` response fields:**

```
Trust payload for JUP6Lkb...
Score: 61.8  Paid: yes
Settlement tx: 4xK3n...
Reputation credential (ERC-8004 AgentReputationCredential):
  effectiveTrustScore: 62       <- route on this (wash-adjusted)
  trustScore: 72  washFactor: 0.86
  distinctCounterparties: 14    <- cross-facilitator breadth
  corpusScope: cross-facilitator
  version: intel_renorm_v1
Routing gate: effectiveTrustScore < 30 -> block, 30-60 -> warn, > 60 -> allow
Receipt v6, leaf: 0x3a4f...
Use WZRD_VERIFY_RECEIPT to verify offline.
```

**Routing logic:**

```typescript
const vc = trust.reputation_credential.credentialSubject;
if (vc.effectiveTrustScore < 30) return 'block';
if (vc.distinctCounterparties < 3) return 'warn'; // thin history
if (vc.washFactor < 0.5) return 'warn';           // suspicious ring
```

`effectiveTrustScore` is the cross-facilitator wash-adjusted score — computed across all known
x402 facilitators, not just one settlement path.

### Example agent prompts (trust)

- `"Preflight Jupiter Quote Preview before I pay 0.25 USDC to 6EF8rrect..."`
- `"Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"`
- `"Is it safe to call the paid intel endpoint on this seller?"`
- `"Verify this receipt: {leaf, preimage, signature...}"`

## Legacy earn actions

| Action | Auth | Description |
|--------|------|-------------|
| `WZRD_INFER` | Agent Ed25519 | Server-witnessed inference; returns `execution_id` |
| `WZRD_REPORT` | Agent Ed25519 | Report outcome with `execution_id` for verified rewards |
| `WZRD_EARN` | Agent Ed25519 | Full infer -> report -> rewards check in one action |
| `WZRD_CLAIM` | Agent Ed25519 | Gasless CCM claim via relay |
| `WZRD_REWARDS` | Agent Ed25519 | Pending and lifetime CCM balance |

### Example prompts (earn)

- `"Run inference through WZRD: explain quicksort in Python"`
- `"Earn some CCM on WZRD"`
- `"Check my WZRD rewards"`
- `"Claim my CCM"`

## Programmatic SDK usage

```typescript
import {
  intelPreflight,
  fetchIntelTrust,
  verifyReceipt,
  preSpendGate,
  IntelPaymentRequiredError,
} from '@wzrd_sol/eliza-plugin';

import type {
  ReadinessCard,
  PreflightResponse,
  IntelTrustResponse,
  TwzrdReceipt,
} from '@wzrd_sol/eliza-plugin';
```

## Test

```bash
cd agents/eliza-plugin
npm ci
npm run build
npm test
```

`npm test` runs live free preflight against `intel.twzrd.xyz`, offline receipt verify, and a
mocked paid trust path.

Manual earn smoke (requires `SOLANA_PRIVATE_KEY`):

```bash
npx tsx test/earn-e2e.ts
```

## Links

- [Agent Intel API](https://intel.twzrd.xyz)
- [API docs / llms.txt](https://intel.twzrd.xyz/llms.txt)
- [x402 gate (standalone firewall)](https://www.npmjs.com/package/twzrd-x402-gate)
- [GOAT plugin](https://www.npmjs.com/package/@wzrd_sol/goat-plugin)
- [TWZRD trust quickstart](https://intel.twzrd.xyz/docs/QUICKSTART.md)

## License

MIT
