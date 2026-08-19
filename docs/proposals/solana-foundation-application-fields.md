# Solana Foundation Application Fields

Form-paste companion to [`solana-x402-trust-tooling.md`](./solana-x402-trust-tooling.md).

Source form: https://share.hsforms.com/1GE1hYdApQGaDiCgaiWMXHA5lohw

Linked proposal (Developer Tooling dropdown) — public and live:

    https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proposals/solana-x402-trust-tooling.md

> Use the `main` blob URL. Branch URLs die when the branch is deleted on merge.
> Do not paste a `wzrd-final` link anywhere: that repo is private and 404s for reviewers.

## Recommended Form Choices

| Field | Response |
|---|---|
| Project | TWZRD Agent Intelligence |
| Wishlist / idea name | Solana x402 Trust Tooling |
| Which funding category are you applying for? | Developer Tooling |
| Funding amount | 40000 |
| Is / will this project be open sourced? | Yes |
| Website | https://intel.twzrd.xyz/llms.txt |
| Solana on-chain accounts | `4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE` — live Solana fee payer for sponsored x402. No token. No new program in this grant. |

## Your project / idea (paste)

TWZRD Agent Intelligence — Solana x402 Trust Tooling

https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proposals/solana-x402-trust-tooling.md
https://intel.twzrd.xyz/llms.txt
https://github.com/twzrd-sol/twzrd-trust
https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official

Pre-spend trust gate for agents paying over x402 on Solana. Free allow|warn|block preflight; when the public gate is installed in the payment client, block aborts payment creation before the signer is invoked. Optional signed V6 receipt after paid trust. Not a wallet or identity/KYC system. The buyer gate does not custody funds; an optional Solana facilitator rail is documented separately.

Primary rail: Solana. MIT-licensed public gate: twzrd-x402-gate (buyer hook — TypeScript source, tests, and the published package in the public mirror, published 2026-08-19 pre-application), hosted MCP at intel.twzrd.xyz, skill at intel.twzrd.xyz/skill.md. Settlement graph is observed payment behavior, not a service catalog.

Why this grant: public x402 volume totals do not by themselves distinguish organic counterparty demand from internal, demo, concentrated, or wash-like settlement patterns. We already ship the gate and the Solana corpus. This ask funds hardening that tooling into a reproducible public integration other Solana x402 clients can install and independently verify, not a private TWZRD product.

## Budget proposal (paste)

Milestone 1 — $12,000 — Refuse-before-sign (6 weeks)
- Deterministic local fixtures + productized proof harness (block and clean-control legs), transcript-schema reconciliation, documented @x402/core + x402-solana@2.1.0 integrations with a tested compatibility matrix. (TypeScript source, tests, and the mirror-version sync were published 2026-08-19, pre-application — not funded work.)
- A block must reach signer_invocation_count=0, transaction_broadcast_count=0, usdc_spent=0; the clean-control leg must reach the signer, proving selective refusal.
- Clean-checkout CI that fails on package, documentation, or hosted-pin drift (repo, npm, live skill.md and llms.txt). Measure: reviewer reproduces both transcript legs from a clean checkout of the published TypeScript source and tests.

Milestone 2 — $14,000 — Settlement graph public good (8 weeks)
- At least four dated refreshes of the Solana x402 two-basis corpus (raw vs scrubbed), no more than 14 days apart unless a dated pause note is displayed; visible coverage watermark throughout.
- Publish wash / score methodology so other builders can reuse it.
- Measure: dated refresh notes + public dashboard + method write-up. If an upstream source blocks a refresh, publish a dated pause rather than presenting stale data as current.

Milestone 3 — $14,000 — Adoption (8 weeks, parallel with M2)
- Product development: durable settle-gate decision logging on the settling path, a named sample/error threshold, and a written go/no-go — enforce only after that threshold, pause in writing otherwise.
- Adoption: one foreign Path B refuse seat, or one live Solana 402 operated outside TWZRD that names feePayer 4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE AND returns a TWZRD trust artifact (e.g. merchant_attach) in the closeout — the fee payer alone proves routing, not gate use.
- Not a win: catalog size, free_card_hits, npm downloads, our own refuse fixture, a TWZRD-owned wallet or seller, or a self-declared run without matching operator and server-side evidence. If no independent outcome exists at close, M3 is unpaid; scope changes only by written agreement.

Total $40,000. Contingent on the criteria above.

## Relevant metrics (paste; dated, do not freeze as "today")

Live: intel.twzrd.xyz (Agent Intelligence v0.5.8). Buyer gate twzrd-x402-gate@0.8.18. Hosted MCP + skill.md. Public source: github.com/twzrd-sol/twzrd-trust.

Solana x402 corpus — public dashboard values from the dated refresh, complete through 2026-08-16 UTC (Dune 215276; freshness query 7913460 reports last_payment 2026-08-16 23:59:59+00; definitions, reproduction query, change table, and a disclosed known failure mode: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proposals/corpus-note-2026-08-16.md): 2,665,308 payments, 106,200 payers (raw), 16,011 merchants, 17 labeled facilitators, $666,794 settled USDC, median $0.02. Scrubbed demand base 105,748 payers: 39% one-and-done; 4.6% (4,867) trusted-recurring (≥5 payments, ≥2 merchants). Payments grew 61.6% on 2.9% payer growth since the prior refresh; one-directional captive concentration is not wash-flagged and is disclosed in the corpus note.

Those wallets are ecosystem observations, not TWZRD customers. Paid V6 receipts and Path A cash are Solana-settlement only. Catalog / free preflight hits are discovery health, not adoption.

## Why You (paste)

I operate TWZRD, the independent Solana x402 settlement-graph and pre-spend trust gate. I have shipped the working baseline from which the grant milestones begin: a live buyer hook that can refuse before sign, a hosted MCP, signed V6 receipts, and a public two-basis Dune corpus of Solana x402 settlements.

Coinbase, PayAI, and Dexter verify, sponsor, screen, or settle x402 payments, while public dashboards report volume. TWZRD adds a different buyer-side control: a settlement-graph-derived seller decision in the client before payment creation, with internals/demo scrubbed so wash is not sold as demand. Not affiliated with Coinbase, the x402 Foundation, the Solana Foundation, or t54. The funded public outputs are derived from public chain and published facilitator directories.

Solana is the rail because USDC x402 here is cheap enough for agent micropayments and the graph is reconstructable on a public ledger. Fee-payer sponsorship also lets a resource server cover SOL fees while the buyer pays USDC, which is what the seller-integration acceptance path in Milestone 3 depends on. This grant is for that public tooling staying public, not for a closed score.

## Backup if the category is changed off Developer Tooling

Use the same budget, metrics, and Why You pastes. Public-good sentence:

The project is a public good because it turns a private "should this agent sign?" check into installable Solana x402 developer tooling: an open pre-sign hook, a two-basis public corpus, and a published wash/score method. Other clients can refuse-before-sign without becoming TWZRD customers.
