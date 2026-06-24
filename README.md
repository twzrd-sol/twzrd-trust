# TWZRD Agent Intel

**Live MCP server** • `https://intel.twzrd.xyz/mcp` (18 tools)
**Client SDKs** • x402 trust gates + Eliza plugins
**Self-host** • Deploy configs + public wiring (scoring engine stays private)

Check any Solana wallet or x402 seller **before** you pay. Free preflight returns
a ReadinessCard (allow / warn / block + trust score + risk factors) from the real
cross-facilitator Solana x402 payment corpus.

---

## Quick Start

```bash
# No signup, no API key — just curl
curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight \
  -H 'content-type: application/json' \
  -d '{"seller_wallet": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "agent_intent": "test"}'
```

Read `decision`: **block** → don't pay. **warn** → cautious. **allow** → proceed.

---

## Packages

| Directory | What |
|-----------|------|
| [`twzrd-x402-gate`](./twzrd-x402-gate) | Buyer-side x402 trust gate (npm) — wraps fetch + preflight before signing USDC |
| [`plugin-trustgate`](./plugin-trustgate) | ElizaOS plugin — refuses to pay wash-flagged / block sellers |
| [`eliza-plugin`](./eliza-plugin) | Full WZRD Agent Intel plugin for ElizaOS |
| [`server/`](./server) | Public MCP wiring, Dockerfile, well-known endpoints, agent card |

---

## Live MCP Surface (18 tools — free, no auth)

Connect any MCP client to `https://intel.twzrd.xyz/mcp`:

| Tool | What it does |
|------|-------------|
| `get_readiness_card_tool` | Pre-spend gate — seller wallet → `allow`/`warn`/`block` + trust score |
| `evaluate_x402_resource` | Fetches a URL, extracts 402 seller wallet, runs preflight — one-shot guard |
| `low_level_preflight` | Richer preflight with spend recommendation + evidence |
| `get_solana_market_status` | Health probe for the Solana Market API data backend |
| `get_solana_market_visibility_map` | Which markets have real settlement activity |
| `get_solana_market_orderbook_depth` | Liquidity profile for a ticker |
| `get_solana_market_shape` | Market structure signals |
| `get_solana_market_onchain_trades_summary` | Recent on-chain trade activity |
| `score_wallet_for_intel` | 0-100 intel score from x402 payment history |
| `get_top_intel_agents` | Leaderboard of active paying agents |
| `get_provider_reputation` | Seller-side reputation (organic vs wash fleet) |
| `is_wash_fleet` | Circular-flow / wash check for a payer wallet |
| `verify_receipt` | Offline-verify a signed v6 trust receipt |
| `get_facilitator_footprint` | Which x402 facilitators a payer has used |
| `get_counterparties` | Top merchants a wallet pays (capped teaser) |
| `score_wallets_batch` | Score up to 25 wallets in one call |
| `compare_wallets` | Side-by-side intel for two wallets |
| `verify_root_inputs` | Independent WZRD protocol root verification |

---

## Paid Trust Call (x402, 0.05 USDC)

```
GET https://intel.twzrd.xyz/v1/intel/trust/{pubkey}?seller_wallet=<seller>
```

Returns the full renormalized trust model + portable Ed25519-signed v6 receipt.

---

## Verify Receipts Offline (trust no one)

```bash
npx twzrd-receipt-verifier receipt.json --pubkey <published key>
# or: pip install twzrd-receipt-verifier
```

---

## Related

- [Receipt Verifier](https://github.com/twzrd-sol/twzrd-receipt-verifier) — read the code
- [Live Orientation](https://intel.twzrd.xyz/llms.txt) — full agent guide
- [API Spec](https://intel.twzrd.xyz/openapi.json) — OpenAPI 3.1 with x402

---

## License

MIT — see [LICENSE](./LICENSE). Each package independently MIT-licensed.

**Scoring engine IP is protected.** The proprietary intel scoring, wash detection,
and trust renormalization models remain private in the TWZRD monorepo.
Agents consume them through the live API — no source needed.