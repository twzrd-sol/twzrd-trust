# twzrd-trust

Buyer-side x402 **trust packages** for autonomous agents on Solana. Vet a
counterparty *before* you pay it.

Before an agent pays a stranger's API over [x402](https://x402.org), it should be
able to answer one question: *should I pay this seller, and what proof will I get?*
These packages answer it — they call the free [TWZRD](https://intel.twzrd.xyz)
preflight to score a counterparty and refuse to settle against wash-flagged or
block-rated sellers.

## Packages

| Directory | Package | What it does |
|-----------|---------|--------------|
| [`twzrd-x402-gate`](./twzrd-x402-gate) | `twzrd-x402-gate` (npm) | Buyer-side x402 trust gate. Wraps `fetch` (HTTP 402) and the `@x402/mcp` payment hook; runs a free preflight before signing USDC. Fail-open on preflight unavailability. |
| [`plugin-trustgate`](./plugin-trustgate) | `@wzrd_sol/plugin-trustgate` (npm) | elizaOS plugin — refuses to pay wash-flagged / block-rated sellers. |
| [`eliza-plugin`](./eliza-plugin) | `@wzrd_sol/eliza-plugin` (npm) | Full WZRD Agent Intel plugin for ElizaOS: preflight ReadinessCards, x402-paid signed trust receipts (V6), offline verification. |

## The trust loop

1. **Discover** — find a seller you might pay (any x402 endpoint).
2. **Preflight** — score the counterparty (free): `decision: block` means stop.
3. **Pay** — settle the x402 payment only if the gate allows.
4. **Verify** — check the returned [signed receipt](https://github.com/twzrd-sol/twzrd-receipt-verifier) offline.

## Related

- **Receipt verifier** (read the code, trust no one): https://github.com/twzrd-sol/twzrd-receipt-verifier
- **Live trust + MCP surface**: https://intel.twzrd.xyz (`/llms.txt` for the agent-facing guide)

## License

MIT — see [LICENSE](./LICENSE). Each package is independently MIT-licensed.
