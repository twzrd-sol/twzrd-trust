# Compatibility note — twzrd-x402-gate 0.9.3 → 0.9.4

0.9.11 is the released identity of this package. npm dist-tags `latest` and `paying-client-fail-closed` are both 0.9.11.

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

- `latest` dist-tag: **0.9.7**. `0.10.0` and `0.10.1` are deprecated as
  unreproducible. Their deprecation text previously read "pin 0.9.3", which
  pointed integrators away from the maintained line; registry `latest` and the
  public trust source were re-verified on 2026-09-12. Treat 0.9.7 as the
  maintained line.
- Until the default-engine question is settled in a future minor, pin the
  exact version (`twzrd-x402-gate@0.9.7`), not a caret range, if the pre-sign
  semantics of your payment path matter to you.
