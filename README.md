# TWZRD Agent Intel

**Live MCP** • [`https://intel.twzrd.xyz/mcp`](https://intel.twzrd.xyz/mcp) (**23 tools**, streamable HTTP)
**Pre-sign seatbelt** • [`twzrd-x402-gate`](https://www.npmjs.com/package/twzrd-x402-gate) `@0.5.3` — policy before `wallet.signTransaction`
**Seller graph** • directory → merchant card → readiness → (optional) paid trust
**Self-host mirror** • public wiring only (scoring engine stays private)

TWZRD is the pre-spend trust layer for agents paying over x402 on Solana. Vet the
**seller and service** before USDC leaves your wallet. Free tier needs no signup; pay
only when you want the portable signed V6 receipt.

**Live corpus (intel 0.5.3):** 549 listed services · 152 payTos · 167 challenge-verified (`live_402`).

---

## Default path (seller-first)

Most agents should follow this order:

1. **Directory** — `GET /v1/intel/x402-directory` or MCP `get_x402_directory`
2. **Merchant card** — `GET /v1/intel/merchant_card/{pay_to}` or MCP `get_merchant_card`
   - Refuse when `wash_flagged=true` (default in gate packages)
   - `listed_unverified` when catalog rows exist but no challenge-verified endpoint yet
3. **Readiness** — `POST /v1/intel/preflight` or MCP `get_readiness_card_tool`
   - `block` → do not pay
   - `warn` → thin/unknown seller (conservative default); buy paid trust if spend matters
   - `allow` → established organic seller — still not a vouch for large spends
4. **Optional paid trust** — `GET /v1/intel/trust/{pubkey}?seller_wallet=<seller>` (0.05 USDC)
5. **Pay the resource** — only after steps 1–3 (and optional 4) approve

**Pre-sign enforcement:** wrap your payment client with `twzrd-x402-gate@0.5.3` so step 3
runs automatically before signing (see [Buyer-side gate](#buyer-side-gate-pre-sign-enforcement)).

---

## Quick Start

```bash
# 1) Free readiness on an established x402 seller (no signup, no payment)
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet":"BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ","price_usdc":0.01,"agent_intent":"preflight"}'

# 2) Free merchant card (wash + catalog context)
curl -s https://intel.twzrd.xyz/v1/intel/merchant_card/BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ
```

Read `readiness_card.decision`:

| Decision | Meaning |
|----------|---------|
| `block` | Do not pay (wash/fleet or hard deny) |
| `warn` | Unknown or thin history — cautious; `can_spend=false` is common and **not** auto-block unless you opt into strict mode |
| `allow` | Established seller in corpus — proceed for small spends; still verify large/recurring |

Free preflight is **advisory** unless you wire a gate package or payment-hook.

---

## Packages

| Directory / npm | What |
|-----------------|------|
| [`twzrd-x402-gate`](./twzrd-x402-gate) · `npm i twzrd-x402-gate@0.5.3` | Buyer-side pre-sign seatbelt: `withTwzrdGuard`, `installTwzrdAutoGate`, `installTwzrdX402ClientHook`, `twzrdBeforePaymentCreation` |
| [`twzrd-mcp-server`](./twzrd-mcp-server) · `npx -y twzrd-mcp-server` | Local auto-pay MCP (npm `0.4.0`); paid intel opt-in via env |
| [`plugin-trustgate`](./plugin-trustgate) | ElizaOS / facilitator `onBeforeSettle` — **requirer** seat, not buyer wrap |
| [`eliza-plugin`](./eliza-plugin) | Full Agent Intel plugin for ElizaOS |
| [`server/`](./server) | Public MCP card, `llms.txt`, well-known endpoints |

**PayAI client integration (external, either/or):** [x402-solana #38](https://github.com/PayAINetwork/x402-solana/pull/38) (`beforePaymentCreation`) or [#39](https://github.com/PayAINetwork/x402-solana/pull/39) (`beforePayment`) — TWZRD reference via `twzrdBeforePaymentCreation` / `installTwzrdX402ClientHook`.

**Proof (zero funds, signer count 0 on strict block):** [seller-graph pay-guard closeout](./docs/proofs/seller-graph-payguard-closeout-2026-07-12.md)

---

## Buyer-side gate (pre-sign enforcement)

Default machine rule: **decision-only** (`gateOnCanSpend: false`) + **wash refuse** (`refuseWashFlagged: true`).

```typescript
import { installTwzrdAutoGate } from "twzrd-x402-gate";

// Guard RAW fetch, then hand to your x402 pay client
const payingFetch = installTwzrdAutoGate((guarded) =>
  yourPayClient.wrap(guarded),
);
```

Strict opt-in (also block when `can_spend=false`):

```typescript
import { withTwzrdGuard } from "twzrd-x402-gate";

const fetch = withTwzrdGuard(globalThis.fetch, { gateOnCanSpend: true });
```

Official x402 client hook (same policy engine):

```typescript
import { installTwzrdX402ClientHook } from "twzrd-x402-gate";
installTwzrdX402ClientHook(x402Client, { gateOnCanSpend: false, refuseWashFlagged: true });
```

---

## Live MCP Surface (23 tools — free tier, no auth)

Connect any MCP client to `https://intel.twzrd.xyz/mcp` (requires `Accept: application/json` **and** `Accept: text/event-stream`).

**Seller / service graph (start here)**

| Tool | What it does |
|------|-------------|
| `get_x402_directory` | Combined x402 service directory (PayAI, CDP, Agentic Market) |
| `get_merchant_card` | Free seller graph card — wash, catalog, `next_action` |
| `get_readiness_card_tool` | Pre-spend ReadinessCard (`allow` / `warn` / `block`) |
| `evaluate_x402_resource` | One-shot: fetch URL → extract 402 payTo → preflight |
| `get_provider_reputation` | Seller reputation from x402 corpus |
| `is_wash_fleet` | Wash / sybil-fleet check on a payer wallet |
| `twzrd_watch_add` | Register seller re-check watch (webhook optional) |
| `twzrd_watch_list` | List active watches |
| `twzrd_watch_remove` | Deactivate a watch |

**Wallet intel (secondary)**

| Tool | What it does |
|------|-------------|
| `score_wallet_for_intel` | 0–100 intel score from payment history |
| `get_facilitator_footprint` | Which facilitators a payer used |
| `get_counterparties` | Top merchants a wallet pays (capped teaser) |
| `score_wallets_batch` | Score up to 25 wallets |
| `compare_wallets` | Side-by-side two wallets |
| `get_top_intel_agents` | Payer leaderboard (corpus explorer — secondary) |
| `low_level_preflight` | Richer preflight + spend recommendation |

**Receipts & verification**

| Tool | What it does |
|------|-------------|
| `verify_receipt` | Offline-verify signed V6 trust receipt |
| `verify_root_inputs` | Recompute merkle root inputs (PASS/FAIL) |

**Solana market data (optional / ancillary)**

| Tool | What it does |
|------|-------------|
| `get_solana_market_status` | Market data service health |
| `get_solana_market_visibility_map` | Markets with settlement activity |
| `get_solana_market_orderbook_depth` | Orderbook depth for a ticker |
| `get_solana_market_shape` | Market structure signals |
| `get_solana_market_onchain_trades_summary` | Recent on-chain trades |

Full tool reference: [`intel.twzrd.xyz/llms.txt`](https://intel.twzrd.xyz/llms.txt) · [`.well-known/mcp.json`](https://intel.twzrd.xyz/.well-known/mcp.json)

---

## Paid Trust Call (x402, 0.05 USDC)

```
GET https://intel.twzrd.xyz/v1/intel/trust/{pubkey}?seller_wallet=<seller>
```

Returns the renormalized trust model + portable Ed25519-signed **V6 receipt** anchored to settlement.

| Surface | What you get |
|---------|----------------|
| **Free preflight** | Teaser ReadinessCard — advisory, not renorm proof |
| **Paid trust** | Full model + signed receipt — verify offline |

Pass `seller_wallet` on paid calls to arm settle-time gating where enabled. First paid
mint may be cold until a wallet funds the challenge; free preflight works without USDC.

Cheap teaser: `GET /v1/intel/quick/{pubkey}` (0.001 USDC, no full receipt).

---

## Verify Receipts Offline (trust no one)

Pin the issuer key from the well-known endpoint (do not invent keys):

```bash
curl -s https://intel.twzrd.xyz/.well-known/twzrd-receipt-pubkey

npx twzrd-receipt-verifier@1.2.0 receipt.json \
  --pubkey 9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf
# or: pip install 'twzrd-receipt-verifier>=1.2.0'
```

---

## Related

- [Pay-guard closeout proof](./docs/proofs/seller-graph-payguard-closeout-2026-07-12.md) — zero-funds strict block, signer count 0
- [Zero-spend guard check](./docs/proofs/examples/zero-spend-guard-check.mjs) — runnable harness
- [Receipt Verifier](https://github.com/twzrd-sol/twzrd-receipt-verifier) — offline crypto
- [Live orientation](https://intel.twzrd.xyz/llms.txt) — full agent guide (source of truth)
- [API spec](https://intel.twzrd.xyz/openapi.json) — OpenAPI 3.1 with x402
- [twzrd-x402-gate on npm](https://www.npmjs.com/package/twzrd-x402-gate) · [twzrd-mcp-server on npm](https://www.npmjs.com/package/twzrd-mcp-server)

---

## License

MIT — see [LICENSE](./LICENSE). Each package is independently MIT-licensed.

**Scoring engine IP is protected.** Proprietary intel scoring, wash detection, and trust
renormalization remain private. Agents consume through the live API — no engine source required.