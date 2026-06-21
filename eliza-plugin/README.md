# @wzrd_sol/eliza-plugin

ElizaOS plugin for WZRD Agent Intel and the legacy earn loop on Solana.

**Before any x402 spend:** run `WZRD_INTEL_PREFLIGHT` (free ReadinessCard). Escalate to `WZRD_INTEL_TRUST` only when you need a signed V5 receipt. Verify offline with `WZRD_VERIFY_RECEIPT`.

## Install

```bash
npm install @wzrd_sol/eliza-plugin
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WZRD_INTEL_URL` | No | `https://intel.twzrd.xyz` | Agent Intel API (preflight, trust, verify) |
| `WZRD_API_URL` | No | `https://api.twzrd.xyz` | Legacy earn API (infer/report/claim) |
| `SOLANA_PRIVATE_KEY` | Earn lane only | — | JSON array of secret key bytes for agent Ed25519 auth |

### Wiring a paying fetch (intel paid actions)

The plugin does **not** embed a wallet. Paid `WZRD_INTEL_TRUST` needs an x402-capable `fetch` from the host:

```typescript
import { AgentRuntime } from '@elizaos/core';
import wzrdPlugin, { setPayingFetch } from '@wzrd_sol/eliza-plugin';
import { agentcashFetch } from 'your-x402-wrapper'; // agentcash, twzrd-x402-gate, etc.

setPayingFetch(agentcashFetch);

const agent = new AgentRuntime({
  plugins: [wzrdPlugin],
  settings: {
    WZRD_INTEL_URL: 'https://intel.twzrd.xyz',
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  },
});
```

Without a paying fetch, `WZRD_INTEL_TRUST` returns the HTTP 402 requirements and an `npx agentcash@latest fetch ...` one-liner.

## Usage

```typescript
import { wzrdPlugin } from '@wzrd_sol/eliza-plugin';

const agent = new AgentRuntime({
  plugins: [wzrdPlugin],
});
```

Programmatic SDK calls (same types as the plugin) are re-exported:

```typescript
import { intelPreflight, fetchIntelTrust, verifyReceipt, IntelPaymentRequiredError } from '@wzrd_sol/eliza-plugin';
```

## Intel actions (primary)

| Action | Auth/Pay | Description |
|--------|----------|-------------|
| `WZRD_INTEL_PREFLIGHT` | Free | ReadinessCard: decision, trust_score, can_spend, caveats, paid upsell |
| `WZRD_INTEL_TRUST` | x402 (~0.05 USDC) | Paid trust payload + V5 `twzrd_receipt` (needs `setPayingFetch`) |
| `WZRD_VERIFY_RECEIPT` | Free (offline) | Recompute leaf + Ed25519 verify; no network when pubkey is known |

### Example prompts

- "Preflight Jupiter Quote Preview before I pay 0.25 USDC to 6EF8rrect..."
- "Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
- "Verify this receipt: {leaf, preimage, signature...}"
- "Is it safe to call the paid intel endpoint on this seller?"

### Free preflight (no wallet)

```typescript
import { intelPreflightAction } from '@wzrd_sol/eliza-plugin';

// Handler reads seller_wallet / price_usdc / agent_intent from message content
await intelPreflightAction.handler(runtime, {
  content: {
    seller_wallet: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    price_usdc: 0.25,
    agent_intent: 'quote preview',
  },
}, ...);
```

## Legacy earn actions

| Action | Auth | Description |
|--------|------|-------------|
| `WZRD_INFER` | Agent Ed25519 | Server-witnessed inference; returns `execution_id` |
| `WZRD_REPORT` | Agent Ed25519 | Report outcome with `execution_id` for verified rewards |
| `WZRD_EARN` | Agent Ed25519 | Full infer → report → rewards check in one action |
| `WZRD_CLAIM` | Agent Ed25519 | Gasless CCM claim via relay |
| `WZRD_REWARDS` | Agent Ed25519 | Pending and lifetime CCM balance |

### Example prompts (earn)

- "Run inference through WZRD: explain quicksort in Python"
- "Earn some CCM on WZRD"
- "Check my WZRD rewards"
- "Claim my CCM"

## Test

```bash
cd agents/eliza-plugin
npm ci
npm run build
npm test
```

`npm test` loads the plugin into a real `@elizaos/core` `AgentRuntime`, runs live free preflight against `intel.twzrd.xyz`, offline receipt verify, and a mocked paid trust path.

Manual earn smoke (requires `SOLANA_PRIVATE_KEY`):

```bash
npx tsx test/earn-e2e.ts
```

## Links

- [Agent Intel API](https://intel.twzrd.xyz)
- [Legacy API](https://api.twzrd.xyz)
- [SDK](https://www.npmjs.com/package/@wzrd_sol/sdk)
- [twzrd-agent-intel (Python/MCP)](https://github.com/twzrd-sol/wzrd-final/tree/main/packages/twzrd-agent-intel)
- [Agent discovery](https://twzrd.xyz/llms.txt)

## License

MIT