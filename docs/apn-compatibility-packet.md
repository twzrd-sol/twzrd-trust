# Agent Payment Node compatibility packet

Three offline fixtures showing where a TWZRD pre-sign decision sits in APN's
standard x402 flow and what it changes: a clean Base merchant still produces
exactly one EIP-3009 authorization; a wash-flagged merchant produces none; strict
mode consults the Base corpus and allows a clean, scored seller.

> **Updated 2026-10-24.** When this packet was written, Base had no corpus and the
> clean fixtures recorded `unavailable` / `NETWORK_NOT_SCORED`. Base mainnet is
> scored now (free preflight plus merchant card), and `test/apn-prepare-approve.test.ts`
> asserts the decisions in the table below as they stand today (the counters for
> fixture C come from the example run, not from an assertion).

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

Pin: `twzrd-x402-gate@0.13.1`. That record is issued from the free decision and signed locally by your own signer; no paid TWZRD call is involved.
Path A $0.05 V7 intel is not this packet.

## What the three fixtures prove

| Fixture | merchant_card | TWZRD decision | `approve` calls | authorizations | broadcast | spend |
|---|---|---|---|---|---|---|
| A. clean Base merchant | `wash_flagged: false` | scored `warn`, policy allow (one preflight, one wash read) | 1 | 1 | 1 | amount |
| B. flagged Base merchant | `wash_flagged: true` | `block` / `WASH_FLAGGED` | 0 | 0 | 0 | 0 |
| C. strict, clean Base merchant | `wash_flagged: false` | scored, policy allow; `reason_code` is not `NETWORK_NOT_SCORED` | proceeds | as A | as A | as A |

Both records verify offline with the issuer's public key and carry no score,
no resource URL, no authorization bytes.

Run:

```sh
cd twzrd-x402-gate
npx tsx examples/apn-prepare-approve-proof.ts     # prints A/B/C records + counters
npx tsx test/apn-prepare-approve.test.ts          # asserts the table above
```

## Honest semantics on Base

TWZRD's behavioral reputation started Solana-deep. Base mainnet (`eip155:8453`)
is now scored from its own corpus, so a clean merchant gets a real preflight
verdict (the fixture records `warn`) rather than an invented score or a bare
`unavailable`. The wallet-keyed wash refusal (`merchant_card.wash_flagged`)
still fires before any authorization is created. The claim of fixtures A/B/C
today: no false "allow", one real refuse, and no decision record that carries a
score. Chains with no corpus still record `unavailable` / `NETWORK_NOT_SCORED`
under `observe` and are refused under `strict`; that behaviour is covered by the
gate's own network tests, not by this packet.

## The disqualifier, checked

The wrapper makes one outbound HTTPS GET (`/v1/intel/merchant_card/{payTo}`)
between prepare and approve. If APN policy must stay entirely local, the
packet degrades honestly on a chain with no corpus: `unsupportedNetworkMode: "strict"`
blocks every unscored network with no network call, and the record says
`unavailable`. On Base, which is scored, strict mode consults the corpus (fixture C). A record produced elsewhere can also be
verified fully offline by APN with only the issuer public key.

## The ask

Two small, optional seams would let APN carry this natively; neither changes
default behaviour:

1. an optional async pre-approve provider called with the frozen offer
   (`SelectedPrepareOffer`) whose refusal maps to an APN rejection shape; and
2. an extension slot on the public x402 receipt for a third-party decision
   record keyed by schema id.

Until then the wrapper is a caller-side script and the record is a sidecar.
