# Changelog

All notable changes to `twzrd-x402-gate`. Dates are npm publish dates (UTC).

## Versioning policy (from 0.11.0)

- **A change to what the gate allows or refuses ships in a minor release** (0.x.0 while
  the package is below 1.0), with an entry here. Below 1.0, npm's caret range stays
  within one minor (`^0.11.0` never resolves to 0.12.0), so nobody gets a new refusal
  policy without choosing it.
- **Patch releases** (0.x.y) carry fixes that do not change any allow/refuse outcome
  for a well-formed card, plus docs, types and tests. A patch may add a refusal to
  close a security defect, so that `^0.x.0` installs pick the fix up; a patch never
  loosens one.
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

## 0.11.3 — 2026-10-01 (security fix)

Follow-up to a red-team of the published 0.11.2. Every change adds a refusal or makes one reliable.

- **One flag parser.** `failOpen` (override, wash seat, seller hook), `cloudflare-base` `failOpen` and `refuseUnevaluated`, and the MPP `treatWarnAsBlock`
  read a boolean the same way: true, 1, or true/1/yes/on in any case are on; anything else is off, and a typo warns once. `failOpen: "false"` no longer
  opens on an outage.
- **`createTwzrdPayingFetch` and `createTwzrdPolicyFetch` check every offer**, as the other wrappers do since 0.11.2, and refuse an entry with no recipient.
- **`./cloudflare-base` has a deadline** (`intelTimeoutMs`, default 2000) and honours string flags.
- An `async` `onReceipt` that rejects no longer crashes the host. `intelTimeoutMs` above 2^31-1 is clamped instead of becoming 1 ms (the main gate config and the Base Worker; `timeoutMs` on the wash seat and settle guard is not clamped and fails closed by default). `createTwzrdPolicyFetch` books the costliest offer in the spend ledger, since the client may pay any entry.
- Behavior changes to note: on the paying and policy fetch wrappers a 402 with a legitimate entry plus a sibling that has no recipient (e.g. another rail) is now refused whole (`twzrd_unidentifiable_payment_recipient`), matching `wrapFetchWithTwzrdGate`; more than 8 distinct entries is refused (`too_many_payment_options`); settle-guard `failOpen` of `"false"`/`"0"`/`0` now fails closed (was open).

## 0.11.2 — 2026-09-28 (security fix)

Fixes from a line-by-line audit of the published 0.11.1. Every change adds a
refusal or makes an existing one reliable; none loosens one.

- **Malformed amounts are refused on every entry point** (`amount_malformed`,
  before intel). An amount must be an ASCII base-unit integer: no sign, decimal
  point, exponent, whitespace or non-ASCII digit. Signing schemes build the
  transfer from this string, so there is no safe reading of anything else.
  `twzrd.safeFetch` keeps reporting it as `malformed_amount`. A computed
  `priceUsdc` that is negative or not finite is refused as `twzrd_invalid_price`.
- **Fetch wrappers and the MCP hook check every offer.** `withTwzrdGuard`,
  `wrapFetchWithTwzrdGate`, `installTwzrdAutoGate(payWrap)` and
  `twzrdOnPaymentRequested` scored one `accepts[]` entry while the paying client
  could choose another. Every distinct entry now gets the free approval (one
  preflight each; paid hops run once), and more than 8 distinct offers are
  refused (`too_many_payment_options`). The x402 client hooks already scored
  the selected entry and are unchanged.
- **`./cloudflare-base` applies the package's signing rules** to the Base USDC
  entry: asset, amount, block, wash, never-evaluated cap, score floor and
  recommended cap. It used to sign on any non-block verdict. The price is read
  from the entry's own `amount`; the `priceUsdc` option no longer affects the
  decision. New options `preflightMinScore` and `refuseUnevaluated`.
- **Genuine USDC is no longer refused as `twzrd_non_usdc_asset`** when the 402
  omits the network or names Solana mainnet as `mainnet-beta` or by its bare
  genesis id. One Solana cluster reading (`solanaCluster`) now serves both the
  network classifier and the USDC table; `solana:devnet` uses the devnet mints.
  Solana mints are compared exactly (base58 is case-sensitive).
- **Intel calls have a deadline.** New option `intelTimeoutMs` (env
  `TWZRD_INTEL_TIMEOUT_MS`, default 2000). A free preflight or merchant-card call
  that misses it is an outage, decided by `failOpen` as before. Paid hops are
  not cut off mid-payment.
- **Callbacks cannot change a decision.** A throwing or rejecting `onWarnUpsell`
  no longer crashes the host or turns into `twzrd_fail_open`; a throwing
  `onReceipt` no longer turns a paid receipt into a deny.
- A merchant-card outage allowed under `failOpen` is marked
  (`cardUnreachable: true` and a warning) instead of looking like a clean card.
- No paid `/trust` receipt and no `onWarnUpsell` for a seller intel has never
  evaluated (the same rule as the `/quick` hop since 0.11.0).
- `refuseUnevaluated` and `gateOnCanSpend` accept `true`, `1`, `"true"`,
  `"yes"`, `"on"` in any case; a typo no longer leaves strict mode silently off.
- A non-list `accepts` or a null entry is no offer, never a TypeError.
- Two spellings of the same 0x address in `payTo` / `pay_to` are one recipient.
- `createTwzrdPayingFetch` and `createTwzrdPolicyFetch` name the missing
  `@x402/fetch` peer instead of throwing a bare module error.
- The unreachable `dist/unsafe.js` is no longer shipped, and the README no
  longer documents a `twzrd-x402-gate/unsafe` import. LICENSE ships in the
  package.

Deliberately unchanged: a Solana devnet payment named only by its CAIP-2 id is
still scored (integration harnesses rely on it reaching the preflight).

## 0.11.1 — 2026-09-28 (security fix)

**A requirement that names an asset other than USDC is refused on Solana and Base.**

- `amount` is in the named asset's base units, but every price the gate computed was
  `amount / 1e6`, i.e. it assumed USDC. A seller could name another mint (for example
  one with 8 decimals) at `amount: "100000"`: the gate read $0.10, inside the 0.11.0
  unevaluated-seller cap and inside an evaluated seller's cap, while the signed
  transfer moved 0.001 of that token. Intel's own cap was computed from the same
  number, because the preflight is not told the asset.
- `twzrdApprovePayment` now refuses, before intel, when the requirement names an asset
  that is not USDC on a scored network (Solana mainnet, Base mainnet):
  `twzrd_non_usdc_asset`. It is not an outage, so `failOpen` does not apply. Every
  adapter passes the asset through: the x402 client hook (`createTwzrdBeforePaymentHook`,
  AutoGate, PayKit), `evaluate_x402_resource`, `withTwzrdGuard`, `wrapFetchWithTwzrdGate`,
  the MCP hook, `safeFetch` and the Payment Control intelligence provider.
- `priceUsdcFromAmountMicro(amount, requirement)` returns `undefined` for a non-USDC
  asset on a network with a known USDC set (Solana clusters, Base, Base Sepolia).
  Other networks keep the old reading. A devnet USDC mint named on mainnet is not USDC.
- `twzrd.safeFetch` refuses a non-USDC asset with `non_usdc_asset`: its budget counts
  micro-USDC, so another asset was counted in the wrong units.
- New exports: `isUsdcRequirement`, `requirementAsset`. `TwzrdApproveContext` gains
  `asset`.
- Unchanged: a requirement that names no asset, USDC itself, and unscored networks.
  (Corrected in 0.11.2: the schemes do not default an unnamed asset to USDC.
  x402-solana refuses a requirement with no mint and @x402/svm fetches the mint
  before building the transfer, so an unnamed asset fails before signing.)
- Who was exposed: clients on `@x402/core` ≥2.23 with default spend controls already
  refused an unrecognised asset before any TWZRD hook ran. The exposure was the PayAI
  `x402-solana` path, clients with spend controls turned off, and older core.
  0.11.0 widened it from evaluated sellers to any never-seen seller.

## 0.11.0 — 2026-09-28

**Behaviour change: unevaluated sellers follow the card's cap.**

- A seller intel has never evaluated (`null_reason` set, or `score: null`) is no longer
  refused outright. Live intel answers such a seller with `decision: "warn"` and a
  `recommended_cap_usdc` of min($0.10, requested price) on 2026-09-28; the gate now allows the
  payment at or under that cap (`twzrd_unevaluated_within_cap_<price>_le_<cap>`) and
  refuses it above the cap, when the card has no cap, or when the price is unknown.
  An approval carries `unevaluated: true` and `score: null`. The free wash check still
  runs after it.
- New option `refuseUnevaluated` (env `TWZRD_REFUSE_UNEVALUATED`), default `false`.
  `true` restores the 0.9.9–0.9.16 behaviour: every unevaluated seller is refused with
  `twzrd_unevaluated_subject_<null_reason>`. The bounty preflight CLI sets it, so bounty
  payees are still refused when unevaluated.
- Direct callers of the exported `evaluateReadinessCard` must pass `priceUsdc` to get
  an approval for an unevaluated card. Without it the reason is now
  `twzrd_unevaluated_unknown_price_<null_reason>` (was
  `twzrd_unevaluated_subject_<null_reason>`); `approved` is still `false`.
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

Entries below were reconstructed on 2026-09-28 by diffing the published tarballs, so
each change is listed under the first version that actually contains it. Several of
them changed allow/refuse or paid behaviour in a patch release; 0.11.0's policy exists
because of that.

## 0.9.12 — 2026-09-26 (paid behaviour change in a patch release)

- Buyer Path A defaults changed. With `x402Fetch` wired and the flags unset, a `warn`
  now takes the $0.001 `/quick` hop at any price; before, a `warn` at $2.50 or more
  bought the $0.05 receipt. `requireReceipt` default `onWarn` went from `true` to
  `false`.

## 0.9.11 — 2026-09-26 (behaviour change in a patch release)

- An `accepts[]` entry whose v1 and v2 price fields (`maxAmountRequired` / `amount`)
  or recipient fields (`payTo` / `pay_to`) disagree is refused on every path
  (`amount_field_conflict` / `payto_field_conflict`). New export
  `resolveRequirementFields`.

## 0.9.10 — 2026-09-20 (behaviour change in a patch release)

- The wash engine no longer hardcodes allow on an intel outage (timeout, 5xx, 429,
  throw, bad JSON). New modules: `attempt-echo`, `cloudflare-x402`, `foreign-key`,
  `paying-fetch`, `policy-fetch`, `wash-default`. See `COMPATIBILITY.md`.

## 0.9.9 — 2026-09-15 (behaviour change in a patch release)

- Base mainnet (`eip155:8453`) is scored instead of abstaining.
- **A seller intel never evaluated is refused** (`twzrd_unevaluated_subject_*`). Every
  new seller was refused before signing. 0.11.0 reverses the default.

## 0.9.8 — 2026-09-13 (behaviour change in a patch release)

- A merchant-card outage obeys `failOpen` instead of silently allowing. Before this, a
  card lookup that failed was treated as "no wash signal" and allowed the payment even
  with `failOpen: false`.

## 0.9.7 — 2026-09-12

- `evaluateIntent` re-checks the mandate ceiling and new-counterparty cap in the same
  step that records the spend, so two concurrent intents can no longer both clear one
  ceiling.
- `safeFetch` hands the payer only the offer the gate approved (`accepts: [selected]`),
  not the whole `accepts[]`.

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
