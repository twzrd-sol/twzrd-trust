# Agent Card: TWZRD Agent Intel

**Category:** Trust & Reputation / Solana x402
**Transport:** MCP (streamable HTTP)
**Endpoint:** `https://intel.twzrd.xyz/mcp`
**Pricing:** Free (all MCP tools) + x402 paid trust receipts at $0.05 USDC

## What it does

Provides agentic intelligence for the Solana x402 economy. Before an agent pays
a seller over x402, it calls the free preflight to get a ReadinessCard with
trust score, risk factors, and a spend decision (allow/warn/block).

After payment, the agent can verify the signed receipt offline.

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

Then call `get_readiness_card_tool(seller_wallet="...")` before every x402 payment.

## Scoring model

Public: transparent heuristic (volume log + breadth + spend + recency decay),
formula returned inline as `score_model` on every response.

Private: proprietary trust renormalization, wash detection algorithms, and
corpus machine learning — these run server-side only.

## Links
- GitHub: https://github.com/twzrd-sol/twzrd-trust
- Live API: https://intel.twzrd.xyz/openapi.json
- llms.txt: https://intel.twzrd.xyz/llms.txt
- Receipt verifier: https://github.com/twzrd-sol/twzrd-receipt-verifier
