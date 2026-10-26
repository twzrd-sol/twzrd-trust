# TWZRD Security & Trust Assurance

**Applies to:** `twzrd-x402-gate@0.15.0`, TWZRD Agent Intelligence, and V7 trust receipts  
**Last verified:** 2026-10-24 (live surfaces, registry versions, transparency-log anchors). The gate properties below were last re-verified against 0.11.2 on 2026-09-12. The install pin is now 0.15.0 (registry versions read 2026-10-26). 0.15.0 adds Demand Desk authorization `2.1.0-demand-desk`, which accepts capped Compute Budget instructions and one signed Memo beside the vault spend; no `2.0.0-demand-desk` outcome changes. 0.14.0 added the Demand Desk authorization v2 verifier and the `createDemandDeskWallet` signer facade; both are new entry points, and no existing allow or refuse outcome changed. 0.13.1 changes types and doc comments only. 0.13.0 turned three refusals on by default, each with a named opt-out: `refuseWashUnknown` (added as opt-in in 0.12.0), `refuseUncappedWarn` and `refuseUnevaluated` (gate `CHANGELOG.md`). Earlier: 0.12.4 added the opt-in `expectedAmount` refusal to `createBuyerFetch`, 0.12.3 the `createBuyerFetch` entry point and 0.12.2 the opt-in local fulfillment record. The release carries the 0.11.3 and 0.11.4 security fixes and requires `x402-solana@>=3.0.1`; 0.11.2 and 0.11.3 are deprecated on npm.  
**Disclosure Policy:** [SECURITY.md](../SECURITY.md)

This document states the security properties TWZRD implements, the evidence an evaluator can independently reproduce, and the explicit trust boundaries of the system.

---

## Security Objective

TWZRD provides **spend control and counterparty trust** for autonomous agents paying over x402. It evaluates whether a buyer should pay a specific seller and resource **before** a private key is reached to sign a payment. TWZRD does not custody funds or settle payments.

The security loop is:
1. **Discover:** evaluate counterparty identity and endpoint requirements.
2. **Preflight:** request a free advisory decision (`ReadinessCard`) and wash-screening.
3. **Paid check (optional):** `quickCheck` at **$0.001** (tier and score). Separately, the gate can issue a `twzrd.payment_decision.v1` from its decision, signed with your own signer. Path A $0.05 V7 is not the primary SKU.
4. **Enforce:** intercept before `wallet.signTransaction` (`signerInvocations: 0` on block).
5. **Bind:** bind settled on-chain transfers to the evaluated 402 offer (`bind-v1`).
6. **Verify:** independently verify portable Ed25519 V5, V6, or V7 receipts offline.

---

## Implemented Properties

| Property | Implementation | Public Evidence |
|---|---|---|
| **Pre-Sign Policy Gate** | `twzrd-x402-gate` intercepts payment requirements and halts execution before signature creation | [`twzrd-x402-gate/`](../twzrd-x402-gate/) |
| **Zero Signer Invocations on Block** | When policy blocks, `signerInvocations === 0` — the wallet is never called | [`examples/guard-demo.ts`](../twzrd-x402-gate/examples/guard-demo.ts) |
| **Decision Transparency** | Preflight returns `allow`, `warn`, or `block`, with confidence, reason codes, risk factors, and recommended budget caps | [`POST /v1/intel/preflight`](https://intel.twzrd.xyz/openapi.json) |
| **Offer Binding (`bind-v1`)** | Evaluates settled transaction memo and transfer legs against the scored 402 requirements | [`resource-bind-tx.ts`](../twzrd-x402-gate/src/resource-bind-tx.ts) |
| **Portable Proof** | V7 receipts bind provenance and freshness fields into a Keccak-256 leaf and sign the leaf with Ed25519 | [`docs/receipt-v6-spec.md`](./receipt-v6-spec.md) (V6 layout + V7 migration) |
| **Offline Verification** | Verifier pins the published Ed25519 key and validates receipts with zero network calls | [`twzrd-receipt-verifier@^1.4.0`](https://www.npmjs.com/package/twzrd-receipt-verifier) |
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
npx -y twzrd-receipt-verifier@^1.4.0 \
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
- The issuer did not equivocate. Non-equivocation requires the Receipt Transparency log, which is **live** under spec v0.1 (genesis 2026-09-03; `/v1/log/sth`, `/v1/log/proof/inclusion`, `/v1/log/anchors`, and inline `log_inclusion` on paid responses) — verify inclusion and consistency with [`twzrd-log-verifier`](../twzrd-log-verifier/). A receipt whose inclusion has not been verified still proves only authorship and integrity.

---

## Current Limitations & Non-Claims

- No completed independent third-party SOC2 or smart contract audit is claimed (TWZRD runs zero smart contracts; all transfers use standard SPL Token).
- Scoring coverage is focused on observed Solana x402 transactions. Unseen sellers receive conservative default treatment.
- Receipt transparency is **live under spec v0.1 only** ([spec](./transparency-log.md), [`twzrd-log-verifier`](../twzrd-log-verifier/)): heads are signed under the single-key v0.1 domain by the receipt issuer key, and the descriptor carries no key directory, so the v0.2 rotation guarantees (`key_id` bound into the head; retired keys verify-only) are **not yet in force** — a key rotation today would require re-pinning.
- Tree heads **are anchored on Solana mainnet** (verified 2026-10-25: the descriptor names `anchor_authority`, `anchor_program_id` and `anchor_ledger_pda`, and `GET /v1/log/anchors` lists the anchor transactions, each tagged with its `cluster`; the newest mainnet row is for `tree_size` 15). The anchor job runs every 6 h (00/06/12/18 UTC) and anchors a head only when it has advanced; the descriptor's `anchor_cadence_seconds` still read 3600 on 2026-10-25 and is being corrected. An anchored root bounds *when* a receipt existed, so backdating past an anchor is detectable. The live anchors are written through that on-chain program's `anchor_head` instruction with the authority as signer; they carry no SPL Memo. The `anchor` subcommand of the in-repo `twzrd-log-verifier` 0.3.0 verifies that program form against a pinned authority, from a successful transaction only, and still accepts the memo form of the v0.2 spec draft. Inclusion and consistency proofs verify as documented.
- `twzrd-log-verifier` is not yet published to npm; run it from this repository.
