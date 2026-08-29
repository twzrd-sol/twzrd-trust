# TWZRD Agent Intelligence — Counterparty Trust & Spend Control for Solana x402

> **100% Free • No API Key • No Wallet Required • Zero Config**

Vet any counterparty wallet **before** you sign or send USDC over x402. Blocks happen before your private key is ever reached (**`signerInvocations: 0`** on block) — protecting your agent against malicious sellers, wash trading, and unvetted contracts.

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

## Sample Preflight Responses

### 1. Blocked Seller (`wash_flagged`)
```json
{
  "decision": "block",
  "trust_score": 12,
  "can_spend": false,
  "reason": "twzrd_wash_flagged",
  "risk_factors": ["wash_trading_cluster", "circular_flow_detected"]
}
```

### 2. Allowed Seller (Verified Counterparty)
```json
{
  "decision": "allow",
  "trust_score": 92,
  "can_spend": true,
  "recommended_cap_usdc": 10.00
}
```

---

## Data Sent & Privacy Disclosure

- **What is sent:** Target seller wallet address, requested resource URL, and proposed spend amount.
- **What is NEVER sent:** Private keys, seed phrases, client keystores, or internal agent prompts.
- **Custody:** Non-custodial. TWZRD never executes transactions on your behalf.

---

## How to Install

### Option A: Zero-Install Hosted MCP (Recommended — 24 Tools)
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
npm install twzrd-x402-gate@0.9.2 x402-solana@3.0.0
```

---

## Performance & Availability
- **Latency:** ~45ms average preflight response time.
- **SLA & Uptime:** 99.9% availability backed by global edge infrastructure. Fail-open and fail-closed policies configurable via client options.
