# Agent Card: TWZRD Agent Intel

**Category:** Trust & Reputation / Solana x402
**Transport:** MCP (streamable HTTP)
**Endpoint:** `https://intel.twzrd.xyz/mcp` (streamable HTTP)
**Pricing:** Free advisory preflight ($0). Signed execution clearance **$0.001** (`twzrd.payment_decision.v1` / `quickCheck`). Optional Path A intel receipts are $0.05 and are not the primary SKU. Product-listing checks (`check_listing`) are free; the optional checkout brief is $0.001.

## What it does

Provides agentic intelligence for the Solana x402 economy. Before an agent pays
a seller over x402, it calls the free preflight to get a ReadinessCard with
trust score, risk factors, and a spend decision (allow/warn/block).
Blocks happen with zero signer invocations (`signerInvocations: 0`).

After payment, the agent can verify the signed receipt offline.

It also checks a store listing before an agent buys from it. `check_listing(product_url, declared_unit_price)`
compares the product URL and the asking price with TWZRD's published listing-claim card (one
reference card today; an observer card, not a merchant attestation). A price above the
advertised one is refused; a price below it, or a card with no advertised price, sets
`needs_approval` so a human approves. `authorizes_spend` is always false.

## Trust loop

1. **Preflight** (free) — score the seller
2. **Decision** — block → stop. warn/allow → proceed
3. **Pay** — sign the x402 payment
4. **Verify** (free) — check the returned signed receipt

## For agent developers

Add this server to your MCP client config:
```json
{
  "mcpServers": {
    "twzrd-agent-intel": {
      "url": "https://intel.twzrd.xyz/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Then call `get_readiness_card_tool(seller_wallet="...")` before every x402 payment, and
`check_listing(product_url, declared_unit_price)` before buying a store product.

## Scoring model

Public: transparent heuristic (volume log + breadth + spend + recency decay),
formula returned inline as `score_model` on every response.

Private: proprietary trust renormalization, wash detection algorithms, and
corpus machine learning — these run server-side only.

## Links
- GitHub: https://github.com/twzrd-sol/twzrd-trust
- Live API: https://intel.twzrd.xyz/openapi.json
- llms.txt: https://intel.twzrd.xyz/llms.txt
- Shopping check: https://twzrd.xyz/shopping-check/vuori-kore/
- Receipt verifier: https://github.com/twzrd-sol/twzrd-receipt-verifier
