# TWZRD Internal Mechanism Proof (superseded) - 2026-07-16

> **Relabeled 2026-08-19.** This is a TWZRD-operated dogfood run on `twzrd-x402-gate@0.7.1`,
> not external adoption evidence — the original "External" title overstated it. It is
> superseded by
> [`20260819-refuse-and-clean-control-0.8.18.md`](./20260819-refuse-and-clean-control-0.8.18.md),
> which runs the published 0.8.18 package, measures `signer_invocation_count=0` directly,
> and adds a clean-control leg. (`transaction_broadcast_count=0` is derived there from zero
> signer invocations rather than emitted by the block-leg CLI; see that file's note.)

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
- Action: no full payment sent; broadcast recorded as "absent or capped at $0".
  (This phrasing is ambiguous and is one reason this artifact is superseded — the
  0.8.18 transcript measures `signer_invocation_count=0` and `usdc_spent=0` directly.)
- Dogfood run (npm run wash-dogfood): ALL PASS

This is the reproducible critical-path refuse. Agents using the gate see block and do not pay full amount.

Reproducible by anyone installing the gate and targeting the fixture.

Transcript generated from live preflight + gate enforcement.