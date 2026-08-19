# TWZRD Internal Mechanism Proof - 2026-07-16 (superseded)

> **Superseded by [`20260819-refuse-0.8.18-transcript.md`](./20260819-refuse-0.8.18-transcript.md).**
>
> This artifact was previously titled "External Refuse Proof". That title was wrong:
> the run is a TWZRD dogfood on an owned fixture, as its own setup section states, and it
> is **not** external adoption evidence. It also predates the signer-spy harness, so it
> records no `signer_invocation_count`, and it runs `0.7.1` rather than the currently
> published gate. Retained for provenance; cite the 0.8.18 transcript instead.

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