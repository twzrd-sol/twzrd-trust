# twzrd.payment_decision.v1 — Portable Payment Decision Record

**Status:** FROZEN (v1). Field additions, enum additions, or any change to the
normalization or preimage below require a new schema id (`…v2`), never an edit
to v1.

**Machine schema:** [`schemas/twzrd.payment_decision.v1.schema.json`](schemas/twzrd.payment_decision.v1.schema.json)
**Reference implementation:** `twzrd-x402-gate/src/payment-decision.ts`
(`import … from "twzrd-x402-gate/payment-decision"`, CLI `twzrd-payment-decision --verify`).

## 1. What this is

Agent wallets and gateways already do budgets, approvals, routing and spend
limits. What none of them emit is a portable record of

- **what the agent saw** — a hash of the exact 402 challenge it was asked to pay,
- **what it decided** — `allow | block | warn | unavailable`,
- **why** — one code from a closed enum, and
- **an evidence id** a third party can take back to the issuer,

that a relying party can **accept or reject offline**, with nothing but the
issuer's Ed25519 public key. TWZRD is not in the request path of verification.

This record is a *decision receipt*. It is **not** a reputation score, not an
AO-Receipt V6 (`docs/receipt-v6-spec.md` is a different product), not a payment
authorization, and not a second payment policy. It says what one evaluator
decided about one challenge, and nothing else.

## 2. The record

```json
{
  "schema": "twzrd.payment_decision.v1",
  "challenge_hash": "3f2c…64 lowercase hex…",
  "merchant": {
    "origin": "https://api.merchant.example",
    "pay_to": "MerchantWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "scheme": "exact",
  "decision": "block",
  "reason_code": "WASH_FLAGGED",
  "evidence_id": "5a3b0b4e-7d1e-4a1f-9d1c-2f5a8e9c0b11",
  "expires_at": "2026-09-09T00:42:00.000Z",
  "signature": {
    "alg": "ed25519",
    "key_id": "local-ed25519",
    "sig": "base64 of 64 bytes (88 chars, ends ==)"
  }
}
```

| Field | Type / shape | Meaning |
|---|---|---|
| `schema` | const `"twzrd.payment_decision.v1"` | Schema id. |
| `challenge_hash` | `^[0-9a-f]{64}$` | sha256 of the normalized 402 challenge (§4). Hash only; the challenge itself is never carried. |
| `merchant.origin` | bare WHATWG origin | `scheme://host[:port]` of the 402 resource. No path, query, fragment or userinfo. |
| `merchant.pay_to` | `^[A-Za-z0-9._:-]{1,128}$` | The x402 `accepts[].payTo` value as served. |
| `network` | CAIP-2 `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$` | Chain the payment would settle on. |
| `scheme` | `^[a-z][a-z0-9_-]{0,31}$` | x402 scheme of the selected requirement, e.g. `exact`. |
| `decision` | `allow \| block \| warn \| unavailable` | §5. Exactly one value; required. |
| `reason_code` | closed enum (§5) | Why. Never free text. |
| `evidence_id` | `^[A-Za-z0-9._:-]{1,128}$` | Opaque id of the signed evidence behind this record (the issuer's `DecisionToken.decisionId`). |
| `expires_at` | RFC 3339 UTC, `Z` suffix | Verifiers reject at or after this instant. Records are short-lived, like the token they mirror. |
| `signature` | `{ alg: "ed25519", key_id, sig }` | §6. |

The record is **closed**: a verifier rejects any key not listed above, at any
depth. There is no extension point in v1.

## 3. What is forbidden in the record

A conforming verifier MUST reject a record that carries any of the following,
whether as a key or as a string value:

| Forbidden | Why | How the verifier catches it |
|---|---|---|
| any score (`score`, `trust_score`, `confidence`, …) | This is a decision receipt, not a reputation score. | closed schema → `forbidden_field` |
| any wallet secret (private key, seed, mnemonic, keypair, PEM) | Never evidence. | closed schema + value scan → `forbidden_content` |
| any raw payment authorization / payload (`X-PAYMENT`, `authorization`, `payload`, base64 JSON `eyJ…`) | The record proves a decision, not a credential. | closed schema + value scan → `forbidden_content` |
| a signature payload other than `signature.sig` | One signature, over the preimage in §6. | closed schema |
| the resource URL, with or without query | Committed to by `challenge_hash`, never carried. `merchant.origin` is the only URL-shaped value permitted. | value scan → `forbidden_content` |
| an amount | Committed to by `challenge_hash`. | closed schema → `forbidden_field` |
| an address-shaped or key-shaped string anywhere except `merchant.pay_to` (address), `network` (CAIP-2 reference), `signature.key_id`, `signature.sig` | A secret under an innocuous key name is still a secret. | value scan → `forbidden_content` |

The value scan is the same rule set `twzrd-x402-gate/evidence-verify` applies
to evidence bundles (PEM blocks, JWTs, bearer tokens, env assignments, home
paths, base58 key material, long hex, EVM addresses), with this record's own
closed waiver list. Waivers are by exact path and kind; there is no "trust me"
field.

## 4. Challenge normalization (`challenge_hash`)

`challenge_hash` is the **resource-bind v1 leaf** the gate already computes and
stamps (`twzrd-x402-gate/src/resource-bind.ts`, `resourceBindLeafHash`). It is
deliberately *not* a second normalization: a relying party holding an evidence
bundle (`bind.leaf_hash`) or a settled Solana transaction carrying the `rb1:`
memo already holds this exact value and can join the three artifacts.

Given the selected `accepts[]` entry **R** of a 402 response, all values taken
**as served** (strings, no trimming, no case folding):

```
amount   = R.amount ?? R.maxAmountRequired      (required)
asset    = R.asset ?? ""                        (optional)
network  = R.network                            (required; RAW wire string, NOT CAIP-2 normalized)
payTo    = R.payTo ?? R.pay_to                  (required)
resource = R.resource                           (required; absolute URL as served)
scheme   = R.scheme                             (required)

requirements_hash = hex(sha256(canonicalJson({
  "amount": amount, "asset": asset, "network": network,
  "payTo": payTo, "resource": resource, "scheme": scheme })))

resource_url = canonicalResourceUrl(resource)
   — parse with the WHATWG URL parser; drop the fragment; take the query pairs,
     stable-sort them by key (code-unit order, equal keys keep served order),
     re-append them in that order; serialize with the WHATWG serializer.

leaf = {
  "amount_raw":        amount,
  "asset":             asset,
  "body_hash":         "0000000000000000000000000000000000000000000000000000000000000000",
  "network":           network,
  "pay_to":            payTo,
  "requirements_hash": requirements_hash,
  "resource_url":      resource_url,
  "schema_version":    1
}

challenge_hash = hex(sha256("twzrd:x402-resource-binding:v1" + "\n" + canonicalJson(leaf)))
```

`canonicalJson` is the frozen PaymentIntent v1 form (`twzrd-x402-gate/src/intent.ts`):
object keys sorted by code unit, `undefined`/`null` members omitted, arrays in
order, no insignificant whitespace, numbers finite.

Rules:

- A challenge missing `payTo`, `amount`, `resource`, `network` or `scheme`
  **cannot be committed to**; the producer MUST NOT issue a record for it.
- The hash commits to the **raw** `network` string the agent saw. The record's
  `network` field carries the CAIP-2 form (§2); the two are related, not equal.
- Fields of R outside the six above (`description`, `mimeType`,
  `maxTimeoutSeconds`, `extra`, …) do not enter the hash. Two challenges that
  differ only in those fields hash the same; two that differ in any of the six
  hash differently.
- The six values are committed **exactly as served** through
  `requirements_hash`. In particular the resource URL is committed byte-for-byte:
  a reordered query string or an added fragment is a *different* challenge.
  The canonicalized `resource_url` member of the leaf is an additional,
  normalized projection; it does not relax the byte-exact commitment.

A relying party that holds the challenge recomputes `challenge_hash` and also
checks `merchant.origin === new URL(resource).origin`,
`merchant.pay_to === payTo`, `scheme === R.scheme`, and
`network === CAIP-2(R.network)`.

### 4.1 `network` (CAIP-2)

`network` MUST be CAIP-2. Producers map the x402 wire aliases the gate already
treats as equivalent; anything else must be supplied as CAIP-2 explicitly:

| wire alias (case-insensitive) | CAIP-2 |
|---|---|
| `solana`, `solana-mainnet`, `solana:mainnet`, `mainnet-beta` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `solana-devnet` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| `base`, `base-mainnet` | `eip155:8453` |
| `base-sepolia` | `eip155:84532` |

## 5. `decision` and `reason_code`

### 5.1 Decisions

| `decision` | Meaning |
|---|---|
| `allow` | The evaluator produced a verdict: proceed. |
| `warn` | The evaluator produced a verdict: proceed with caution / under a cap. |
| `block` | The evaluator produced a verdict: do not pay. |
| `unavailable` | **The evaluator produced no verdict.** Intelligence unreachable or timed out, the network is not scored, or the evaluator errored. |

`unavailable` is a first-class decision. It records the honest fact that
nothing was decided. What the agent then did under its own fail-open or
fail-closed policy (paid anyway, refused anyway) is a *local policy action*
and is **not** part of this record.

`unavailable` MUST NEVER be represented as `block`. The gate's own internal
result for an unreachable preflight is `verdict:"block", reason:"twzrd_fail_closed (…)"`
(fail-closed) or `verdict:"warn", reason:"twzrd_fail_open"` (fail-open); a
producer projecting that result onto this record MUST emit
`decision:"unavailable"` (`decisionFromApproval()` in the reference
implementation does this). A verifier MUST reject a record that claims
`decision:"block"` with an `unavailable` reason code (error
`unavailable_as_block`), a record whose `decision` and `reason_code` are
otherwise incoherent (`decision_conflict`), and a record that omits `decision`
(`decision_missing`) or gives it any value other than exactly one of the four
strings (`decision_invalid`).

### 5.2 Reason codes

The enum is closed. Every code except the four `unavailable` codes is a string
the existing policy runtime (`policy-runtime.ts` `evaluateIntent`) already
emits into `DecisionToken.reasonCodes`, reused verbatim.

| `reason_code` | valid with `decision` |
|---|---|
| `ALLOW` | `allow` |
| `INTEL_WARN` | `warn` |
| `UNKNOWN_UNDER_LIMIT` | `warn` |
| `UNKNOWN_ABOVE_LIMIT` | `warn`, `block` |
| `MANDATE_EXPIRED` | `block` |
| `MANDATE_PURPOSE` | `block` |
| `MANDATE_RESOURCE_SCOPE` | `block` |
| `MANDATE_PAYEE_BLOCKED` | `block` |
| `MANDATE_MAX_PER_TX` | `block` |
| `MANDATE_MONTHLY_CEILING` | `block` |
| `POLICY_BLOCKLIST` | `block` |
| `POLICY_NOT_ALLOWLISTED` | `block` |
| `POLICY_NETWORK` | `block` |
| `POLICY_ASSET` | `block` |
| `POLICY_MAX_AMOUNT` | `block` |
| `RECURRING_PRICE_INCREASE` | `block` |
| `NEW_COUNTERPARTY_CAP` | `block` |
| `WASH_FLAGGED` | `block` |
| `INTEL_BLOCK` | `block` |
| `twzrd_budget_exceeded` | `block` |
| `INTEL_UNAVAILABLE` | `unavailable` |
| `INTEL_TIMEOUT` | `unavailable` |
| `NETWORK_NOT_SCORED` | `unavailable` |
| `EVALUATOR_ERROR` | `unavailable` |

A record carries exactly one code. When projecting a `DecisionToken` (which
carries a list), the producer takes the **first code in the list that is valid
for the token's verdict** — a block token may list a warn code first.

## 6. What is signed

```
preimage  = "twzrd.payment_decision.v1" + "\n" + canonicalJson(record with signature.sig removed)
signature = Ed25519(issuer_private_key, preimage)
sig       = base64(signature)          // 64 bytes → 88 chars, ends "=="
```

- Every field of the record is covered, including `signature.alg` and
  `signature.key_id`. Only the signature bytes themselves are not.
- The domain string differs from `DecisionToken`'s (`twzrd-decision-v1\n`) so a
  token signature can never be replayed as a record, or vice versa, even under
  the same key.
- The signing key is the issuer's existing **decision signer**
  (`createLocalDecisionSigner` / `createSeededDecisionSigner` or a remote
  `DecisionSigner`). Verifiers pin its SPKI PEM out of band; `key_id` is a
  lookup hint, not a trust anchor.

## 7. Verification

Offline, deterministic, no network. Inputs: the record, the issuer's public key
(PEM, or a `key_id → PEM` map), a clock, and optionally the 402 challenge the
relying party holds. All checks run; all failures are reported; the record is
**accepted iff every check passes**:

1. **structure** — JSON object; exactly the v1 keys at every depth; every field
   matches its shape in §2 (`schema_mismatch`, `unknown_field`,
   `forbidden_field`, `missing_field`, `invalid_field`).
2. **decision coherence** — `decision` present and exactly one of the four;
   `reason_code` in the enum; the pair is valid per §5.2 (`decision_missing`,
   `decision_invalid`, `reason_code_unknown`, `decision_conflict`,
   `unavailable_as_block`).
3. **forbidden content** — §3 value scan (`forbidden_content`).
4. **expiry** — `now < expires_at` (`expired`). An unparseable `expires_at`
   fails closed.
5. **signature** — Ed25519 over §6 against the pinned key (`bad_signature`).
   No key ⇒ `missing_verifier_key`; a record is never accepted unverified.
6. **challenge binding** (only when the challenge is supplied) — recompute §4
   and cross-check merchant, scheme, network (`challenge_hash_mismatch`,
   `merchant_mismatch`, `scheme_mismatch`, `network_mismatch`,
   `network_unmappable`, `challenge_unhashable`). When no challenge is supplied
   this check is reported as *unchecked*, never as passed.

The verifier's `decision` output is `null` unless the record was accepted.
Never read a decision off a rejected record.

Reference: `verifyPaymentDecisionRecord(record, { publicKeyPem, now?, challenge? })`
and

```
npx twzrd-payment-decision --verify record.json --pubkey issuer.spki.pem [--challenge accepts-entry.json] [--json]
```

exit 0 = accept, 1 = reject, 2 = usage / unreadable input.

## 8. Producing a record

```ts
import { createLocalDecisionSigner, evaluateIntent } from "twzrd-x402-gate";
import {
  issuePaymentDecisionRecord,
  paymentDecisionRecordFromToken,
} from "twzrd-x402-gate/payment-decision";

const signer = createLocalDecisionSigner({ keyId: "ops-2026-09" });
// publish signer.publicKeyPem to relying parties out of band

// (a) from the existing signed DecisionToken — allow | warn | block
const token = await evaluateIntent(intent, { signer, policy });
const record = await paymentDecisionRecordFromToken(token, selectedAccepts, signer);

// (b) unavailable is issued explicitly by the caller that observed the outage
const unavailable = await issuePaymentDecisionRecord({
  challenge: selectedAccepts,
  decision: "unavailable",
  reason_code: "INTEL_UNAVAILABLE",
  evidence_id: decisionId,
  expires_at: new Date(Date.now() + 120_000).toISOString(),
}, signer);
```

Issuance fails closed: the producer runs the verifier's structural and
forbidden-content checks on the record it is about to sign and throws rather
than mint a record its own verifier would reject.

## 9. Relationship to other TWZRD artifacts

| Artifact | Relationship |
|---|---|
| `DecisionToken` (`twzrd-decision-v1`) | Internal source. Same signer. The record projects its verdict, primary reason code, `decisionId` (→ `evidence_id`) and `expiresAt`. The token additionally binds the full `PaymentIntent` and is what the wallet checks before signing; the record is what leaves the process. |
| `twzrd.evidence_bundle.v1` | Richer internal export (requirements, signer invocations, redactions). `bundle.bind.leaf_hash === record.challenge_hash` for the same offer. |
| resource-bind v1 / `rb1:` memo | Same leaf. A settled transaction carrying `rb1:base64url(challenge_hash)` is the same challenge this record decided. |
| AO-Receipt V6 (`receipt-v6-spec.md`) | Different product (reputation attestation from TWZRD's key). This record is not a score and is not signed by TWZRD; it is signed by the operator that made the decision. |

## 10. Out of scope for v1

MPP challenges (`mppChallengeDigest`) and non-x402 protocols; batch records;
key-rotation metadata beyond `key_id`; revocation. Each would be a v2 schema.
Fixtures for third-party gateways are not part of this specification.
