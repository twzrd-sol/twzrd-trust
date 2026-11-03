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

## Unreleased (Demand Desk replay guard)

- **New, opt-in: `createDemandDeskWallet({ replayGuard: { ledger, intentHash } })`.** With an
  outcome ledger (#274) attached, a vault spend whose intent hash the ledger holds in
  `signing`, `unknown`, `completed` or `paid_incomplete` is refused before the signer runs,
  throwing `DemandDeskReplayError` with code `vault_spend_replay`. `refused`, `expired` and
  `not_settled` allow a new spend. An `approved` record is moved to `signing` synchronously
  right before the signer call. Two items with the same intent hash in one batch are refused
  (`duplicate_in_batch`), and neither is signed. Without `replayGuard`, nothing changes.

## 0.16.0 - 2026-10-30 (Foundation MPP charge reaches preflight)

A minor release under the policy above: a Foundation `@solana/mpp` solana/charge
that used to throw `MALFORMED_CHALLENGE` can now reach preflight and be allowed.
`^0.15.0` installs never receive it.

- `mppChallengeToIntent` reads `decimals` and `network` from `methodDetails` when
  they are absent at the top level. A string `decimals` stays `MALFORMED_CHALLENGE`.
  When the top level and `methodDetails` name `recipient`, `currency`, `amount`,
  `decimals`, or the cluster (`cluster` / `network`) with two different values,
  the charge is `MALFORMED_CHALLENGE`. `@solana/mpp` 0.7.0 pays
  `methodDetails.network` and `methodDetails.decimals`, and the top-level
  `amount`, `currency`, and `recipient`.
- A non-empty `splits` array on the request or under `methodDetails` is
  `MALFORMED_CHALLENGE`. That client pays each split recipient in addition to
  the primary. An empty array is not a split.
- A USD-pegged mint must belong to the named cluster. `mainnet` and
  `mainnet-beta` are one cluster and accept mainnet mints only. `devnet`
  accepts devnet mints only. `testnet`, `localnet`, and `localhost` are
  refused for these mints. `@solana/mpp` 0.7.0 does not rewrite a raw mint
  to the network's mint, and it will sign a seller-supplied blockhash.
- `methodDetails.feePayer: true` is the sponsored SOL fee payer on intel.twzrd.xyz.
  It is not the second token transfer (`sponsored`, `sponsorPath`, `feeTokenAmount`),
  so it does not throw `SPONSORED_CHARGE`.
- The intel server challenge bytes are unchanged. npm `0.15.0` does not parse the
  live MPP seat.

## 0.15.0 - 2026-10-26 (Demand Desk authorization 2.1.0: Compute Budget and one Memo)

A minor release under the policy above: it adds an allow outcome. Nothing a 2.0.0
authorization allows or refuses changes, and `^0.14.0` installs never receive it.

- **New contract version `2.1.0-demand-desk`.** `verifyDemandDeskAuthorization` accepts it
  beside `2.0.0-demand-desk`. Its `settlement_constraints` add `memo_sha256` (hex or null)
  and `max_compute_unit_limit`, both signed. Each version has its own exact field list, so a
  2.0.0 token carrying either field is `invalid_shape`.
- **A 2.1.0 message may be `[SetComputeUnitLimit?, SetComputeUnitPrice?, Memo?, vault spend]`.**
  Each slot appears at most once, in that order. Compute Budget instructions take no accounts
  and exact-length data, a price needs a limit, and the limit must be between 1 and
  `max_compute_unit_limit`. The Memo is SPL Memo v2 with no accounts and 1 to 512 bytes of
  printable ASCII, present exactly when `memo_sha256` is not null, and its bytes must hash to
  it. Anything else is `instruction_mismatch`.
- **The priority fee counts against the signed fee cap.** For 2.1.0 the verifier computes
  `ceil(limit * price / 1e6)` lamports from the message and refuses with `fee_exceeded` when
  `networkFeeLamports` plus that fee exceeds `max_network_fee_lamports`.
- **2.0.0 is unchanged.** A 2.0.0 token still refuses a Compute Budget or Memo instruction
  beside the vault spend (`instruction_mismatch`).
- New exports: `DEMAND_DESK_AUTHORIZATION_VERSION_2_1`, `COMPUTE_BUDGET_PROGRAM_ID`,
  `MEMO_PROGRAM_ID`, `MAX_SETTLEMENT_MEMO_BYTES`, and the type
  `DemandDeskSettlementConstraintsV2_1`. `UnsignedDemandDeskAuthorization` is now a union of
  the two versions. New schema: `schemas/demand-desk-authorization.v2.1.schema.json`.

## 0.14.0 - 2026-10-26 (Demand Desk authorization v2)

A minor release under the policy above. It adds two entry points, and both refuse.
No existing entry point changes what it allows or refuses, and `^0.13.0` installs never
receive it.

- **New: `verifyDemandDeskAuthorization(authorization, expectation)`.** An offline check
  of a Demand Desk `2.0.0-demand-desk` authorization before you sign the vault spend it
  allows. The Ed25519 signature covers every field except `signature` and must come from
  a key in `trustedDemandDeskPubkeys`; a key carried only by the token is never trusted.
  It returns `{ ok: true, authorization }` or `{ ok: false, code, message }` and does
  not throw. It refuses when:
  the shape or version is wrong (`invalid_shape`, `unsupported_version`); the key is not
  trusted or the signature fails (`untrusted_desk`, `signature_invalid`); the
  authorization was issued in the future (`not_yet_valid`; no clock skew is allowed
  unless you set `maxClockSkewMs`), has expired (`expired`), or lives longer than
  `maxTtlMs`, default 120000 ms (`ttl_exceeded`); the Desk decision is not `ALLOW` /
  `APPROVED` (`decision_refused`); the intent differs field for field from yours
  (`intent_mismatch`); the vault, vault program or policy PDA differ
  (`settlement_mismatch`); or the network fee is above the signed cap (`fee_exceeded`).
- **The instruction rule is strict** (`instruction_mismatch`). The transaction holds
  exactly one instruction: the vault program's seven-account `spend_with_policy`, with
  the authorized amount, accounts, signer and writable flags, and the signed
  `instruction_hash`. When you pass `receiptHashHex`, the instruction must carry that
  receipt commitment. A ComputeBudget or Memo instruction beside the vault spend
  refuses.
- **New: `createDemandDeskWallet(adapter)`.** A signer facade for SVM and ElizaOS wallet
  providers. `signTransaction`, `signAllTransactions` and `signAndSendTransaction` each
  check, before the wrapped signer runs, that the local mandate is active
  (`mandate_inactive`), that the transaction message hashes to the context's
  `messageHash` (`transaction_message_mismatch`), and that the authorization verifies
  (`demand_desk_<code>`). Each refusal throws. A batch is checked in full before any
  item is signed. The facade keeps no replay state; one-use enforcement belongs to the
  Desk. It is not the only way to spend: a Desk-signed transaction can still be
  submitted directly to RPC, and the vault does not require this facade.
- **Also exported:** `demandDeskMessageHash`, `demandDeskAuthorizationPreimage`,
  `immutableVaultInstructionHash`, the constants `DEMAND_DESK_AUTHORIZATION_VERSION`,
  `DEMAND_DESK_AUTHORIZATION_DOMAIN`, `IMMUTABLE_VAULT_INSTRUCTION_DOMAIN` and
  `DEMAND_DESK_REASON_CODES`, and their types.
- The JSON schema (`schemas/demand-desk-authorization.v2.schema.json`) and the contract
  (`docs/demand-desk-authorization-v2.md`) are in this package's directory in the
  repository; the npm tarball carries the code only.
- `twzrd.payment_decision.v1` is unchanged and still does not move USDC.

## 0.13.1 - 2026-10-25 (the readiness card's basis type)

A patch under the policy above: types and doc comments only. No allow or refuse
outcome changes.

- **New type: `TwzrdReadinessBasisEntry`, exported from the package root.**
  `TwzrdReadinessCard.basis` is now declared, as an optional, nullable array of it, so
  consumers no longer cast to read `basis[].observed_at`.
- **Which `observed_at` can be card-build time is written down.** The readiness card's
  `as_of`, and each `basis[].observed_at`, can equal card-build time: a scored read with
  no per-seller anchor reports the instant it ran. The readiness card's `observed_at`
  and the merchant card's `observed_at` are the seller clock (the last live settle, else
  the corpus complete day) and never build time. On the merchant card, `as_of` mirrors
  `observed_at`.

## 0.13.0 - 2026-10-25 (missing evidence refuses by default)

A minor release under the policy above: every change below adds a default
refusal, and each has a named opt-out that restores the 0.12.5 outcome.
`^0.12.0` installs never receive it.

- **`decisionFromApproval` records a seller intel never evaluated as a verdict.**
  A refusal projects to `block` / `UNKNOWN_ABOVE_LIMIT` and a within-cap approval to
  `warn` / `UNKNOWN_UNDER_LIMIT`, the policy runtime's unknown-counterparty codes.
  Up to 0.12.5 the refusal projected to `unavailable` / `NETWORK_NOT_SCORED` on Solana
  and Base mainnet, which are scored, because the gate reports an unevaluated seller with
  `verdict: "unknown"`. The within-cap approval projected to `INTEL_WARN`. What the gate
  allows or refuses does not change; only the `payment_decision.v1` record does.
- **`createBuyerFetch` records `policy_version: "buyer-fetch.v2"`** in its local
  decision ledger (was `buyer-fetch.v1`), because the refusals below change
  what it allows. Its knobs stay pinned and independent of the env.
- **New, opt-in: `decideHeldVaultSpend`, and `createGuardedX402Fetch({ heldVaultSpend })`.**
  Given a Demand Desk vault-spend transaction the process already holds, the gate
  refuses that copy before any fetch or RPC socket when the pinned desk signature is
  missing or forged, when its authorization has expired, when the `spend_with_policy`
  instruction bytes differ from the bound instruction, when the only credential is an advisory
  `payment_decision.v1`, or when the bytes are not one USDC `spend_with_policy`
  instruction on the vault program. The README lists each reason. Without
  `heldVaultSpend`, nothing changes. The gate is not the exclusive signer: a refusal
  does not stop a direct submission of a transaction the desk already signed.
- **The Base seat (`twzrd-x402-gate/cloudflare-base`) keeps its 0.12.5 rules.**
  It is a standalone module that reads one preflight card and no merchant card,
  so none of the changes below apply to it: it still pays an evaluated `warn`
  with no cap, and it reads `wash_flagged` only from the preflight card.

- **An evaluated `warn` is paid only under its own cap** (`refuseUncappedWarn`,
  default `true`). A card that says `warn` with no finite `recommended_cap_usdc`
  refuses with `twzrd_warn_no_cap`; a payment whose price is unknown refuses with
  `twzrd_warn_unknown_price`. A price above a known cap still refuses with
  `twzrd_over_recommended_cap_*`. This is intel's own `can_spend` rule for `warn`,
  and the bound the unevaluated-seller branch already applied; 0.12.x paid such a
  `warn` with no ceiling. Intel sends a cap on every `warn` card, so a live card
  with a known price is unaffected. The pure `evaluateReadinessCard` applies it
  when the option is omitted. Opt out with `refuseUncappedWarn: false` or
  `TWZRD_REFUSE_UNCAPPED_WARN=0|false|no|off`; any other value, including a typo,
  leaves it on. `createBuyerFetch` sets it explicitly.
- **`refuseWashUnknown` defaults to `true`.** On the reputation-scored path a
  reachable merchant card that has not fully answered the wash question (no
  card, including a 4xx; wash confidence other than `full`; `ring_evaluated:
  false`; `wash_stale: true`) refuses with `twzrd_wash_unknown`. This is the
  rule `createTwzrdWashBeforePaymentHook` has always applied; the full engine
  now agrees with it. The 0.12.0 condition for the flip was full coverage for
  the sellers with a 90-day settlement graph and no wash finding on the first
  page of `/v1/intel/resources`: 0 of 19 on 2026-10-10. Re-measured against
  live intel on 2026-10-25, every card read live: 17 of 17 on the first page
  (200 resources, now 18 distinct sellers where 2026-10-10 had 122), and 27 of
  27 across the first five pages (1000 resources, 76 sellers, no card errors).
  Those cards report `full` and not stale, and omit `ring_evaluated` (only
  `false` fails coverage) while carrying numeric ring counts. Of the 46 sellers
  on those pages with no 90-day graph, 31 had full coverage, 12 carried a wash
  finding (already refused), and 3 had no wash answer and now refuse. **A wallet intel has never seen now
  refuses:** its card answers 200 with `wash_flagged: null` and no confidence.
  An unreachable card is still an outage decided by `failOpen`, and unscored
  networks on `observe` are still not refused for coverage. Opt out with
  `refuseWashUnknown: false` or `TWZRD_REFUSE_WASH_UNKNOWN=0|false|no|off`; any
  other value, including a typo, leaves it on, and an empty value no longer
  means off (0.12.x read `TWZRD_REFUSE_WASH_UNKNOWN=` as off). `createBuyerFetch`
  pins it on.
- **A card with no `wash_flagged` boolean is not coverage.** A merchant card
  that reports confidence `full` but whose `wash_flagged` is missing or `null`
  has not answered the wash question, and now reads as inadequate coverage
  (`twzrd_wash_unknown`). 0.12.x counted it as full coverage. Both engines
  agree: the full engine refuses it while `refuseWashUnknown` is on, and
  `createTwzrdWashBeforePaymentHook`, which always applies the coverage rule,
  refuses it with no flag, as it refuses any unknown coverage. That module's
  header already said unknown is not clean; the coverage check never read
  `wash_flagged`. In the 2026-10-25 five-page sample no card had this shape,
  so it added no refusal there.
- **A seller intel has never evaluated is refused** (`refuseUnevaluated`,
  default `true`). A readiness card with `null_reason` set or `score: null`
  refuses with `twzrd_unevaluated_subject_<null_reason>`, even within its
  `recommended_cap_usdc`. This reverts the 0.11.0 default, which allowed such a
  seller up to that cap (live: $0.10, intel's lowest `warn` tier) because
  refusing every one stopped agents from paying anyone new. The 2026-10-25
  sample confirms that reason rather than refuting it: 46 of 76 sellers had no
  90-day settlement graph, and 31 of those 46 had full, clean wash coverage, so
  they pass every other 0.13.0 check. Up to 31 of 76 sampled sellers would
  newly refuse. That is an upper bound: the sample read merchant cards, not
  readiness cards, so which of those sellers is unevaluated was not measured.
  Opt out with `refuseUnevaluated: false` or
  `TWZRD_REFUSE_UNEVALUATED=0|false|no|off`; any other value, including a typo,
  leaves it on, and an empty value no longer means off (0.12.x read
  `TWZRD_REFUSE_UNEVALUATED=` as off). The pure `evaluateReadinessCard` applies
  it when the option is omitted. `createBuyerFetch` now pins it on (it pinned
  `false` in 0.12.x). The Base seat (`twzrd-x402-gate/cloudflare-base`) is
  unchanged: it still refuses an unevaluated seller only when its
  `refuseUnevaluated` option is true.

## 0.12.5 (strict mode refuses a Solana devnet or testnet genesis id)

A patch under the security-defect rule above. Not 0.13.0. Default `observe`
outcomes do not change. The `refuseWashUnknown` default flip stays reserved
for 0.13.0.

- **Strict mode refuses a Solana devnet or testnet named only by its CAIP-2
  genesis id** (`etwtrabzayq6imfeykouru166vu2xqa1`,
  `4uhcvjyu9pjkvqys88urdiswhxscky3z`, bare or `solana:`-prefixed, any case)
  with `network_not_scored` before preflight. `classifyNetwork` still reports
  those ids as reputation-scored, so harnesses on the default `observe` path
  still reach preflight, and devnet USDC mint matching is unchanged. A name
  that contains `devnet`, `testnet`, or `localnet` was already unscored. The
  mainnet genesis id stays scored under strict. `createBuyerFetch` hard-codes
  strict, so it picks this refusal up. Other entry points pick it up only when
  they set `unsupportedNetworkMode: "strict"`.

## 0.12.4 - 2026-10-20 (createBuyerFetch expectedAmount)

A patch release under the policy above: the two refusals (`expected_amount_mismatch`,
`expected_amount_unavailable`) apply only when `expectedAmount` is set. No other entry
point and no existing default changes. The 0.13.0 minor stays reserved for the
`refuseWashUnknown` default flip.

- **`createBuyerFetch` takes an optional `expectedAmount`.** `maxPricePerCall` is
  a ceiling, so a $1,000 challenge passed a $1,000 cap. With `expectedAmount`
  (an exact USDC decimal, or a function returning one per payment), any other
  atomic amount on the selected requirement refuses with
  `expected_amount_mismatch` before preflight or signing; a function that
  returns no decimal string or throws refuses with `expected_amount_unavailable`
  and keeps the cause. The function receives the request's `signal`, and an
  abort while it is pending refuses with `request_aborted`. The cap is unchanged
  and keeps `price_cap_exceeded`. A fixed value above `maxPricePerCall` throws
  at install. Opt-in: without the option, no outcome changes. 0.12.3 does not
  have the option (TypeScript rejects it; JavaScript ignores it).
- README `## Refusals` now has a `createBuyerFetch` table, and the
  refusal-codes doc test reads `src/buyer-fetch.ts`, so its reasons cannot go
  undocumented again.
- **The `refuseWashUnknown` default does not flip here.** The 0.12.0 entry
  scheduled that flip for 0.13.0, and this release leaves it there. The flip
  ships in 0.13.0 under the same condition: intel reports full coverage for
  scored sellers without a wash finding, measured on the same sample. Until
  then, strict consumers opt in as before.

## 0.12.3 - 2026-10-20 (buyer front door: createBuyerFetch)

- **Buyer front door: `createBuyerFetch` and `twzrd-buyer-demo`.** Required exact
  per-call cap and recipient allowlist, mandatory fail-closed free preflight,
  and local decision/spend files on the actual x402 paying call. The optional
  hourly cap shares in-process reservations and replays spend on restart.
  Logging failures refuse signing. Legacy disable/fail-open switches cannot
  bypass this entry point; existing APIs retain their defaults. No paid score,
  trust receipt, delivery capture or decision upload is enabled. The demo uses
  an offline 402 fixture with the official client and no wallet.
- Decision-ledger background flush failures remain observable through an
  awaited `flush()` without an unhandled rejection; callers that explicitly
  flush can opt out of the process `beforeExit` listener.
- `createBuyerFetch` accepts the same opt-in `onFulfillment` as
  `createGuardedX402Fetch`: one local row per paid call, recorded on the raw
  transport under the front door. No network call; no allow/refuse change.
- Two fail-closed warnings in `twzrdApprovePayment` no longer suggest setting
  `TWZRD_FAIL_OPEN=true`; the outcome is unchanged.

## 0.12.2 - 2026-10-20 (opt-in local fulfillment record)

- **New opt-in `onFulfillment` option on `createGuardedX402Fetch`.** After a paid call it builds one local record: `paid_to`, `network` and `amount_atomic` from the signed requirement, `tx` and `settled` from `PAYMENT-RESPONSE`, and the seller-reported `served_by` (`provider` or `model`), `failover_hops`, `ready`, `job_status` and `job_id`, with a `verdict` of `match`, `pending`, `mismatch` (with `reasons`) or `not_reported`. `ready: false` with a non-terminal status is `pending`, not a failure. It makes no network call and changes no allow/refuse outcome; without the option nothing is recorded.
- **New exports:** `buildFulfillmentRecord`, `wrapFetchRecordFulfillment`, `createFileFulfillmentLog` (append-only JSONL), `modelMatches`, `FULFILLMENT_RECORD_SCHEMA` (`twzrd.fulfillment.v1`), `FULFILLMENT_MAX_BODY_BYTES` and their types. Only named fields are copied from a response body, the resource is kept as its origin, event streams and JSON bodies over 1 MiB record header fields only, and a failing sink never reaches the pay path.

## 0.12.1 - 2026-10-19 (docs and package metadata only)

- **No runtime change.** No allow/refuse outcome, export, option or default differs from 0.12.0; `src/` changes only the install strings printed by `twzrd-gate-doctor`. This patch exists so the npm page carries the corrected description and README.
- **package.json `description`** is now one line: a free preflight before signing USDC on Solana mainnet and Base mainnet (`eip155:8453`), no signing by default if the preflight is down (`TWZRD_FAIL_OPEN` overrides), other EVM networks unscored. It previously carried release notes and an over-broad fail-closed claim.
- **README "Pay-path behavior"** holds the notes moved out of the description and corrects them: an unevaluated seller (`null_reason: unknown_subject`) can be paid up to its card's `recommended_cap_usdc` (unless `refuseUnevaluated`), and the pay path is not uniformly fail-closed (`createTwzrdSettleGuard` is fail-open by default, `TWZRD_FAIL_OPEN=true` lets a preflight outage sign, unscored EVM networks default to `observe`). Install pins move to 0.12.1; the README also lists the package's `bin` commands.

## 0.12.0 - 2026-10-10 (opt-in: refuse unknown wash coverage)

- **New `refuseWashUnknown` option, default `false` in 0.12.x.** Opted in, on the reputation-scored path a merchant card that answered but has not fully answered the wash question refuses with `twzrd_wash_unknown`: no card (including a 4xx), wash confidence other than `full` (`partial_inbound_only`, `base_2cycle`, `unknown`, ...), `ring_evaluated: false`, or `wash_stale: true`. This is the rule `createTwzrdWashBeforePaymentHook` already applies; the full-preflight entry points (`createTwzrdBeforePaymentHook`, `wrapFetchWithTwzrdGate`, `evaluate_x402_resource`, `safeFetch`, `withTwzrdGuard`, auto-gate seats) can now apply it too. Measured wash keeps `twzrd_wash_flagged` and is checked first. Opt in with `refuseWashUnknown: true` or `TWZRD_REFUSE_WASH_UNKNOWN=1|true|yes|on`; an explicit option wins over the env. It only applies while `refuseWashFlagged` is on.
- **Why it is off by default: partial coverage is the normal state for clean scored sellers today.** Sample, 2026-10-10: the first page of `/v1/intel/resources` (200 of 28,925 active resources, 122 distinct sellers), each seller's merchant card read live. Of the 27 sellers with a 90-day settlement graph, none has full coverage without a wash finding: 19 report `partial_inbound_only` with no wash flag, 7 report `partial_inbound_only` and are wash-flagged, and the only one with full coverage is itself wash-flagged. The catalog's only tier-B provider (83 payers in 90 days) is among the 19. Of the 95 sellers with no settlement graph, 81 cards report `full` (77 with `wash_flagged: false`). Turned on today, the check would refuse every scored seller that has no wash finding while passing most sellers nobody has paid.
- **Flip schedule.** `refuseWashUnknown` becomes `true` by default in **0.13.0**, a minor release with its own entry here, so `^0.12.0` never receives the new default. 0.13.0 ships only when intel reports full coverage (`full`, ring evaluated, not stale) for scored sellers without a wash finding, measured on the same sample. Until then, strict consumers opt in.
- **Not an outage.** Opted in, a card that answered is never reported as `twzrd_card_unreachable_fail_closed`, and `failOpen` does not open `twzrd_wash_unknown`. An unreachable card (5xx, 429, non-JSON, throw, timeout) is still decided by `failOpen`. The unsupported-network observe path is never refused for coverage.
- **Wash seat timeout 3000 -> 2000 ms** (`createTwzrdWashBeforePaymentHook` default and the `TWZRD_WASH_TIMEOUT_MS` fallback), matching the gate's `intelTimeoutMs`. A lookup slower than 2 s is an outage, decided by `failOpen` (fail-closed by default); this is the allow/refuse change that makes 0.12.0 a minor release.
- **`decideSolanaConsumerAction` (consumer-adjacency router, not exported) fails closed**: wash, unknown wash (`washFlagged` null or absent) and a missing or unknown preflight decision refuse; only a clean `warn` pays capped. It previously paid on a missing decision and capped on wash.

## 0.11.5 - 2026-10-02 (peer floor)

- **`x402-solana` peer floor raised to `>=3.0.1`** (was `>=3.0.0`). x402-solana 3.0.1 refuses a non-positive amount, or one above the u64 range, before it builds or signs a transfer; 3.0.0 accepted a negative amount. An install that resolves the stock PayAI client now gets that check. The gate's own `amount_malformed` refusal (0.11.2) already rejected a signed or non-integer amount on every gate entry point; this closes the same hole for a payer that calls `x402-solana` directly. No gate allow/refuse outcome changes.

## 0.11.4 - 2026-10-01 (security fix)

- **`createTwzrdPolicyFetch` and the x402 intent adapter refuse a non-USDC asset** (`twzrd_non_usdc_asset`) instead of reading its base units as USD: 5 wSOL (`500000000`) passed a $1000 cap as "$500". The hook and approval seats already refused it; the policy seat now agrees. A bare `"USDC"` symbol is not a mint and is refused like any other non-mint asset on a network with a known USDC set. The MPP seat has its own priced-asset table and is unchanged (it also prices USDT 1:1; the x402 seats do not).
- **Base Worker**: an entry whose network is spelled `BASE`, `base` or `eip155:8453 ` is scored like `eip155:8453` (it was skipped, so a clean sibling could approve a wash one). An amount too large for a finite number is refused (`twzrd_invalid_price`). The Worker pays EVM entries only; Solana siblings are not scored by it.

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
