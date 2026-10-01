# Compatibility note — twzrd-x402-gate 0.9.3 → 0.9.4

0.11.4 is the released identity of this package and npm `latest`. 0.11.2 and 0.11.3 are deprecated on npm; the `paying-client-fail-closed` dist-tag still points at 0.11.2.

0.11.3 and 0.11.4 are security fixes; each change adds a refusal or makes one reliable. The paying and policy fetch wrappers check every offer and refuse an entry with no recipient; every boolean flag is read by one parser, so `failOpen: "false"` stays closed; the policy seat refuses a non-USDC asset instead of reading its base units as USD; and the Base Worker scores case and whitespace variants of the Base network name (`BASE`, `base`, a trailing space). See `CHANGELOG.md`.

0.11.2 is a security fix from a line-by-line audit of 0.11.1: an amount that is not an ASCII base-unit integer is refused on every entry point (`amount_malformed`); fetch wrappers and the MCP hook check every offer in `accepts[]`, not one; `./cloudflare-base` applies the package's signing rules instead of signing on any non-block verdict; genuine USDC is no longer refused when the network is omitted or spelled `mainnet-beta`; free intel calls have a deadline (`intelTimeoutMs`). See `CHANGELOG.md`.

0.11.1 is a security fix: on Solana and Base, a payment requirement that names an asset other than USDC is refused before intel (`twzrd_non_usdc_asset`; `non_usdc_asset` from `twzrd.safeFetch`). The gate prices every cap in USDC and used to read any asset's `amount` as micro-USDC, so a seller naming an 8-decimal mint could pass a $0.10 cap while moving a far larger value. A requirement naming USDC, or no asset, is unchanged. See `CHANGELOG.md`.

0.11.0 changes one default: a seller intel has never evaluated (`null_reason: unknown_subject`, `score: null`) is allowed up to the card's own `recommended_cap_usdc` instead of refused outright. Above the cap, with no cap on the card, or with an unknown price it is still refused, and the free wash check still runs. `refuseUnevaluated: true` (or `TWZRD_REFUSE_UNEVALUATED=1`) keeps the 0.9.9–0.9.16 behaviour. The $0.001 `/quick` escalation no longer runs for an unevaluated seller. See `CHANGELOG.md`, including why this is 0.11.0 and not 0.10.0.

0.9.16 unblocks `createGuardedX402Fetch` callers who could not pay for fixable reasons. With a spend rule set, Circle devnet USDC (`4zMMC9...`, the `@x402/svm` devnet default) is now accepted on devnet; before, it was refused as `unsupported_or_non_usdc_asset`. Each Solana USDC mint now counts only on its own cluster. When `@x402/core` refuses with its default spend controls (over $1, or an unrecognized asset) before TWZRD runs, the error now says how to widen core's controls, and the original is kept as `cause` (`explainCoreSpendControls`). A missing `@x402/fetch` peer now names the packages to install.

0.9.13 fixes a `twzrd.safeFetch` spend-cap leak present in 0.9.9 through 0.9.12. When your `pay` callback throws after the signer ran (for example a broadcast timeout with an unknown outcome), the spend is now recorded and the error is rethrown. 0.9.9 through 0.9.12 released the reservation instead, so the next call could pay again past `maxSpend`. A refusal that never reached the signer still records nothing. A `pay` callback that knows it never signed should return rather than throw. The ledger may now count a payment that did not land; reconcile it from chain if that matters to you.

0.9.11 refuses an `accepts[]` entry whose v1 and v2 price fields disagree (`maxAmountRequired` vs `amount`), or whose recipient fields disagree (`payTo` vs `pay_to`), on every path: `amount_field_conflict` / `payto_field_conflict`. Previously the package read these with two opposite precedences (v1-first in `payTo`-based paths, v2-first elsewhere), so a decoy in either field could put a payment under a spend cap that the client then paid from the other field. Both fields present and equal (dual-emit) is unchanged. New export: `resolveRequirementFields`. `payToFromRequirements` now also returns `conflict`.

Published in 0.9.10 (then the `paying-client-fail-closed` dist-tag; `latest` was still 0.9.9): the **wash engine** no longer
hardcodes allow on intel outage. Timeout / 5xx / 429 / throw / bad JSON
abort with `twzrd_card_unreachable_fail_closed` unless `failOpen: true` or
`TWZRD_FAIL_OPEN=1`. `fetchMerchantCard` throws `MerchantCardUnreachableError`
on outage instead of returning null. Reachable cards with no wash signal
still do not invent `wash_flagged`. The 0.9.4 table below is historical.

0.9.4 (published 2026-09-07) changed the default behavior of
`createTwzrdBeforePaymentHook()` when called with no options. A consumer
resolving `^0.9.3` gets 0.9.4 and silently gets the new default. This note
states the change and the exact per-engine failure semantics, verified against
the published tarballs (not source or memory).

## What changed

| | 0.9.3 | 0.9.4 |
|---|---|---|
| `createTwzrdBeforePaymentHook()` with no options | full preflight engine (`evaluateBeforePaymentCreation`) | wash-only engine — `engine` option added, default `"wash"` — plus a capacity-leash check ahead of it |
| 0.9.3 default behavior in 0.9.4 | n/a | `createTwzrdBeforePaymentHook({ engine: "full" })` or `createTwzrdFullBeforePaymentHook(opts)` |
| `installTwzrdX402ClientHook` / `createTwzrdPayKitBeforePaymentHook` | full engine | full engine (unchanged) |

The wash engine (`dist/wash-default.js`, self-described "product default paying
path") is intentionally minimal: one `GET /v1/intel/merchant_card/{payTo}`
before sign, no Path A, no requireReceipt, no preflight. The full engine is
the 0.8.x shared evaluator (preflight, payment control, decision tokens) and
does not call `merchant_card` at all — so the wash rows below apply only to
the default engine.

## Per-engine failure semantics (verified in dist)

| Condition | wash (0.9.4 default) | full (0.9.3 default; 0.9.4 opt-in) |
|---|---|---|
| Intel outage — timeout, non-2xx, invalid JSON, throw | **allow** (hardcoded fail-open) | **block** by default; honors `failOpen: true` or `TWZRD_FAIL_OPEN=1` |
| Intel up, payTo unscored / no corpus (live: HTTP 200 card with `wash_flagged: null`, `wash_confidence: null`, reason `no_corpus_inbound`) | **refuse** (`twzrd_wash_unknown`) unless price ≤ `washMaxUsdc` | n/a — full engine does not use `merchant_card` |
| Card present, `wash_flagged: true` | **refuse**, or allow when price ≤ `washMaxUsdc` (`twzrd_wash_capped`) | n/a |
| Card present, `wash_flagged: false`, coverage full (confidence `full`, ring evaluated, not stale) | **allow** (`twzrd_wash_ok`) | n/a |
| Card present, coverage partial / stale | **refuse** unless price ≤ `washMaxUsdc` (`twzrd_wash_unknown*`) | n/a |

Two points integrators have hit explicitly:

1. **`failOpen` is not an option of the wash engine.** The 0.9.4 wrapper does
   not forward it (`x402-client-hook.js` passes only `intelBase`, `fetch`,
   `attribution`, `refuseWashFlagged`, `washMaxUsdc`, `onDecision`), and the
   wash evaluator fails open unconditionally on outage. This is the current
   contract, not a configuration bug. If you need fail-closed on intel
   outage, use `{ engine: "full" }` or the install/PayKit helpers.
2. **Measured-clean is the only allow besides outage.** Verified live
   (2026-09-08): an unscored Solana wallet returns HTTP 200 with
   `wash_flagged: null, wash_confidence: null` (`no_corpus_inbound`) — a
   card, not a 404 — and that card refuses under the default engine
   (`twzrd_wash_unknown`). A recipient nobody has scored yet stops the
   payment. The only other allow is a card with `wash_flagged: false` and
   full coverage. If unknown-but-small payments should pass, set
   `washMaxUsdc` (option or `TWZRD_WASH_MAX_USDC`).

Every wash GET is attributed by default: `X-TWZRD-Client` and `X-Twzrd-Caller:
twzrd-x402-gate/<version>`. `attribution: { integration, runId }` adds
`X-TWZRD-Integration` / `X-TWZRD-Run-Id`.

## Registry state

- `latest` dist-tag: **0.11.4**. `paying-client-fail-closed`: **0.11.2** (deprecated; the tag has not moved). `0.10.0` and `0.10.1` are deprecated as
  unreproducible. Their deprecation text previously read "pin 0.9.3", which
  pointed integrators away from the maintained line; registry `latest` and the
  public trust source were re-verified on 2026-09-12 (maintained line then: 0.9.7). Treat 0.11.4 as the
  maintained line (0.11.2 and 0.11.3 are deprecated on npm for security fixes).
- From 0.11.0, a change to what the gate allows or refuses ships only in a minor
  release with a `CHANGELOG.md` entry. `^0.11.0` therefore takes fixes but never a
  new refusal policy. Pin the exact version (`twzrd-x402-gate@0.11.4`) if you want
  no change at all.
