# Outcome contract for one approved paid request

Scope: one API, one approved request, one payment attempt, explicit
validation, a portable outcome record. This document walks each failure
boundary of that contract against what `twzrd-x402-gate` encodes today, names
the gaps, and specifies the buyer-side outcome ledger (`src/outcome-ledger.ts`)
that closes the ones a single library can close.

"Completed" means the requested result was received and validated. "Terminal"
means this attempt has stopped. A terminal attempt can still need
investigation.

## Outcomes

| Outcome | Established fact | Next action |
|---|---|---|
| Completed | Settlement confirmed; all-in spend within the approval; result passed the bound validation rule | Return dataset and evidence |
| Refused | A required check failed before signing; signer not invoked | Return reason and evidence |
| Paid but incomplete | Settlement confirmed; result failed validation, or spend exceeded the approval | Stop. A new attempt needs a fresh approval |
| Payment outcome unknown | A signed payment may have settled; no confirmation either way | Reconcile first. No new payment on this intent until then |

Two rules follow from the table:

1. **A fresh approval never bypasses an unresolved payment.** The previous
   attempt's state is established first.
2. **An approval is single-use.** It binds one request, one cap, one expiry.
   The same approval cannot back a second attempt, including after
   "paid but incomplete".

## What the approval binds

- **Request:** method, canonical URL, body hash, and a hash over the headers
  the approval considers relevant. Credentials never enter the record.
- **Payment:** network (CAIP-2), asset, recipient, merchant charge, and a
  maximum **all-in** spend (merchant charge + assessment fees + network fees)
  in the same asset. Mixed-asset approvals need explicit per-asset caps; an
  exchange-rate rule is out of scope here.
- **Expiry.**
- **Success criteria:** the dataset schema identifier and the validation
  rule version. Passing those proves structural validity, not factual
  accuracy.

Authorization and execution are separate records. The approval commits to the
request and the limits. The execution record identifies the exact charge and
transaction within those limits.

## Boundary walkthrough against the gate

### Refused (strongest boundary today)

Encoded: intent hashing covers network, asset, amount, recipient, method, URL
and request body hash (`src/intent.ts`, `PaymentIntent`). The decision token
carries an expiry that fails closed on an unparseable date
(`src/decision-token.ts`, `assertIntentApproved`). Resource binding stamps a
memo so a settlement can be tied back to the exact offer
(`src/resource-bind.ts`). The refusing side can sign a
`blocked_never_signed` attestation with the operator's own key
(`src/outcome-attestation.ts`).

Gap: the intent has no headers field.

### Completed

Encoded: settlement transaction extraction is best-effort and may be null,
which is treated as unverifiable rather than as evidence
(`src/delivery-capture.ts`, `extractSettlementTx`). Delivery observation
records a boolean schema match at three fidelity levels (`assessSchemaMatch`).

Gap, structural: the pass criterion is derived from the **merchant's own 402
challenge** (example keys, JSON expected). Nothing in the intent, decision
token or policy lets the buyer pin an expected shape or a rule version into
the approval. Without that, "completed" is judged by the seller. There is
also no step comparing the settled amount against the approved amount.

### Paid but incomplete

Encoded: the ingredients exist as separate facts (a settled attestation, a
false schema match, a fulfillment record with `verdict: "mismatch"` in
`src/fulfillment-record.ts`). No composite state is produced, and nothing
refuses a new attempt on the same intent after that pair appears.

Gap: an idempotency record keyed on the intent hash that survives the process.

### Payment outcome unknown

Encoded: when `pay()` throws after the signer ran, spend control commits the
spend to the cap conservatively and then rethrows (`src/spend-control.ts`,
the `finally` block). The caller receives a bare error from
`createGuardedX402Fetch`. Nothing tags it as signed-but-unresolved, and the
next attempt is blocked only by budget arithmetic.

Gap, structural: the V1 outcome attestation wire codes are frozen to
`settled`, `blocked_never_signed` and `expired_unused`
(`src/outcome-attestation.ts`, `OUTCOME_CODES`); the golden vectors contain
exactly those three. "Unknown" cannot be attested without a V2 domain. The
decision registry is in-memory and the spend ledger records amounts, not
resolution status, so "reconcile before paying again" has no enforcement
point.

### All-in spend

The intent amount is the merchant charge only. No fee field exists in the
intent, resource binding, spend control or the Base adapter. Non-USDC assets
are refused outright (`src/spend-control.ts`, `non_usdc_asset`), which
sidesteps the exchange-rate question rather than answering it.

### Assurance levels for "signer not invoked"

Every `signerInvocations` count in this package is in-process. Evidence
bundles label where the count was read from and sum it across every step
(`src/evidence-bundle.ts`, `SignerProvenance`), which prevents a
cherry-picked zero but does not change the trust model: the record is the
recorder's assertion. A stronger design keeps key material out of the
agent's reach and makes a guarded signer the only signing path. Nothing in
this package does that; the wallet signer is handed in by the caller on the
client object. Describe the level accurately: **in-process count with
provenance**, not **isolated signer**.

## The outcome ledger

`src/outcome-ledger.ts` is the buyer-side enforcement point for rules 1 and
2. It is local, makes no network calls, and does not verify settlement; the
caller supplies settlement facts from its own reconciliation (facilitator
`PAYMENT-RESPONSE`, chain lookup).

### States

```
approved ──refuse()──────────▶ refused          (terminal, never signed)
   │   └──markSigning() past expiry──▶ expired  (terminal, never signed)
   └──markSigning()──▶ signing
                         │  (row is appended to the file BEFORE the signer is invoked)
                         ├──markUnknown()──▶ unknown
                         │                     │
                         ├──complete()─────────┼──▶ completed        (terminal)
                         ├──complete()─────────┼──▶ paid_incomplete  (terminal)
                         └──markNotSettled()───┴──▶ not_settled      (terminal)
```

- **Unresolved** states: `approved`, `signing`, `unknown`. Any of these on
  an intent hash blocks `begin()` for that hash under **any** decision id.
  One exception: an `approved` record whose expiry has passed lapses (it is
  recorded as `expired` by the next `begin()`), because no signer ran.
  `signing` and `unknown` never lapse.
- **Terminal** states allow a new attempt only under a **new** decision id.
- A record found in `signing` after a restart is an unknown outcome. The
  ledger does not transition it implicitly; it reports it as unresolved and
  waits for `complete()` or `markNotSettled()`.

### `complete()` decides between completed and paid_incomplete

`completed` requires all three: `validation.ok`, the validation rule version
equal to the one bound in the approval, and settled all-in spend
(`amountAtomic + feesAtomic`) at or under `maxAllInAtomic` (default: the
merchant charge, so any fee at all is over). Anything else is
`paid_incomplete` with reason codes `validation_failed`,
`validation_rule_mismatch` and/or `spend_exceeds_approval`.

`complete()` without a settlement transaction throws: no transaction means
the outcome is still unknown.

### Durability

Append-only JSONL with a sha256 hash chain, replayed on open, failing closed
on a corrupt row, unknown schema or broken chain (the same discipline as
`spend-ledger-file.ts`). Every transition is a synchronous append that
completes before in-memory state changes. That survives process death, not
power loss: there is no fsync. Single-process writer; use
`sharedFileOutcomeLedger(path)` so one process holds one chain per file.
`get()` returns the latest attempt on an intent hash; a new attempt after a
terminal state replaces the in-memory record, and earlier attempts remain in
the file.

### Wired into `createGuardedX402Fetch` (opt-in)

Pass `outcomeLedger` (a ledger, or `{ ledger, validate, ruleVersion,
schemaId }`). `src/outcome-ledger-x402.ts` places each transition on the real
402 round trip:

| Leg | Event | Ledger |
|---|---|---|
| transport, unpaid request | 402 comes back | remember method + body hash for the URL |
| client pre-sign hook | before local + TWZRD checks | `begin()`; an unresolved earlier attempt on this intent aborts here |
| client pre-sign hook | checks abort | `refuse(reason)` |
| client pre-sign hook | checks pass | `markSigning()`, appended before the scheme signs |
| transport, paid retry | throws | `markUnknown(cause)` |
| transport, paid retry | `PAYMENT-RESPONSE` success + transaction | `complete()` with the bound validator |
| transport, paid retry | `PAYMENT-RESPONSE` success:false | `markNotSettled(["settle_failed", ...])` |
| transport, paid retry | no `PAYMENT-RESPONSE`, or no transaction in it | `markUnknown()` |

The key is the intent hash of what the gate saw: payTo, network, asset,
base-unit amount, canonical request URL (fragment dropped, query kept),
method and body hash. Two different bodies to the same URL are two intents.
A concurrent duplicate of an in-flight intent aborts with
`unresolved_attempt`, which is the contract's rule, not a race.

The default validator (`X402_PAID_RESPONSE_RULE_V1`) passes on a 2xx. A
buyer-side validator receives a clone of the response and must answer with
the configured `ruleVersion`; a thrown validator is a failed validation, never
a completion.

Settlement facts come from the facilitator's `PAYMENT-RESPONSE` as the seller
relayed it. The binding does not check the chain. Reconciling an `unknown`
record (`complete()` or `markNotSettled()`) is a separate, attended step done
against the ledger directly.

### Manual call sequence (without the guarded fetch)

```ts
const ledger = sharedFileOutcomeLedger(join(homedir(), ".twzrd", "outcomes.jsonl"));
const h = intentHash(intent);
ledger.begin({ intentHash: h, decisionId, approval });   // throws if unresolved / reused
// ... preflight, recipient, price, expiry checks ...
if (!checksPass) return ledger.refuse(h, { reasonCodes });
ledger.markSigning(h);                                   // appended before the signer
try {
  const { response, settlement } = await pay();          // the ONLY signing path
  const validation = runBoundRule(response, approval.validation);
  return ledger.complete(h, { settlement, validation });
} catch (err) {
  ledger.markUnknown(h, { cause: String(err) });         // nothing retries from here
  throw err;
}
```

## Not done here, deliberately

- Attesting `unknown` or `paid_incomplete` portably needs a V2 attestation
  domain; V1 wire codes are frozen.
- Binding headers and fees into the intent hash is a change to
  `PaymentIntent` and its canonical JSON; this ledger stores the binding but
  does not recompute the hash.
- `spendControlSafeFetch` (the AgentCash CLI path) is not wired: that payer
  does not return the challenge it signed, so the binding cannot prove which
  terms were signed (`safe-fetch.ts`,
  `requirement_scored_matches_requirement_signed: false`).
- The wiring has been exercised against a real `x402Client` with a fake
  scheme in tests, not yet against a live 402 in an attended run.
