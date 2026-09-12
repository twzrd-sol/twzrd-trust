# @wzrd_sol/eliza-plugin

ElizaOS plugin for **TWZRD Agent Intel** — free preflight before x402 spends, optional paid
trust receipts, and offline verification. Default path (0.7+):

```text
seller → preflight → merchant_card → policy → optional V7 trust receipt → sign or refuse
```

The default export registers **intel actions only**. Legacy AO/CCM earn actions are opt-in.

## Buyer sequence (marketplace default)

Before any x402 spend:

1. **Free preflight** - `WZRD_INTEL_PREFLIGHT` / `preSpendGate` - ReadinessCard `allow` / `warn` / `block`
2. **Free merchant_card** - `WZRD_MERCHANT_CARD` (or inside `preSpendGate`) - if `wash_flagged: true`, **do not pay** (default)
3. **Optional paid trust** - `WZRD_INTEL_TRUST` (~0.05 USDC) - full score + **signed V7 receipt**
4. **Offline verify** - `WZRD_VERIFY_RECEIPT` via `twzrd-receipt-verifier`

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
| `WZRD_INTEL_TRUST` | x402 (~0.05 USDC) | Paid trust payload + **V7** signed receipt + ERC-8004 `reputation_credential` |
| `WZRD_VERIFY_RECEIPT` | Free (offline) | Leaf + Ed25519 verify via `twzrd-receipt-verifier`; V7 current, V6 labeled legacy |

### Receipt versions

| Version | Freshness | Notes |
|---------|-----------|-------|
| **V7** (current) | `signed` | `recheck_after_unix`, `staleness_days`, `score_decay_model` are leaf-bound. Claimed only after offline verify returns `valid` on a V7 domain with `freshness_unauthenticated === false`. |
| **V6** (legacy) | `derived_from_timestamp` | Those three fields are advisory. Enforce `max_age_seconds` against signed `timestamp_unix`. |
| **V5** (legacy) | `unauthenticated` | Provenance and freshness are unsigned. |

Classification uses the verifier domain allowlist only. Envelope `version` / `kind` cannot promote a V6 body to V7.

`verifyReceipt` and `getIntelClient().verify` are **synchronous**. They do not accept `fetchPubkey` / `apiBase` (0.6.1 SDK path) and return `receiptVersion` + `freshness` instead of SDK `leafVersion`. Default signing key is `CURRENT_RECEIPT_PUBKEY` (v2). Do not pass SDK `TRUSTED_RECEIPT_PUBKEY` (v1) or live V7 receipts fail closed.

### Preflight (free, no wallet)

```typescript
import { intelPreflightAction } from '@wzrd_sol/eliza-plugin';

await intelPreflightAction.handler(runtime, {
  content: {
    seller_wallet: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    price_usdc: 0.25,
    agent_intent: 'quote preview',
  },
}, state, opts, callback);
```

### Merchant card (free wash / demand-quality gate)

```typescript
import { merchantCardAction, fetchMerchantCard } from '@wzrd_sol/eliza-plugin';

const card = await fetchMerchantCard(sellerPubkey);
if (card?.wash_flagged) return 'refuse dirty pay_to';
```

Catalog enrichment is listing metadata only — never overrides wash.

### Pre-spend gate (programmatic — both free checks)

```typescript
import { preSpendGate, fetchIntelTrust, fetchMerchantCard } from '@wzrd_sol/eliza-plugin';

const gate = await preSpendGate({ seller_wallet: sellerPubkey, price_usdc: 0.25 });
if (!gate.allow) return `Blocked (${gate.decision}): ${gate.reason}`;

const trust = await fetchIntelTrust(sellerPubkey, { fetchImpl: myX402Fetch });
```

**Default:** `refuseWashFlagged: true`. Soft cap: `{ washMaxUsdc: 0.05 }`. Opt out: `{ refuseWashFlagged: false }`.

### Guard pattern: `installTwzrdAutoGate`

```typescript
import wzrdPlugin, { installTwzrdAutoGate } from '@wzrd_sol/eliza-plugin';
import { wrapFetchWithPayment } from '@x402/svm';

installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, buyerWallet));
const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
```

`payWrap` receives the **guarded** fetch. Opt out with `TWZRD_AUTO_GATE=0` or `{ disabled: true }`.

### Paid trust receipt

```typescript
import wzrdPlugin, { setPayingFetch } from '@wzrd_sol/eliza-plugin';
import { createAgentcashFetch } from 'agentcash';

setPayingFetch(createAgentcashFetch({ apiKey: process.env.AGENTCASH_API_KEY }));
const agent = new AgentRuntime({ plugins: [wzrdPlugin] });
// WZRD_INTEL_TRUST: free preflight + merchant_card, then pays ~$0.05 USDC,
// returns VC + V7 receipt, then offline-verifies before labeling freshness=signed
```

Without a paying fetch, `WZRD_INTEL_TRUST` returns the HTTP 402 requirements.

## Legacy earn actions (opt-in)

**0.6 breaking change:** default `wzrdPlugin` registers intel actions only.

```typescript
import { createWzrdPlugin, wzrdPluginWithLegacyEarn } from '@wzrd_sol/eliza-plugin';

const agent = new AgentRuntime({
  plugins: [createWzrdPlugin({ legacyEarnActions: true })],
});
```

## Programmatic SDK usage

```typescript
import {
  intelPreflight,
  fetchIntelTrust,
  fetchMerchantCard,
  verifyReceipt,
  preSpendGate,
  CURRENT_RECEIPT_PUBKEY,
  IntelPaymentRequiredError,
} from '@wzrd_sol/eliza-plugin';
```

## Test (source, not this tarball)

This npm package is a `dist/` artifact. Source and tests live in the
`twzrd-trust` monorepo as `eliza-plugin-source/`:

```bash
cd eliza-plugin-source
npm test
npm run typecheck
```

## Links

- [Agent Intel API](https://intel.twzrd.xyz)
- [API docs / llms.txt](https://intel.twzrd.xyz/llms.txt)
- [x402 gate](https://www.npmjs.com/package/twzrd-x402-gate)
- [plugin-trustgate](https://www.npmjs.com/package/@wzrd_sol/plugin-trustgate)

## License

MIT
