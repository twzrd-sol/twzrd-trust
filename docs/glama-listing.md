# TWZRD Agent Intelligence — Counterparty Trust & Spend Control for Solana x402

> **Free tools • No API Key • No Wallet Required • Zero Config**

Vet any counterparty wallet **before** you sign or send USDC over x402. Blocks happen before your private key is ever reached (**`signerInvocations: 0`** on block) — protecting your agent against malicious sellers, wash trading, and unvetted contracts.

Advisory preflight is free ($0). Signed execution clearance is **$0.001** (`twzrd.payment_decision.v1` / `quickCheck`). Optional Path A V7 receipts are $0.05 and are not the primary SKU. Pin: `twzrd-x402-gate@0.11.2`.

---

## Zero-Setup 60-Second Proof

Run this one-line command to see a live preflight refusal with zero spend:

```bash
curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate | jq '{verdict: (.steps[] | select(.name == "block_path") | .verdict), approved: (.steps[] | select(.name == "block_path") | .approved), signerInvocations: (.steps[] | select(.name == "block_path") | .signer_invocations), mode, ok}'
```

Expected output:
```json
{
  "verdict": "block",
  "approved": false,
  "signerInvocations": 0,
  "mode": "no_spend",
  "ok": true
}
```

---

## Sample Responses

Trimmed from live responses on 2026-10-01. The warn is the free preflight (`POST /v1/intel/preflight`) for a seller TWZRD has seen; the block is the no-spend demo gate. Field values change as the observed corpus changes; run the calls yourself for current output.

### A warn: proceed only within the cap
```json
{
  "decision": "warn",
  "can_spend": true,
  "recommended_action": "proceed_with_cap",
  "maximum_recommended_spend_usdc": 0.01,
  "confidence": "medium",
  "wash_flagged": false
}
```

### A block: the signer is never invoked
```json
{
  "verdict": "block",
  "approved": false,
  "signer_invocations": 0,
  "reason": "trust decision=block: gate aborts, wallet never contacted"
}
```

---

## Product Listings (Agent Shopping)

Before an agent buys a product from a store, the free `check_listing(product_url, declared_unit_price)` tool
compares the product URL and the asking price with TWZRD's published listing-claim card (one reference card today: Vuori Kore Short, Ink, US;
an observer card, not a merchant attestation). A price above the advertised one is refused
(`phantom_markup_detected`); a price below it, or a card with no advertised price, sets `needs_approval`.
`authorizes_spend` is always `false`, and purchase completion and delivery are not verified.
Report: https://twzrd.xyz/shopping-check/vuori-kore/

---

## Data Sent & Privacy Disclosure

- **What is sent:** Target seller wallet address, requested resource URL, and proposed spend amount; for a listing check, the product URL, the declared unit price, and any optional subject fields (merchant, product, market, variant).
- **What is NEVER sent:** Private keys, seed phrases, client keystores, or internal agent prompts.
- **Custody:** Non-custodial. TWZRD never executes transactions on your behalf.

---

## How to Install

### Option A: Zero-Install Hosted MCP (Recommended)
Add to your Cursor / Claude / Windsurf MCP config:
```json
{
  "mcpServers": {
    "twzrd": {
      "url": "https://intel.twzrd.xyz/mcp"
    }
  }
}
```

### Option B: Node SDK / Local Package
```bash
npm install twzrd-x402-gate@0.11.2 x402-solana@3.0.0
```

---

## Outage behavior

The gate and the plugins fail closed by default: if the TWZRD checks are unreachable, the payment is refused. Set the fail-open option only if you want payments to continue when the checks are down.
