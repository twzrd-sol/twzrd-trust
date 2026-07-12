# @wzrd_sol/eliza-plugin

ElizaOS plugin for **TWZRD Agent Intel** — free preflight before x402 spends, optional paid
trust receipts, and offline verification. Default path (0.6+):

```text
seller → preflight → merchant_card → policy → optional trust receipt → sign or refuse
```

The default export registers **intel actions only**. Legacy AO/CCM earn actions are opt-in.

## Buyer sequence (marketplace default)

Before any x402 spend:

1. **Free preflight** - `WZRD_INTEL_PREFLIGHT` / `preSpendGate` - ReadinessCard `allow` / `warn` / `block`
2. **Free merchant_card** - `WZRD_MERCHANT_CARD` (or inside `preSpendGate`) - if `wash_flagged: true`, **do not pay** (default)
3. **Optional paid trust** - `WZRD_INTEL_TRUST` (~0.05 USDC) - full score + **signed V6 receipt**
4. **Offline verify** - `WZRD_VERIFY_RECEIPT`

This plugin exposes **actions + SDK helpers**. It does **not** auto-intercept every wallet signature.
Wire `preSpendGate` / actions into your spend path, or compose with standalone `twzrd-x402-gate` on a paying fetch.

## 3-line quickstart

```typescript
import wzrdPlugin from '@wzrd_sol/eliza-plugin';
const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// "Preflight seller JUP6Lkb... at 0.25 USDC" -> allow/warn/block, free, no wallet
// "Merchant card for GFpLvoc..." -> wash_flagged refuse default
```

## Install

```bash
npm install @wzrd_sol/eliza-plugin
```

## Which package?

| Package | Role | Auto-gates every payment? |
|---------|------|---------------------------|
| **`@wzrd_sol/eliza-plugin`** (this) | Eliza actions: preflight, merchant_card, paid trust, verify; re-exports SDK `preSpendGate` | No - call-site / LLM actions |
| **`@wzrd_sol/plugin-trustgate`** | Smaller Eliza provider + `canSpendSafely` (preflight only) | No - opt-in `canSpendSafely` |
| **`twzrd-x402-gate`** | Framework-agnostic fetch wrapper (preflight + wash refuse on 402) | Only if you wrap fetch |

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WZRD_INTEL_URL` | No | `https://intel.twzrd.xyz` | Agent Intel API (preflight, merchant_card, trust, verify) |
| `WZRD_API_URL` | Legacy earn only | `https://api.twzrd.xyz` | Earn API when `legacyEarnActions: true` |
| `SOLANA_PRIVATE_KEY` | Legacy earn only | - | JSON array of secret key bytes for agent Ed25519 auth |

## Intel actions (primary)

| Action | Auth/Pay | Description |
|--------|----------|-------------|
| `WZRD_INTEL_PREFLIGHT` | Free | ReadinessCard: `decision`, `trust_score`, `can_spend`, `caveats`, `preflight_id` |
| `WZRD_MERCHANT_CARD` | Free | Graph card: `wash_flagged`, tier, catalog join; **default refuse if wash** |
| `WZRD_INTEL_TRUST` | x402 (~0.05 USDC) | Paid trust payload + **V6** signed receipt + ERC-8004 `reputation_credential` |
| `WZRD_VERIFY_RECEIPT` | Free (offline) | Recompute leaf + Ed25519 verify; V6 primary (older V5 still accepted) |

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
Paid deep dive available (0.05 USDC) - use WZRD_INTEL_TRUST
```

### Merchant card (free wash / demand-quality gate)

```typescript
import { merchantCardAction, fetchMerchantCard } from '@wzrd_sol/eliza-plugin';

// Action (LLM-callable):
// "Merchant card for GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs"

// Programmatic:
const card = await fetchMerchantCard(sellerPubkey);
if (card?.wash_flagged) return 'refuse dirty pay_to';
// card unreachable -> fail-open (do not invent wash); use preflight decision only
```

Catalog enrichment is listing metadata only - never overrides wash.

### Pre-spend gate (programmatic - both free checks)

```typescript
import { preSpendGate, fetchIntelTrust, fetchMerchantCard } from '@wzrd_sol/eliza-plugin';

// Free preflight + free merchant_card wash refuse (default on):
const gate = await preSpendGate({ seller_wallet: sellerPubkey, price_usdc: 0.25 });
if (!gate.allow) return `Blocked (${gate.decision}): ${gate.reason}`;
// gate.washFlagged === true was refuse default; null = card gap (fail-open)

// Then pay and get the receipt:
const trust = await fetchIntelTrust(sellerPubkey, { fetchImpl: myX402Fetch });
```

**Default:** `refuseWashFlagged: true` - if free `merchant_card.wash_flagged`, do not pay.
Soft cap: `{ washMaxUsdc: 0.05 }`. Opt out: `{ refuseWashFlagged: false }`.

### Guard pattern: fire-before-pay with `installTwzrdAutoGate` (default-on)

For agents that call x402-gated URLs directly (not via a pre-known seller wallet), pair this
plugin with standalone **`twzrd-x402-gate`** (separate package - not bundled here) to intercept
402s before any spend — and register the result as the plugin's paying fetch in one call:

```typescript
import wzrdPlugin, { installTwzrdAutoGate } from '@wzrd_sol/eliza-plugin';
import { wrapFetchWithPayment } from '@x402/svm';

// Guards the raw fetch (free preflight + free merchant_card wash refuse), hands the guarded
// fetch to your x402 client, registers the result as the module paying fetch — a blocked or
// wash-flagged seller throws before your client ever signs.
installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// WZRD_INTEL_TRUST and any tool/skill using resolvePayingFetch() now goes through the guard.
```

`payWrap` (the function you pass in) receives the **guarded** fetch — the guard has already
run by the time your client sees a 402. Building the composition the other way round (guarding
an already-paying client, e.g. one that resolves 402s internally and returns 200) is a no-op;
see `twzrd-x402-gate`'s Compatibility note. Opt out with `TWZRD_AUTO_GATE=0` (env) or
`{ disabled: true }`.

Guard flow (in `twzrd-x402-gate`, not inside this plugin):
1. The raw fetch hits the resource, gets HTTP 402.
2. The guard reads `accepts[0].payTo` (seller wallet).
3. Free `POST /v1/intel/preflight` — `decision=block` / score floor throws, `payWrap`'s client never signs.
4. Free `GET /v1/intel/merchant_card/{payTo}` — `wash_flagged:true` refuses by default (only tightens step 3).
5. Otherwise returns the 402 to `payWrap`'s client, which pays normally.

For manual composition (managing the raw/paying split yourself) or `autoReceipt`/`escalateOnWarn`
options, use `withTwzrdGuard` from `twzrd-x402-gate` directly and pass the result to `setPayingFetch`
— see that package's README.

### Paid trust receipt (agentcash)

```typescript
import wzrdPlugin, { setPayingFetch } from '@wzrd_sol/eliza-plugin';
import { createAgentcashFetch } from 'agentcash';

setPayingFetch(createAgentcashFetch({ apiKey: process.env.AGENTCASH_API_KEY }));

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// "Get the trust receipt for seller JUP6LkbZ..."
// -> WZRD_INTEL_TRUST: free preflight + merchant_card, then pays $0.05 USDC, returns VC + V6 receipt
```

### Paid trust receipt (PayAI)

```typescript
import wzrdPlugin, { setPayingFetch } from '@wzrd_sol/eliza-plugin';
import { PayAIClient } from '@payai/client';

const payai = new PayAIClient({ keypairPath: '~/.config/solana/id.json' });
setPayingFetch((url, init) => payai.fetch(url, init));

const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
```

Without a paying fetch, `WZRD_INTEL_TRUST` returns the HTTP 402 requirements and a
manual pay one-liner. Caveat: `npx agentcash@latest fetch` has been a known-bad path
for TWZRD paid trust (fee_payer slot); prefer a wired `setPayingFetch` client.

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

`effectiveTrustScore` is the cross-facilitator wash-adjusted score - computed across all known
x402 facilitators, not just one settlement path.

### Facilitator settle attach (optional host pattern - not an Eliza action)

If your x402 client uses TWZRD as facilitator (`https://intel.twzrd.xyz`), successful
`POST /settle` may return `merchant_attach` + `twzrd_receipt` for the requirements `payTo`
(best-effort; never voids on-chain settle). Discover via `GET /supported` (`twzrd.merchant_attach`).
This plugin does not register a settle action - wire facilitator URL in the host payer.

### Example agent prompts (trust)

- `"Preflight Jupiter Quote Preview before I pay 0.25 USDC to 6EF8rrect..."`
- `"Merchant card for GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs"`
- `"Get the trust receipt for seller JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"`
- `"Is it safe to call the paid intel endpoint on this seller?"`
- `"Verify this receipt: {leaf, preimage, signature...}"`

## Legacy earn actions (opt-in)

**0.6 breaking change:** `import wzrdPlugin from '@wzrd_sol/eliza-plugin'` registers intel
actions only. To restore the pre-0.6 earn surface:

```typescript
import { createWzrdPlugin, wzrdPluginWithLegacyEarn } from '@wzrd_sol/eliza-plugin';

// Either factory:
const agent = new AgentRuntime({
  plugins: [createWzrdPlugin({ legacyEarnActions: true })],
});

// Or compatibility export:
const agent = new AgentRuntime({ plugins: [wzrdPluginWithLegacyEarn] });
```

Legacy earn is **not** part of the supported Agent Intel conversion path. New agents should
use intel actions + `twzrd-x402-gate` for pre-sign policy.

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
  fetchMerchantCard,
  verifyReceipt,
  preSpendGate,
  IntelPaymentRequiredError,
} from '@wzrd_sol/eliza-plugin';

import type {
  ReadinessCard,
  PreflightResponse,
  MerchantCard,
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

`npm test` runs live free preflight against `intel.twzrd.xyz`, free merchant_card path,
offline receipt verify, and a mocked paid trust path.

Manual earn smoke (requires `SOLANA_PRIVATE_KEY`):

```bash
npx tsx test/earn-e2e.ts
```

## Links

- [Agent Intel API](https://intel.twzrd.xyz)
- [API docs / llms.txt](https://intel.twzrd.xyz/llms.txt)
- [x402 gate (standalone fetch firewall)](https://www.npmjs.com/package/twzrd-x402-gate)
- [plugin-trustgate (smaller Eliza spend guard)](https://www.npmjs.com/package/@wzrd_sol/plugin-trustgate)
- [GOAT plugin](https://www.npmjs.com/package/@wzrd_sol/goat-plugin)

## License

MIT
