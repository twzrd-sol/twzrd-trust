# TWZRD Trust Assurance

**Applies to:** TWZRD Agent Intel `0.5.x`, the buyer-side x402 gate, and V6 trust receipts

**Last verified:** 2026-07-18

**Disclosure:** [SECURITY.md](../SECURITY.md)

This document states the security properties TWZRD implements, the evidence a reviewer can reproduce, and the boundaries it does not claim to cross.

## Security objective

TWZRD is an authorization layer for autonomous-agent payments. It is designed to answer whether a buyer should pay a specific seller and resource **before** a wallet signs. TWZRD does not custody funds or settle payments.

The security loop is:

1. discover the seller and resource;
2. request a free preflight decision;
3. enforce the chosen policy before `wallet.signTransaction`;
4. optionally purchase deeper trust intelligence;
5. verify the returned receipt independently.

## Implemented properties

| Property | Implementation | Public evidence |
| --- | --- | --- |
| Pre-sign policy | `twzrd-x402-gate` evaluates the seller before signature creation | [`twzrd-x402-gate/`](../twzrd-x402-gate/) |
| Decision transparency | Preflight returns `allow`, `warn`, or `block`, plus confidence, reason codes, risk factors, recommended action, and a spend cap | [`POST /v1/intel/preflight`](https://intel.twzrd.xyz/openapi.json) |
| Portable proof | V6 receipts bind provenance fields into a Keccak-256 leaf and sign the leaf with Ed25519 | [`twzrd-receipt-verifier`](https://github.com/twzrd-sol/twzrd-receipt-verifier) |
| Offline verification | A verifier can pin the signing key and validate without calling TWZRD | [`twzrd-receipt-verifier@1.2.2`](https://www.npmjs.com/package/twzrd-receipt-verifier) |
| Public machine contracts | OpenAPI, agent card, MCP descriptor, and signing key are published independently | [`openapi.json`](https://intel.twzrd.xyz/openapi.json), [agent card](https://intel.twzrd.xyz/.well-known/agent-card.json) |
| No payment custody | TWZRD recommends or enforces buyer policy; the underlying x402 client signs and settles | [`README.md`](../README.md) |

## Reproduce the receipt proof

Fetch the explicitly labeled sample receipt, verify it over HTTP, and then verify it offline with a pinned key:

```bash
curl -fsS https://intel.twzrd.xyz/v1/receipts/example \
  | jq '.twzrd_receipt' > /tmp/twzrd-sample-receipt.json

curl -fsS -X POST https://intel.twzrd.xyz/v1/receipts/verify \
  -H 'content-type: application/json' \
  --data-binary @/tmp/twzrd-sample-receipt.json | jq '.result'

npx -y twzrd-receipt-verifier@1.2.2 \
  /tmp/twzrd-sample-receipt.json \
  --pubkey 9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf \
  --self-test
```

A valid result requires all of the following:

- the recomputed leaf equals the provided leaf;
- the receipt key equals the pinned key;
- the Ed25519 signature validates;
- the tampered self-test copy fails.

The sample proves the mechanism, not a real payment or a reputation assertion about the sample wallet.

## Reproduce the pre-sign hard stop

The repository includes a zero-funds proof where a strict `block` decision prevents signer invocation:

- [pay-guard closeout](./proofs/seller-graph-payguard-closeout-2026-07-12.md)
- [runnable zero-spend harness](./proofs/examples/zero-spend-guard-check.mjs)

The security invariant is **signer invocation count = 0** on the blocked path. HTTP refusal alone is not sufficient evidence.

## Policy and failure semantics

Free preflight is advisory unless the buyer installs a gate or payment hook.

- `block`: do not sign or send.
- `warn`: proceed only under the returned cap or the buyer's stricter policy.
- `allow`: no free-tier cap; it is not a guarantee for large or recurring spend.

Integrators choose fail-open or fail-closed behavior for gate unavailability. High-value or unattended buyers should explicitly set this policy rather than inherit an implicit default.

## Trust boundaries

A valid receipt proves authorship and integrity of the signed fields. It does **not** prove that:

- the underlying scoring model is correct;
- an unknown seller is safe;
- a payment delivered the promised off-chain service;
- a score remains current after its recheck time;
- corpus observations represent customers, revenue, or organic adoption.

The buyer must still validate settlement state, resource delivery, freshness, and its own spend policy.

## Current limitations

- No completed independent third-party audit is claimed.
- No funded bug-bounty program is active.
- Broad external buyer adoption is not claimed from corpus counts alone.
- The proprietary scoring engine is not open source; public packages expose integration and verification contracts.
- Coverage is strongest for observed Solana x402 activity. Thin or unknown sellers intentionally receive conservative treatment.

These limitations are stated so diligence can distinguish implemented controls from roadmap or marketing language.
