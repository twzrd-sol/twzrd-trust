# Settle-gate enforce activation — dated note, 2026-08-19

**What changed.** On 2026-08-19 the hosted settlement path (`intel.twzrd.xyz`)
moved from shadow to enforce. `GET /health` now reports
`settle_gate_enabled: true`, `settle_gate_shadow: false`,
`settle_gate_enforcing: true`, `settle_gate_threshold: 35`. In this posture a
below-threshold seller counterparty is refused settlement — HTTP 402,
`charged: false`, no transaction — on `POST /settle` and on the paid routes
that accept a seller counterparty parameter.

**Preconditions in place before the flip** (each verifiable in
`twzrd-sol/wzrd-final` history):

- The gate was seated on the path that actually settles, with durable
  per-decision logging to the `x402_gate_decisions` ledger (#2049, merged
  2026-08-19).
- Internal house payers were exempted (#2078), so the gate cannot refuse
  TWZRD's own operational traffic and an enforce error cannot be masked by a
  house workaround.
- The decision threshold (35) was set in runtime config before activation and
  is published on `GET /health`.

**Why activate now.** The settle rail has zero independently operated seller
adoption — the same fact Milestone 3 of the grant proposal exists to change,
and the same zero TWZRD's own adoption scoreboard records for it. Gate
evaluations in the decision ledger to date (11 rows as of this note: 8
shadow-mode rows from late July, 3 on activation day) trace to TWZRD-operated
or test wallets. There is therefore no independent counterparty a wrong block
can currently harm, and enforcement in this state changes no live outcome
until the first independent request arrives — which will then meet the real
posture rather than a shadow simulation.

**What this note is not.** The grant proposal's Milestone 3 protocol — publish
a named sample-size/error threshold and an evaluation over real shadow traffic
*before* enforce activation — was not completed before this flip, because no
real (non-TWZRD) traffic existed to evaluate. This note is dated the same day
as the activation and follows it by hours; it does not claim the
propose-then-activate order. The sequencing is disclosed rather than restated
as satisfied.

**Standing rule going forward (the go/no-go).**

1. Before the first independently operated integration sends settle traffic,
   TWZRD publishes the named sample-size/error threshold for gate decisions,
   with "wrong block" defined as a refusal of a counterparty that the
   published wash/score method subsequently evaluates as clean.
2. Once real traffic exists, TWZRD publishes the evaluation of gate decisions
   over that traffic against the published threshold.
3. If the observed error exceeds the threshold, the gate returns to shadow
   mode (`settle_gate_shadow: true`) and a dated written pause note is
   published. Safety takes precedence over claiming enforcement.

**Classification.** This is an internal posture change. It is not recorded as
revenue, adoption, or an independent-outcome claim under any milestone.
