---
name: twzrd-intel
description: Screen an x402 seller before signing a payment and verify TWZRD signed receipts.
version: 0.1.0
metadata:
  hermes:
    tags: [x402, solana, base, payments, security, receipts]
    category: tools
---

# TWZRD Intel: pre-spend seller screening and receipt verification

## When to use

- Before signing any HTTP `402 Payment Required` challenge whose `payTo` is a Solana or Base address.
- After a paid trust call, to verify the saved TWZRD receipt JSON.

## Procedure

1. Take `payTo` from the `accepts` entry you intend to pay. Never pass a placeholder or a template value.
2. Call `twzrd_preflight(pay_to=..., price_usdc=...)` and read `data.readiness_card`.
   - `decision: block`: do not pay.
   - `decision: warn`: pay only within `maximum_recommended_spend_usdc` and your own spend limit.
   - `decision: allow`: proceed only under your own policy.
   - `ok: false` (Intel unreachable, timeout, HTTP error): the seller was not screened. Do not pay.
3. Call `twzrd_merchant_card(pay_to=...)` and route on `data.decision` (`refuse`, `insufficient_evidence` or `no_negative_signal`).
   - `decision: refuse` or `wash_flagged: true`: refuse. It never soft-allows.
   - `wash_flagged: null`: never evaluated. That is not clean: do not report the seller as clean, and keep to the preflight decision and cap.
4. After a paid trust call, `twzrd_verify_receipt(receipt_path=..., max_age_seconds=...)` checks the Ed25519 signature against the pinned issuer key `Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS`. The check makes no network or RPC call. The first run downloads the pinned verifier package from npm, so Node.js 16+ with `npx` is required.

## Limits

- The signals describe observed settlement history. They are advisory, not identity proof.
- Both lookups are free. They send the seller address, and the resource URL if you pass one, to `intel.twzrd.xyz`.
