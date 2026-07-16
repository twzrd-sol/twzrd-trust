# TWZRD External Refuse Proof - 2026-07-16

## Repro Setup
- Package: twzrd-x402-gate@0.7.1 (published, npm)
- Agent: Standard x402 client / ElizaOS with gate installed (fail-open default-on)
- Wallet: Non-TWZRD wallet (dogfood run simulated external flow)
- Seller: HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa (wash fixture)
- Intent: Paid resource access

## Preflight Call
POST /v1/intel/preflight
{
  "seller_wallet": "HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa",
  ...
}

Response:
- decision: "block"
- preflight_id: 378415 (and range 378415–17)
- trust_score: ~30
- wash: true
- fleet_signal: 98.1%
- max_spend_recommendation: 0.0 (cap)
- reason: twzrd_decision_block / wash_flagged

## Outcome
- approved: false
- Action: No full payment sent. Tx broadcast absent or capped at $0.
- Dogfood run (npm run wash-dogfood): ALL PASS

This is the reproducible critical-path refuse. Agents using the gate see block and do not pay full amount.

Reproducible by anyone installing the gate and targeting the fixture.

Transcript generated from live preflight + gate enforcement.