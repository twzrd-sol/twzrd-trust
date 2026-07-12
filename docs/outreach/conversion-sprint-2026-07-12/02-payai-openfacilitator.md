# Channel 2: PayAI / openfacilitator

**Status:** draft ready (send after 2s.io is in flight)  
**Done signal:** one agent on their rail hits TWZRD preflight before settle  
**Leverage:** one integration vets many agents.

## Public proof URL

https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md

## Message

```
Subject: optional settle-time trust check for payments on your rail

You settle x402 payments agent → seller. We score seller wallets for wash-trade / sybil risk from observed Solana x402 settlement history, and we independently verify which catalog endpoints actually issue live 402 challenges (listed ≠ live).

The ask: add one optional callback before you settle —

  POST https://intel.twzrd.xyz/v1/intel/preflight
  { "seller_wallet": "<seller>", "price_usdc": <amt> }
  → readiness_card { decision: block | warn | allow, can_spend, trust_score, caveats[] }

Free, fail-open (timeout / non-2xx → you settle as normal), gives every agent on your rail a "don't pay this one" signal at no cost.

For client-side enforcement (no rail change required), agents can wrap fetch before wallet signing:

  npm i twzrd-x402-gate@0.5.3
  installTwzrdAutoGate(payWrap, { gateOnCanSpend: true })

Five-minute zero-spend proof (no USDC):
https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md

Happy to pair on integration. If useful, paid tier (portable signed receipts, batch scoring) can revenue-share or white-label.
```

## Pairing doc

Remote MCP (23 tools, free preflight): `https://intel.twzrd.xyz/mcp`  
OpenAPI: `https://intel.twzrd.xyz/openapi.json`