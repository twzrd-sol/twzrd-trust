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

Pre-spend trust gate for agents paying over x402 on Solana. Free allow|warn|block before the wallet signs. Optional signed V6 receipt after paid trust. Not a wallet, not KYC, not a payment gateway.

Primary rail: Solana. MIT-licensed public gate distribution: twzrd-x402-gate (buyer hook), hosted MCP at intel.twzrd.xyz, skill at intel.twzrd.xyz/skill.md. TypeScript source and tests are a Milestone 1 output, not a current-state claim. Settlement graph is observed payment behavior, not a service catalog.

Why this grant: x402 volume without a public, inspectable counterparty check is wash-blind. We already ship the gate and the Solana corpus. This ask funds making that tooling the default public good other Solana x402 clients can install, not a private TWZRD product.

## Budget proposal (paste)

Milestone 1 — $12,000 — Refuse-before-sign (6 weeks)
- Publish the TypeScript source, tests, deterministic fixtures, and build config for the gate, and document it as the Solana x402 pre-sign hook (@x402/core + x402-solana). The mirror-version synchronization completed 2026-08-19 is not funded work.
- Public refuse-before-sign proof path. A block must reach signer_invocation_count=0, transaction_broadcast_count=0, usdc_spent=0, plus a documented clean-control path proving selective refusal.
- Clean-checkout CI failing on drift across package, repo docs, and the hosted llms.txt / skill.md pins. Measure: published source + tests + a reproducible refuse transcript carrying the named acceptance fields, with a clean control.

Milestone 2 — $14,000 — Settlement graph public good (8 weeks)
- Keep the Solana x402 two-basis corpus (raw vs scrubbed) and Dune dashboard current, with a visible coverage watermark.
- Publish wash / score methodology so other builders can reuse it.
- Measure: dated corpus refresh + public dashboard + method write-up. If an upstream source blocks a refresh, publish a dated pause rather than presenting stale data as current.

Milestone 3 — $14,000 — Adoption (8 weeks, parallel with M2)
- Product development: settle-gate shadow → enforce only after a named threshold and a written pause.
- Adoption: one foreign Path B refuse seat or one live Solana 402 that names feePayer 4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE.
- Not a win: catalog size, free_card_hits, npm downloads, our own refuse fixture, a TWZRD-owned wallet or seller, or a self-declared run without matching operator and server-side evidence.

Total $40,000. Contingent on the criteria above.

## Relevant metrics (paste; dated, do not freeze as "today")

Live: intel.twzrd.xyz (Agent Intelligence v0.5.8). Buyer gate twzrd-x402-gate@0.8.18. Hosted MCP + skill.md. Public source: github.com/twzrd-sol/twzrd-trust.

Solana x402 corpus (complete through 2026-07-09 UTC, Dune 215276): 1,649,588 payments, 103,243 payers (raw), 12,832 merchants, $433,213 settled USDC, median $0.03. Scrubbed demand base 102,801 payers: 39.1% one-and-done; 3.51% (3,613) trusted-recurring (≥5 payments, ≥2 merchants).

Those wallets are ecosystem observations, not TWZRD customers. Paid V6 receipts and Path A cash are Solana-settlement only. Catalog / free preflight hits are discovery health, not adoption.

## Why You (paste)

I operate TWZRD, the independent Solana x402 settlement-graph and pre-spend trust gate. I already shipped what this grant would fund: a live buyer hook that can refuse before sign, a hosted MCP, signed V6 receipts, and a public two-basis Dune corpus of Solana x402 settlements.

Edge vs Coinbase facilitator, PayAI, Dexter, and the x402.org last-30 "buyers" print: they move or report payments. I score counterparties from observed Solana settlement before the wallet signs, and I scrub internals/demo so wash is not sold as demand. Not affiliated with Coinbase, the x402 Foundation, the Solana Foundation, or t54. Everything sold or published is derived from public chain and published facilitator directories.

Solana is the rail because USDC x402 here is cheap enough for agent micropayments and the graph is reconstructable on a public ledger. Fee-payer sponsorship also lets a resource server cover SOL fees while the buyer pays USDC, which is what the seller-integration acceptance path in Milestone 3 depends on. This grant is for that public tooling staying public, not for a closed score.

## Backup if the category is changed off Developer Tooling

Use the same budget, metrics, and Why You pastes. Public-good sentence:

The project is a public good because it turns a private "should this agent sign?" check into installable Solana x402 developer tooling: an open pre-sign hook, a two-basis public corpus, and a published wash/score method. Other clients can refuse-before-sign without becoming TWZRD customers.
