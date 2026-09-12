---
name: twzrd-trust
description: |
  Don't let your agent sign blind. Discover x402 callables then check the seller BEFORE paying. Free resource join
  (GET /v1/intel/resources) lists listed|live_402 claims; free preflight returns a
  ReadinessCard (allow / warn / block) from the observed Solana x402 corpus. Composes
  with any x402 payer skill: discover → merchant_card wash refuse → preflight →
  gate_eval (AutoGate) when you control signing → optional pay; abort on decision=block.

  WHAT YOU GET FREE: resource join (source of truth), multi-bazaar directory overlay, pre-spend
  ReadinessCard, merchant_card (wash_flagged refuse), wallet scores, secondary payer
  leaderboard research, counterparty + facilitator footprint, wash/sybil detection,
  batch + compare, offline receipt verify; route settle through TWZRD for free
  merchant_attach + twzrd_receipt on POST /settle.
  PAID clearance (x402, USDC on Solana): $0.001 signed twzrd.payment_decision.v1 via
  GET /v1/intel/quick/{pubkey} (quickCheck). Advisory preflight is free ($0).
  Optional Path A / merchant receipts at $0.05 are not the primary product.
  TRIGGERS: should I pay this, is this wallet safe, check seller, x402 preflight, scam
  check, counterparty risk, wallet reputation, trust score, verify receipt, before
  paying, solana wallet check, agent trust, readiness card, wash flagged, merchant card,
  resource join, discover x402, facilitator settle, merchant attach, track record
homepage: https://intel.twzrd.xyz
metadata:
  version: "1.13.24"
  canonical_url: https://intel.twzrd.xyz/skill.md
  gate_npm: twzrd-x402-gate@0.9.6
  x402_solana_npm: x402-solana@3.0.0
  # Floor, not an exact pin: a receipt verifier should track the newest
  # signature-checking code, and an exact pin goes stale on every publish.
  # Floor must stay >= 1.4: V7 binds freshness fields and older published
  # verifiers reject V7 receipts (see test_receipt_verifier_pin.py).
  verifier_npm: "twzrd-receipt-verifier@^1.4.0"
  openclaw:
    requires:
      bins: [curl]
    envVars:
      - name: TWZRD_MCP_URL
        required: false
        description: >-
          Override MCP endpoint (default https://intel.twzrd.xyz/mcp).
      - name: TWZRD_REFUSE_WASH_FLAGGED
        required: false
        description: >-
          Gate default is refuse on wash_flagged. Set 0 only to opt out.
---
