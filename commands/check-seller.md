---
name: check-seller
description: Check an x402 seller (a resource URL or a payTo address) with TWZRD before paying it. Makes no payment.
---

# Check an x402 seller before paying

Input: a resource URL that answers HTTP 402, or a seller payTo address.

1. URL: call the `twzrd-intel` MCP tool `evaluate_x402_resource` with it. The tool sends one unpaid request to the
   URL. Report `decision` (allow, warn, block, or unknown), `seller_wallet`, `price_usdc` with `price_kind`, and
   from `readiness_card` the `recommended_cap_usdc` and `caveats`. `unknown` means the URL issued no 402, so
   nothing was evaluated; it is not a green light. Then run step 2 on `seller_wallet`.
2. Address: call `get_merchant_card` with it. Report `next_action.decision` (refuse, insufficient_evidence, or
   no_negative_signal) and `wash_flagged`.
3. On block, refuse, or `wash_flagged: true`, say plainly not to pay. `wash_flagged: null` means never evaluated,
   not clean. `price_usdc` is a unit price only when `price_kind` is `exact`.

Do not make any payment from this command.
