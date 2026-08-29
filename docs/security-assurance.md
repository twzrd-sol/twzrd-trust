# TWZRD Security & Trust Assurance

**Applies to:** `twzrd-x402-gate@0.9.3`, TWZRD Agent Intelligence, and V6 trust receipts  
**Last verified:** 2026-08-29  
**Disclosure Policy:** [SECURITY.md](../SECURITY.md)

This document states the security properties TWZRD implements, the evidence an evaluator can independently reproduce, and the explicit trust boundaries of the system.

---

## Security Objective

TWZRD provides **spend control and counterparty trust** for autonomous agents paying over x402. It evaluates whether a buyer should pay a specific seller and resource **before** a private key is reached to sign a payment. TWZRD does not custody funds or settle payments.

The security loop is:
1. **Discover:** evaluate counterparty identity and endpoint requirements.
2. **Preflight:** request a free advisory decision (`ReadinessCard`) and wash-screening.
3. **Enforce:** intercept before `wallet.signTransaction` (`signerInvocations: 0` on block).
4. **Bind:** bind settled on-chain transfers to the evaluated 402 offer (`bind-v1`).
5. **Verify:** independently verify portable Ed25519 V6 receipts offline.

---

## Implemented Properties

| Property | Implementation | Public Evidence |
|---|---|---|
| **Pre-Sign Policy Gate** | `twzrd-x402-gate` intercepts payment requirements and halts execution before signature creation | [`twzrd-x402-gate/`](../twzrd-x402-gate/) |
| **Zero Signer Invocations on Block** | When policy blocks, `signerInvocations === 0` — the wallet is never called | [`examples/guard-demo.ts`](../twzrd-x402-gate/examples/guard-demo.ts) |
| **Decision Transparency** | Preflight returns `allow`, `warn`, or `block`, with confidence, reason codes, risk factors, and recommended budget caps | [`POST /v1/intel/preflight`](https://intel.twzrd.xyz/openapi.json) |
| **Offer Binding (`bind-v1`)** | Evaluates settled transaction memo and transfer legs against the scored 402 requirements | [`resource-bind-tx.ts`](../twzrd-x402-gate/src/resource-bind-tx.ts) |
| **Portable Proof** | V6 receipts bind provenance fields into a Keccak-256 leaf and sign the leaf with Ed25519 | [`docs/receipt-v6-spec.md`](./receipt-v6-spec.md) |
| **Offline Verification** | Verifier pins the published Ed25519 key and validates receipts with zero network calls | [`twzrd-receipt-verifier@^1.3.0`](https://www.npmjs.com/package/twzrd-receipt-verifier) |
| **No Payment Custody** | TWZRD recommends or enforces buyer policy; the buyer's own wallet signs and broadcasts | [`README.md`](../README.md) |

---

## Reproduce the Receipt Proof

Fetch the labeled sample receipt, verify it over HTTP, and verify it offline with the pinned public key:

```bash
# 1. Fetch sample signed receipt
curl -fsS https://intel.twzrd.xyz/v1/receipts/example \
  | jq '.twzrd_receipt' > /tmp/twzrd-sample-receipt.json

# 2. Verify via HTTP API
curl -fsS -X POST https://intel.twzrd.xyz/v1/receipts/verify \
  -H 'content-type: application/json' \
  --data-binary @/tmp/twzrd-sample-receipt.json | jq '.result'

# 3. Offline verification (no network required)
npx -y twzrd-receipt-verifier@^1.3.0 \
  /tmp/twzrd-sample-receipt.json \
  --pubkey Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS \
  --self-test
```

A valid result proves:
- Recomputed Keccak-256 leaf matches `receipt.leaf`.
- Ed25519 signature is cryptographically valid for the pinned key (`Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS`).
- Mutating any signed field causes verification to fail.

---

## Trust Boundaries & Freshness

A valid receipt proves authorship and cryptographic integrity of the signed fields. It does **not** prove that:
- An unindexed seller is safe.
- An off-chain resource delivered the promised data after settlement.
- Unauthenticated advisory metadata (`recheck_after_unix`, `staleness_days`, `score_decay_model`) is current without comparing the signed `timestamp_unix` against relying-party max age policies.

---

## Current Limitations & Non-Claims

- No completed independent third-party SOC2 or smart contract audit is claimed (TWZRD runs zero smart contracts; all transfers use standard SPL Token).
- Scoring coverage is focused on observed Solana x402 transactions. Unseen sellers receive conservative default treatment.
