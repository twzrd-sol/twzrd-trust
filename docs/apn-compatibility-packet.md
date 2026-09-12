# Agent Payment Node compatibility packet

Three offline fixtures showing where a TWZRD pre-sign decision sits in APN's
standard x402 flow and what it changes: a clean Base merchant still produces
exactly one EIP-3009 authorization; a wash-flagged merchant produces none;
strict-local produces the same honest `unavailable` record with zero intel calls.

Targets `nuanu-ai/agent-payment-node` 0.5.x (`inspect -> prepare -> approve`).
Nothing here is a claim about APN internals beyond its public shapes
(`FreshChallenge`, `InspectCandidate`, `SelectedPrepareOffer`) and its documented
contract that `prepare` freezes the selected offer and `approve` creates one
authorization.

## The seam

```
apn pay x402 inspect  ->  apn pay x402 prepare  ->  [ TWZRD decides ]  ->  apn pay x402 approve
                          frozen offer:              on the frozen payee     one EIP-3009
                          payee, amount, network,    + network + amount      authorization,
                          offerHash                                          durable receipt
```

TWZRD stays in the caller. APN's local policy (owner caps, offer selection,
foreground phrase) is untouched. The wrapper maps the frozen offer onto
`evaluateBeforePaymentCreation` (same evaluator as PayKit /
`onBeforePaymentCreation`). Fake `approve` runs only when that evaluator
does not abort. The portable `twzrd.payment_decision.v1` sidecar is issued
from that approval and stored next to APN's receipt, joined on `offerHash` /
operation id.

Pin: `twzrd-x402-gate@0.9.7`. That record is the **$0.001** clearance SKU.
Path A $0.05 V7 intel is not this packet.

## What the three fixtures prove

| Fixture | merchant_card | TWZRD decision | `approve` calls | authorizations | broadcast | spend |
|---|---|---|---|---|---|---|
| A. clean Base merchant | `wash_flagged: false` | `unavailable` / `NETWORK_NOT_SCORED`, policy allow | 1 | 1 | 1 | amount |
| B. flagged Base merchant | `wash_flagged: true` | `block` / `WASH_FLAGGED` | 0 | 0 | 0 | 0 |
| C. strict (all-local) | no GET | `unavailable` / `NETWORK_NOT_SCORED` | 0 | 0 | 0 | 0 |

Both records verify offline with the issuer's public key and carry no score,
no resource URL, no authorization bytes.

Run:

```sh
cd twzrd-x402-gate
npx tsx examples/apn-prepare-approve-proof.ts     # prints A/B/C records + counters
npx tsx test/apn-prepare-approve.test.ts          # asserts the table above
```

## Honest semantics on Base

TWZRD's behavioral reputation is Solana-deep. On `eip155:8453` the gate does
not invent a score: the decision for a clean merchant is `unavailable` with
reason `NETWORK_NOT_SCORED`, and the policy action is allow. What it does add
on Base is the wallet-keyed wash refusal (`merchant_card.wash_flagged`), which
fires before any authorization is created. That is the whole claim of fixtures
A/B/C: no false "allow", one real refuse, one honest local fallback.

## The disqualifier, checked

The wrapper makes one outbound HTTPS GET (`/v1/intel/merchant_card/{payTo}`)
between prepare and approve. If APN policy must stay entirely local, the
packet degrades honestly: `unsupportedNetworkMode: "strict"` blocks every
unscored network with no network call, and the record still says
`unavailable` (fixture C in the test). A record produced elsewhere can also be
verified fully offline by APN with only the issuer public key.

## The ask

Two small, optional seams would let APN carry this natively; neither changes
default behaviour:

1. an optional async pre-approve provider called with the frozen offer
   (`SelectedPrepareOffer`) whose refusal maps to an APN rejection shape; and
2. an extension slot on the public x402 receipt for a third-party decision
   record keyed by schema id.

Until then the wrapper is a caller-side script and the record is a sidecar.
