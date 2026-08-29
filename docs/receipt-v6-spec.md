# TWZRD AO-Receipt V6 Specification

## Overview

TWZRD AO-Receipt V6 is a portable, offline-verifiable attestation of counterparty intelligence and reputation for autonomous agents in the Solana x402 economy.

A V6 receipt allows any third party (or recipient agent) to independently verify that:
1. The trust score and reputation parameters were authored by TWZRD's published Ed25519 signing key (`twzrd-receipt-ed25519-v2`).
2. The receipt payload has not been tampered with or modified.
3. Verification requires **zero network calls** and **zero trust** in TWZRD servers after the key is pinned.

---

## Receipt Structure

A complete `TwzrdReceiptV6` object consists of:

```json
{
  "version": "v6",
  "leaf": "0x696bab7f6778236b86c8a88cd537924813331cceaccc99b0a1a4b2eaca934e30",
  "preimage": {
    "domain": "TWZRD:AO_REPUTATION_RECEIPT_V6",
    "agent_id": "11111111111111111111111111111111",
    "score": 72,
    "attention_score": null,
    "confidence_bps": 8000,
    "timestamp_unix": 1748736000,
    "payer": "11111111111111111111111111111111",
    "settlement_anchor": "63656970742d6e6f2d7265616c2d736574746c656d656e742d74782d30303031",
    "version": "v6",
    "reputation_score": null,
    "reputation_confidence_bps": null,
    "reputation_score_version": "intel_renorm_v1_1",
    "reputation_feature_window_start_unix": null,
    "reputation_data_quality": "example",
    "recheck_after_unix": 1748995200,
    "staleness_days": 3,
    "score_decay_model": "step:<=7d=1.0,<=30d=0.8,<=90d=0.5,>90d=0.25",
    "settlement_tx": "EXAMPLE-sample-receipt-no-real-settlement-tx-0001"
  },
  "signature": "5Qvodd8wALaDhJ9fSYUFaYy4Zs18vEt8rswA8HPKBkK96m52TVTnDC8tWmbwyYzxFVQqU5kegLSJk7a9PkA8uLG2",
  "signing_pubkey": "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS",
  "key_id": "twzrd-receipt-ed25519-v2",
  "signing_alg": "ed25519"
}
```

---

## Leaf Packing Specification

The 32-byte Keccak-256 leaf is computed over the concatenation of the V5 prefix and the V6 reputation block:

`leaf = keccak256( V5_PREFIX || V6_REPUTATION_BLOCK )`

### 1. V5 Prefix Layout

| Field | Type | Encoding | Notes |
|---|---|---|---|
| `domain` | string | UTF-8 | Must equal `"TWZRD:AO_REPUTATION_RECEIPT_V6"` or `"TWZRD:AO_ATTENTION_RECEIPT_V6"` |
| `agent_id` | string | UTF-8 | Target seller wallet or agent ID (base58) |
| `score` | u16 | Little-endian (2 bytes) | Overall trust score (0–100) |
| `confidence_bps` | u16 | Little-endian (2 bytes) | Confidence basis points (0–10000) |
| `timestamp_unix` | u64 | Little-endian (8 bytes) | Unix timestamp in seconds when scored |
| `payer` | 32 bytes | Raw 32-byte pubkey or SHA256(payer) | Payer wallet address |
| `settlement_anchor` | 32 bytes | Last 32 bytes of settlement tx or right-aligned | Settlement transaction identifier |

### 2. V6 Reputation Block Layout

Each optional field is prefixed with a 1-byte presence flag (`0x00` if null/absent, `0x01` if present):

| Field | Type | Encoding | Notes |
|---|---|---|---|
| `reputation_score` | opt i64 | `0x01` + i64 LE | Detailed reputation score |
| `reputation_confidence_bps` | opt u16 | `0x01` + u16 LE | Reputation confidence basis points |
| `reputation_score_version` | opt string | `0x01` + u16 len + UTF-8 bytes | Engine version (e.g. `intel_renorm_v1_1`) |
| `reputation_feature_window_start_unix` | opt u64 | `0x01` + u64 LE | Feature observation window start |
| `reputation_data_quality` | opt string | `0x01` + u16 len + UTF-8 bytes | Data quality tier (e.g. `observed_onchain`) |

---

## Field Security & Freshness Boundary

### Cryptographically Signed Fields (Leaf-Bound)
The following fields are strictly bound inside the Keccak-256 leaf. Any mutation immediately invalidates the signature:
- `domain`
- `agent_id`
- `score`
- `confidence_bps`
- `timestamp_unix`
- `payer`
- `settlement_tx` / `settlement_anchor`
- `reputation_score`
- `reputation_confidence_bps`
- `reputation_score_version`
- `reputation_feature_window_start_unix`
- `reputation_data_quality`

### Unauthenticated Freshness Advisory Fields
The following fields are JSON-only advisory metadata:
- `recheck_after_unix`
- `staleness_days`
- `score_decay_model`

**Trust Boundary Rule:** Relying parties MUST compute receipt age directly from the signed `timestamp_unix` field using an explicit maximum age policy (e.g. `--max-age 604800` for 7 days), rather than relying solely on unauthenticated advisory freshness fields.

---

## Verifier Reference

The reference implementation is distributed as [`twzrd-receipt-verifier`](https://www.npmjs.com/package/twzrd-receipt-verifier) on npm:

```bash
npx twzrd-receipt-verifier receipt.json --pubkey Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS
```

### Published Issuer Keys
- **v2 (Current):** `Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS` (`twzrd-receipt-ed25519-v2`)
- **v1 (Legacy):** `9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf`
