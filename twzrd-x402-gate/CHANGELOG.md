# Changelog

All notable changes to `twzrd-x402-gate`. Dates are npm publish dates (UTC).

## Versioning policy (from 0.11.0)

- **A change to what the gate allows or refuses ships in a minor release** (0.x.0 while
  the package is below 1.0), with an entry here. Below 1.0, npm's caret range stays
  within one minor (`^0.11.0` never resolves to 0.12.0), so nobody gets a new refusal
  policy without choosing it.
- **Patch releases** (0.x.y) carry fixes that do not change any allow/refuse outcome
  for a well-formed card, plus docs, types and tests.
- The package is published from this repository only, by the `publish` workflow with an
  `expected_version` input, with npm provenance.

## failOpen, stated once

- **Buyer side** (`createTwzrdBeforePaymentHook`, `createGuardedX402Fetch`,
  `withTwzrdGuard`, `evaluate_x402_resource`): fail-closed by default. A preflight that
  returns any non-2xx status or a non-JSON body, or throws, refuses with
  `twzrd_fail_closed`.
  A free merchant-card lookup that returns 5xx/429, a non-JSON body, or throws refuses
  with `twzrd_card_unreachable_fail_closed`. With `failOpen: true` (or
  `TWZRD_FAIL_OPEN=1`) both allow instead. A merchant-card 4xx is intel answering,
  not an outage, and never refuses on its own.
- **Seller side** (`createTwzrdSettleGuard`): fail-open by default. A screen that throws
  returns without aborting settlement unless `failOpen: false`.

## 0.11.0 — unreleased

**Behaviour change: unevaluated sellers follow the card's cap.**

- A seller intel has never evaluated (`null_reason` set, or `score: null`) is no longer
  refused outright. Live intel answers such a seller with `decision: "warn"` and a
  per-seller `recommended_cap_usdc` ($0.01 on 2026-09-28); the gate now allows the
  payment at or under that cap (`twzrd_unevaluated_within_cap_<price>_le_<cap>`) and
  refuses it above the cap, when the card has no cap, or when the price is unknown.
  An approval carries `unevaluated: true` and `score: null`. The free wash check still
  runs after it.
- New option `refuseUnevaluated` (env `TWZRD_REFUSE_UNEVALUATED`), default `false`.
  `true` restores the 0.9.9–0.9.16 behaviour: every unevaluated seller is refused with
  `twzrd_unevaluated_subject_<null_reason>`. The bounty preflight CLI sets it, so bounty
  payees are still refused when unevaluated.
- The $0.001 `/quick` escalation (`escalateOnWarn`) no longer runs for an unevaluated
  seller: intel has no paid score for it either, so the hop spent money without being
  able to change the decision.
- Why a minor: 0.9.9 made "never evaluated" a refusal in a patch release, which meant
  every new seller was refused before signing even when intel itself said "warn,
  within cap". This reverses that default, so it ships as a minor.
- **Why 0.11.0 and not 0.10.0:** see the 0.10.x entry below. Those version numbers are
  taken on npm.

Unchanged in 0.11.0: attribution headers. Every preflight still sends
`X-TWZRD-Client` and `X-Twzrd-Caller` (the gate version); `X-TWZRD-Integration` and
`X-TWZRD-Run-Id` are sent only when `attribution` is configured.

## 0.9.16 — 2026-09-28

- `createGuardedX402Fetch` recognises devnet USDC (Circle and faucet mints) on Solana
  devnet instead of treating it as an unknown asset.
- An `@x402/core` spend-control refusal is rethrown with a hint explaining that core's
  default controls ran before the TWZRD hook.
- A missing optional `@x402/fetch` peer throws an install hint instead of a bare import
  error.

## 0.9.15 — 2026-09-27

- Docs: the package README explains `@x402/core` ≥2.23 default spend controls
  (recognised assets, $1 per payment), which run before any `beforePaymentCreation` hook.

## 0.9.14 — 2026-09-27

- Tests run against `@x402/core` ^2.26 with its default spend controls on. No `src`
  change.

## 0.9.13 — 2026-09-26

- `safeFetch` counts a `pay()` that throws after the signer ran against the budget,
  instead of releasing it.

## 0.9.10 – 0.9.12 — 2026-09-20 to 2026-09-26

- Source ported and reconciled between the two trees the gate was developed in.

## 0.9.9 — 2026-09-15 (behaviour change in a patch release)

- Base mainnet (`eip155:8453`) is scored instead of abstaining.
- **A seller intel never evaluated is refused** (`twzrd_unevaluated_subject_*`). This
  changed allow/refuse outcomes in a patch release; 0.11.0 reverses the default.

## 0.9.7 – 0.9.8 — 2026-09-12 to 2026-09-13 (behaviour change in a patch release)

- A merchant-card outage obeys `failOpen` instead of silently allowing. Before this, a
  card lookup that failed was treated as "no wash signal" and allowed the payment even
  with `failOpen: false`.
- `evaluateIntent` ledger race closed.

## 0.9.4 – 0.9.6 — 2026-09-07 to 2026-09-12

- 0.9.4: `./unsafe` removed from the exports map and from the release contract. The
  version line was moved from 0.10.1 back to 0.9.4 (see below).
- 0.9.5: portable payment decisions (`twzrd.payment_decision.v1`) with an offline
  verifier.
- 0.9.6: reproducible build.

## 0.10.0, 0.10.1 — 2026-09-02, 2026-09-07 (deprecated)

- Both exported `./unsafe`, a documented signature-bypass export, because the release
  contract at the time required it for a "complete" release. Both also carried the
  merchant-card fail-open defect fixed in 0.9.8, and neither build is reproducible from
  source in git.
- Both are deprecated on npm. The line continued at 0.9.4. Semver ranks 0.10.1 above
  every 0.9.x, so an install pinned to `^0.10` stays on the deprecated line: move to
  `^0.11.0`.
