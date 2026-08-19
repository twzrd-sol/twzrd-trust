# Solana x402 Trust Tooling — Developer Tooling Proposal

**Project:** TWZRD Agent Intelligence  
**Wishlist:** Solana x402 Trust Tooling  
**Category:** Developer Tooling  
**Funding requested:** USD 40,000  
**Delivery window:** 14 weeks  
**Proposal date:** 2026-08-19  
**Primary rail:** Solana  
**License for funded public outputs:** MIT

## Summary

TWZRD Agent Intelligence is a pre-spend trust gate for agents paying over x402 on Solana. It gives a buyer a free `allow | warn | block` decision after the client has selected the exact payment requirement and before the wallet signs. A buyer may separately purchase a signed V6 trust receipt. TWZRD is not a wallet, KYC provider, marketplace, or payment gateway.

The tooling already exists: the `twzrd-x402-gate` buyer hook, a hosted MCP surface, a public skill, signed V6 receipts, and a two-basis Solana settlement corpus. This grant turns those shipped components into a durable public good: a reproducible refuse-before-sign integration, a current and inspectable settlement graph, and one independently operated payment-path integration.

The grant does not fund a private directory or a closed score. The funded outputs are the public hook, proof harness, corpus refreshes, Dune dashboard, wash/score methodology, integration documentation, and milestone evidence.

## Problem

x402 makes machine payments easy. That does not make the counterparty safe.

A client can receive a valid HTTP 402, construct a valid Solana payment, and still pay a seller whose observed settlement behavior is thin, concentrated, self-seeded, or wash-like. Facilitators verify and settle payments; directories show what can be called. Neither is a public, inspectable counterparty check before the wallet signs.

The gap has two parts:

1. **Enforcement:** a trust decision must be able to abort payment payload creation before the signer is invoked.
2. **Evidence:** the decision must be grounded in an inspectable settlement corpus whose raw and scrubbed bases are clearly separated.

TWZRD addresses both. The buyer gate evaluates the selected `network + payTo + amount + resource` before signing. The settlement graph observes payment behavior and explicitly distinguishes raw ecosystem activity from a scrubbed demand base. The graph is not a service catalog, and observed wallets are not TWZRD customers.

## Existing baseline

The following is the dated baseline for this proposal, not a claim of external adoption.

| Surface | Baseline |
|---|---|
| Hosted service | `https://intel.twzrd.xyz` — Agent Intelligence v0.5.8 |
| Buyer hook | `twzrd-x402-gate@0.8.18` |
| Agent surfaces | Hosted MCP, `llms.txt`, and public `skill.md` |
| Public source | `https://github.com/twzrd-sol/twzrd-trust` |
| Dashboard | `https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official` |
| Existing mechanism proof | A TWZRD-operated block path reaches `approved=false` with no USDC spent and no transaction broadcast |
| External adoption baseline | Not claimed; an independently operated Path B refusal or qualifying seller integration remains a grant outcome |

Package registry metadata is the release source of truth. Synchronizing the public mirror, install pins, compatibility matrix, and proof path is part of Milestone 1.

### Dated Solana corpus baseline

Complete through **2026-07-09 UTC** (Dune dashboard 215276):

- 1,649,588 observed payments
- 103,243 raw payers
- 12,832 merchants
- USD 433,213 settled USDC
- USD 0.03 median payment
- 102,801 payers in the scrubbed demand base
- 39.1% one-and-done payers in the scrubbed base
- 3.51%, or 3,613 payers, classified as trusted-recurring using the published threshold of at least five payments across at least two merchants

These are ecosystem observations. They are not customer counts, and the raw and scrubbed bases must not be interchanged.

## Proposed work

### Milestone 1 — Refuse before sign

**Funding:** USD 12,000  
**Timeline:** Weeks 1–6

#### Deliverables

- Synchronize and pin the public `twzrd-x402-gate` source, package metadata, documentation, and examples.
- Document the canonical buyer integration for the official x402 client lifecycle using `@x402/core`, `@x402/fetch`, and `@x402/svm`.
- Document the compatible Solana seam for clients that expose a pre-payment hook, including `x402-solana` where applicable.
- Publish a self-contained refuse-before-sign harness with both block and clean-control paths.
- Publish a machine-readable transcript schema containing the selected payment requirement, TWZRD decision, reason, signer invocation count, broadcast count, and USDC spent.
- Add public CI coverage for the deterministic proof path and version/pin consistency.

#### Acceptance criteria

A reviewer can start from a clean checkout, install the documented public package, and reproduce a block against the published fixture or live test 402. The resulting transcript must show:

- `decision=block`
- `approved=false`
- `signer_invocation_count=0`
- `transaction_broadcast_count=0`
- `usdc_spent=0`

The clean-control path must also be documented so that the harness proves selective refusal rather than a client that blocks every payment.

A TWZRD-operated fixture proves mechanism only. It does not satisfy Milestone 3 adoption.

### Milestone 2 — Settlement graph as a public good

**Funding:** USD 14,000  
**Timeline:** Weeks 7–14

#### Deliverables

- Refresh and publish the Solana x402 corpus on two explicit bases:
  - **Raw:** observed settlement activity.
  - **Scrubbed:** event-level exclusions for disclosed internal, demo-exposed, and test-shaped activity.
- Keep the public Dune dashboard current during the milestone and display a visible coverage watermark.
- Publish the corpus construction and refresh runbook.
- Publish the wash and score methodology used for public decisions, including definitions, thresholds, equations or SQL, exclusions, known failure modes, and interpretation guidance.
- Publish reconciliation checks showing that headline totals, scrubbed demand tables, and dashboard panels use the intended basis.
- State clearly that the settlement graph is observed behavior, not a catalog, KYC result, fraud verdict, or ranking of service quality.

#### Acceptance criteria

- At least one dated corpus refresh is published at milestone close, with raw and scrubbed payer bases separately labeled.
- The Dune dashboard and downloadable/public query outputs show the same coverage date and reconcile to the published refresh notes.
- An independent reviewer can follow the public method and reproduce the published wash/score inputs from the released tables or queries.
- No public table silently substitutes the raw payer count for the scrubbed demand base.
- If an upstream data source prevents a scheduled refresh, the dashboard carries a dated pause note rather than presenting stale data as current.

The success metric is inspectability and reproducibility, not a larger catalog or a higher raw transaction count.

### Milestone 3 — Foreign seats, not catalog growth

**Funding:** USD 14,000  
**Timeline:** Weeks 7–14, in parallel with Milestone 2

#### Deliverables

- Productize the optional settle-gate path in shadow mode.
- Before any enforce activation, publish the named sample-size/error threshold, the observed shadow result, and a dated go/no-go note.
- If the threshold is not met, remain in shadow mode and publish a written pause. Safety takes precedence over claiming enforcement.
- Support and document an integration on infrastructure not operated by TWZRD.
- Publish a scrub-clean closeout artifact for at least one qualifying adoption path.

#### Acceptance criteria

Milestone 3 requires the product-development deliverables above **and at least one** of the following independently operated outcomes:

1. **Foreign Path B refusal:** an external x402 buyer seats the TWZRD hook on its payment client and publishes a refusal transcript with `signer_invocation_count=0` and `usdc_spent=0`; or
2. **Foreign seller integration:** a live Solana x402 seller operated outside TWZRD publishes a 402 payment requirement that names fee payer `4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE`.

The artifact must identify the integration, timestamp the run, show the selected Solana payment requirement, and pass TWZRD's published internal/demo scrub rules.

The following do **not** satisfy this milestone:

- catalog or directory growth
- `free_card_hits`
- npm download counts
- a TWZRD-owned refuse fixture
- a TWZRD-owned wallet or seller
- a self-declared run without matching operator and server-side evidence

## Budget

| Milestone | Use of funds | Amount |
|---|---|---:|
| 1. Refuse before sign | Package/source synchronization, client adapters, proof harness, CI, and reproducible documentation | USD 12,000 |
| 2. Settlement graph public good | Corpus pipeline, Dune refreshes, two-basis QA, public wash/score method, and refresh documentation | USD 14,000 |
| 3. Foreign seats | Settle-gate shadow/evaluation work, external integration support, and independently verifiable closeout evidence | USD 14,000 |
| **Total** |  | **USD 40,000** |

Funding is milestone-based and contingent on the acceptance criteria above. Catalog size, free preflight traffic, and the team's own fixtures are not substitutes for delivery.

## Public-good commitment

The following grant outputs will remain public:

- the buyer-side gate and integration examples
- the refuse-before-sign harness and transcripts
- CI and compatibility checks
- the two-basis corpus outputs and refresh notes
- the Dune dashboard and queries
- the wash/score methodology needed to inspect and reproduce public decisions
- milestone closeout reports

The hosted free preflight will remain available without signup during the grant period. Optional paid V6 receipts may support post-grant maintenance, but the public method and funded tooling will not be withdrawn behind the paid receipt.

## Why Solana

Solana makes small, frequent x402 payments economically plausible, while its public ledger makes the settlement graph reconstructable. Its explicit transaction construction and signing lifecycle also provides a crisp enforcement boundary: a deny can abort before the payer's signer is invoked. Fee-payer sponsorship allows a resource server to cover SOL fees while the buyer pays in USDC, which is directly relevant to the seller-integration acceptance path.

The gate envelope can recognize other networks, but this proposal does not claim equivalent behavioral coverage elsewhere. The grant scope is Solana settlement data, Solana USDC payment requirements, and Solana pre-sign enforcement.

## Ecosystem role

Coinbase facilitators, PayAI, Dexter, and other x402 infrastructure move, verify, settle, or report payments. TWZRD's funded role is narrower: evaluate the seller from observed Solana settlement behavior before the buyer signs, and make the evidence and method inspectable.

The project will not claim affiliation with Coinbase, the x402 Foundation, Solana Foundation, or t54. Public data is derived from public chain activity and published facilitator or resource directories.

## Team and execution advantage

TWZRD is operated by the builder who shipped the existing gate, hosted MCP, signed V6 receipts, public Solana corpus, and Dune dashboard. The grant begins from working software and dated evidence rather than a concept-stage implementation.

The execution advantage is continuity across all three layers:

1. the counterparty evidence,
2. the local pre-sign decision, and
3. the proof that a deny prevented signer invocation.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| x402 client lifecycle changes | Pin tested versions, publish a compatibility matrix, and run CI against the supported lifecycle hooks. |
| Corpus or upstream data delay | Display the coverage watermark and a dated pause; never label stale data current. |
| False refusal | Include a clean-control path, keep policy configurable, and require shadow evidence before settle-gate enforcement. |
| Vanity adoption | Keep discovery metrics separate from payment-path seats and apply the published internal/demo scrub. |
| External integration is not fully controllable | Make Milestone 3 contingent on independently operated evidence rather than substituting internal activity. |
| A signed receipt is mistaken for a live guarantee | Document V6 as a signed snapshot at issue time, not proof of delivery or perpetual trust. |

## Sustainability

After the grant, free preflight remains the public entry point. Optional paid V6 receipts and integration support provide a maintenance path without converting the funded gate or methodology into a closed product. Corpus refresh procedures and dashboard watermarks make ongoing maintenance visible and auditable.

## Public links

- Agent contract: https://intel.twzrd.xyz/llms.txt
- Hosted MCP and API: https://intel.twzrd.xyz
- Public skill: https://intel.twzrd.xyz/skill.md
- Public source: https://github.com/twzrd-sol/twzrd-trust
- Buyer gate: https://www.npmjs.com/package/twzrd-x402-gate
- Dune dashboard: https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official
- Existing mechanism transcript: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/20260716-wash-refuse-transcript.md
