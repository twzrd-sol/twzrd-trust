# Resource-bind v2 (`rb2:`) — payer commits to `decision_id`

**Status:** client + offline verifier. Not a closed decision loop.
**Does not ship:** facilitator / settle changes, prod deploy, npm publish, Path B/G.

## Why

Bind-v1 (`rb1:`) commits a Solana payer signature to the exact x402 *offer*
(payTo, amount, asset, network, resource, scheme). The gate already issues a
`DecisionToken.decisionId` and intel already echoes `preflight_id` unsigned in
the 402 (`extensions.twzrd_decision_bind`). Those ids were not in the leaf, so
the payer signature did not commit to them.

v2 folds `decision_id` (required) and `preflight_id` (optional) into the **leaf
that is hashed**. The on-chain memo stays 47 bytes. A second memo, or writing
the id into seller `extra`, is out of scope.

## 48-byte memo (ExactSvm CU)

Memo program cost is ≈ 1320 + 358·bytes. ExactSvm hardcodes a 20_000 CU
budget. 48 bytes ≈ 18.5k CU. `rb1:` + base64url(32) is 47 bytes. v2 uses the
same shape: `rb2:` + base64url(32) = 47 bytes. Do not append `decision_id` to
the memo.

## `rb1:` is frozen

Existing mainnet transactions and the intel `POST /v1/intel/resource_bind/verify`
v1 path stay valid. v1 leaf, domain, and prefix do not change. A relying party
that only understands `rb1:` must treat `rb2:` as unbound, not as a v1 leaf.

## v2 leaf

Domain (UTF-8, then a newline, then canonical JSON):

```
twzrd:x402-resource-binding:v2
```

`canonicalJson` is the frozen PaymentIntent form (`twzrd-x402-gate/src/intent.ts`):
object keys sorted by code unit, `undefined`/`null` members omitted, arrays in
order, no insignificant whitespace, numbers finite.

Given the selected `accepts[]` entry **R** (values as served) and a gate
decision bind:

```
amount      = R.amount ?? R.maxAmountRequired
asset       = R.asset ?? ""
network     = R.network          (RAW wire string)
payTo       = R.payTo ?? R.pay_to
resource    = R.resource
scheme      = R.scheme ?? ""
decision_id = DecisionToken.decisionId   (required; 1..=128 UTF-8 bytes)
preflight_id = server-issued integer     (optional; omit when absent)

requirements_hash = hex(sha256(canonicalJson({
  "amount": amount, "asset": asset, "network": network,
  "payTo": payTo, "resource": resource, "scheme": scheme })))

leaf = {
  "amount_raw":        amount,
  "asset":             asset,
  "body_hash":         64 × "0",
  "decision_id":       decision_id,
  "network":           network,
  "pay_to":            payTo,
  "preflight_id":      preflight_id,   // omitted when not a non-negative integer
  "requirements_hash": requirements_hash,
  "resource_url":      canonicalResourceUrl(resource),
  "schema_version":    2
}

leaf_hash = hex(sha256("twzrd:x402-resource-binding:v2" + "\n" + canonicalJson(leaf)))
memo      = "rb2:" + base64url(leaf_hash_bytes)     // 47 UTF-8 bytes
```

`requirements_hash` is the v1 named projection. v2 is not a second offer bind.
`body_hash` stays zero (offer + decision bound; delivery not).

`canonicalResourceUrl` matches v1: WHATWG parse, drop fragment, stable-sort
query pairs by key, serialize.

## When to emit `rb2:` vs `rb1:`

| Condition | Leaf | Memo |
|---|---|---|
| `decision_id` present at stamp/compose | v2 | `rb2:` |
| `decision_id` absent | v1 (unchanged) | `rb1:` |

`requireDecisionBind: true` on `spendControlSafeFetch` is opt-in and default
off. When set, missing `decision_id` fails closed (`signerInvocations: 0`,
`pay()` is not called). Existing `requireOfferBinding` callers stay on v1
unless they pass a `decision_id`.

## Fail-closed

| Case | Result |
|---|---|
| v2 leaf with empty or >128-byte `decision_id` | refuse / throw; no memo |
| `requireDecisionBind` and no `decision_id` | `verdict=block`, reason `decision_bind_required`, signer=0 |
| nonzero `body_hash` | refuse (v1 and v2) |
| memo prefix does not match the leaf schema | not hard (soft / unbound) |
| offer fields missing (`payTo` / amount / resource) | refuse (same as v1) |

BLOCK / refuse paths do not create a payment and therefore have no memo.
`blocked_never_signed` and Autogate block-proof remain the refuse artifacts.

## One binding

`twzrd.payment_decision.v1` `challenge_hash` **is** the bind leaf that was
stamped: v1 when no `decision_id`, v2 when `decision_id` is set. Do not add a
parallel `db1:` memo.

## Memo extract order

When a transaction has several Memo instructions, pick the first `rb2:`
payload, else the first `rb1:`, else the first memo. Matches the TS extractor
and the intel Python twin.

## Honesty (what this is not)

A payer-signed Solana transaction **can** commit to `decision_id` via an
`rb2:` memo whose preimage is independently recomputable.

This slice does **not** claim:

- a closed cryptographic decision loop
- payer commitment on the default unsigned-challenge path
- block-side chain evidence
- intel `/settle` requiring the memo
- `citedOutcomes` exercised on a real journey
- `path_b_artifacts_external ≥ 1` / Path G
- outcome-backed scoring from a prior decision

## House proof

`twzrd-x402-gate/test/fixtures/resource-bind-v2-golden.json` is the pinned
vector: one v2 leaf JSON → 47-byte `rb2:` memo. The gate test recomputes it;
the intel twin recomputes the same fields. Compose-and-decode (no broadcast):
`npx tsx scripts/rb2-house-proof.ts` (and `spend-control.test.ts` when
`@x402/svm` is present).

Pinned golden:

- `decision_id`: `decision-test-1`
- `preflight_id`: `42`
- `leaf_hash`: `2f3d72f7d25ccc0b6513722f59083d1f06b01785ae66956f3db80229283f5899`
- `memo`: `rb2:Lz1y99JczAtlE3IvWQg9HwawF4WuZpVvPbgCKSg_WJk` (47 bytes)
