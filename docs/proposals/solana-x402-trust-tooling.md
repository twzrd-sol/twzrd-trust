# Solana x402 Trust Tooling — Developer Tooling Proposal

**Project:** TWZRD Agent Intelligence  
**Wishlist:** Solana x402 Trust Tooling  
**Category:** Developer Tooling  
**Funding requested:** USD 40,000  
**Delivery window:** 14 weeks  
**Proposal date:** 2026-08-19  
**Primary rail:** Solana  
**License for funded public outputs:** MIT (code); CC BY 4.0 (datasets and method documentation)

## Summary

TWZRD Agent Intelligence is a pre-spend trust gate for agents paying over x402 on Solana. It provides a free `allow | warn | block` decision after the client has selected the exact payment requirement. When the public gate is installed in the client's pre-payment hook, a `block` aborts payment creation before the signer is invoked; without the hook installed, the hosted decision is advisory. A buyer may separately purchase a signed V6 trust receipt. TWZRD does not custody buyer funds or provide identity/KYC; its optional Solana facilitator rail is documented separately from the buyer-side trust gate.

A working baseline is already shipped: the `twzrd-x402-gate` buyer hook (published on npm, with TypeScript source, tests, and examples in the public mirror), a hosted MCP surface, a public skill, signed V6 receipts, and a two-basis Solana settlement corpus. This grant hardens that baseline into a durable, reproducible public good: deterministic refuse-before-sign fixtures with clean-checkout CI, a current and inspectable settlement graph, and one independently operated payment-path integration.

The grant does not fund a private directory or a closed score; the explicit public-method / private-hosted-implementation boundary is stated under Public-good commitment. The funded outputs are the public hook, proof harness, corpus refreshes, Dune dashboard, wash/score methodology, integration documentation, and milestone evidence.

## Problem

x402 makes machine payments easy. That does not make the counterparty safe.

A client can receive a valid HTTP 402, construct a valid Solana payment, and still pay a seller whose observed settlement behavior is thin, concentrated, self-seeded, or wash-like. Facilitators verify, sponsor, screen, and settle payments; directories show what can be called. Neither exposes this proposal's specific control: a public, settlement-graph-derived seller decision in the buyer client before payment creation.

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
| Public source | `https://github.com/twzrd-sol/twzrd-trust` — MIT mirror carrying the published npm artifact (runnable JavaScript, type declarations, proof CLIs) plus the gate's TypeScript source, tests, and examples (published 2026-08-19, pre-application); deterministic fixtures and clean-checkout CI are Milestone 1 outputs |
| Dashboard | `https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official` |
| Existing mechanism proof | TWZRD-operated block and clean-control runs on the published `twzrd-x402-gate@0.8.18` (2026-08-19 transcripts): the block leg reaches `approved=false` with `signer_invocation_count=0`, zero broadcast, zero spend; the `warn`/`can_spend=true` control leg is approved and reaches the signer |
| External adoption baseline | Not claimed; an independently operated Path B refusal or qualifying seller integration remains a grant outcome |

Package registry metadata is the release source of truth. The public mirror was brought byte-identical to the published artifact, and the gate's TypeScript source, tests, and examples were published, on 2026-08-19 — before this application; none of that synchronization is funded work. Registry `latest` is `0.8.19`, a documentation-only republish of the same compiled artifact (`dist/` and `bin/` byte-identical to `0.8.18`; only the manifest and install docs changed), so the hosted surfaces' `0.8.18` pin names the same code. Known manifest defect, disclosed rather than hidden: the published manifest's `live-autogate-matrix` script names an example file that was never committed; removing or implementing it is Milestone 1 work. Milestone 1 funds what remains: deterministic fixtures, the compatibility matrix, transcript-schema reconciliation, manifest cleanup, and CI that fails on drift.

### Dated Solana corpus baseline

Public dashboard values from the dated refresh, complete through **2026-08-18 UTC** (Dune dashboard 215276; freshness query 7913460 execution `01M0CPK69Y83EKFMYJ6AJF0RAW` on 2026-08-19 reports `kpi_vintage_day=2026-08-18`, `corpus_last_payment=2026-08-18 23:59:45+00`, `corpus_freshness=FRESH`). Definitions, the reproduction query, and exclusion arithmetic are in the [current corpus note](./corpus-note-2026-08-18.md). Prior dated refreshes: [`2026-08-16`](./corpus-note-2026-08-16.md), [`2026-07-09`](./corpus-note-2026-07-09.md).

- 2,707,821 observed payments
- 106,220 raw payers
- 16,015 merchants
- 17 labeled facilitators
- USD 707,197 settled USDC
- USD 0.02 median payment
- 105,768 payers in the scrubbed demand base
- 39% one-and-done payers in the scrubbed base
- 4.61%, or 4,874 payers, classified as trusted-recurring using the published threshold of at least five payments across at least two merchants

These are ecosystem observations. They are not customer counts, and the raw and scrubbed bases must not be interchanged.

Stated plainly because a reviewer will compute it: between the 2026-07-09 and 2026-08-16 refreshes, payments grew 61.6% while the raw payer base grew 2.9%, so payments per payer rose from 16.0 to 25.1. Most new volume is existing wallets transacting more. The wash overlay does not flag one-directional captive concentration — circular-flow detection looks for self, reciprocal, and ring edges — and building that detector is Milestone 2 work under the known-failure-modes commitment. Merchants (+24.8%) and trusted-recurring payers (+34.7%) both grew faster than the payer base, which is the opposite of what pure wash inflation produces. The 2026-08-16 note carries that breakdown. The 2026-08-18 increment is +1.6% payments on +20 payers (two complete days after the daily upload), not a second structural break.

## Proposed work

### Milestone 1 — Refuse before sign

**Funding:** USD 12,000  
**Timeline:** Weeks 1–6

#### Deliverables

- Publish deterministic local fixtures for the block and clean-control paths, plus the build configuration and lockfile that make the documented build and test scripts run from a clean checkout without the hosted service; remove or implement the manifest's dead `live-autogate-matrix` script reference in the next publish. (The TypeScript source, tests, and examples themselves were published 2026-08-19, pre-application, and are not funded work.)
- Reconcile the emitted transcript schema with the acceptance fields below; `twzrd.gate_eval_refuse.v1` currently emits `signer_invocation_count` and `usdc_spent` under those names but not `decision`, `approved`, or `transaction_broadcast_count`.
- Document the canonical buyer integration for the official x402 client lifecycle using `@x402/core`, `@x402/fetch`, and `@x402/svm`, with a published compatibility matrix of tested versions. This risk is live, not hypothetical: the manifest's unpinned `^2.22.0` range resolves to `@x402/core@2.23.0`, published 2026-08-18, seven days after the `2.22.0` this package was tested against. Version `2.23.0` applies `spendControls` before the pre-payment seam and broke a clean-checkout test assertion when verified on 2026-08-19. A committed lockfile now pins the tested `2.22.0`; the funded compatibility matrix and drift CI exist to catch exactly this class of change on a timescale of days rather than releases. (The shipped refuse path is unaffected — a separate re-run of `bin/twzrd-gate-eval-refuse.js` under `2.23.0` returned `block`, `signer_invocation_count=0`, `usdc_spent=0`, and `verified=true`.)
- Document the compatible Solana seam for clients that expose a pre-payment hook, including the supported `x402-solana@2.1.0` seam.
- Productize the refuse-before-sign harness with both block and clean-control paths (the 2026-08-19 transcripts are the manual baseline this replaces).
- Publish a machine-readable transcript schema containing the selected payment requirement, TWZRD decision, reason, signer invocation count, broadcast count, and USDC spent.
- Add clean-checkout CI that runs the deterministic proof path and fails on package, documentation, or hosted-pin drift — covering the repository, the npm registry, and the live `skill.md` and `llms.txt`.

#### Acceptance criteria

A reviewer can start from a clean checkout, install the documented public package, and reproduce a block against the published deterministic fixture; a live test 402 may serve as supplementary evidence but is not required for acceptance. The resulting transcript must show:

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
- Publish at least four dated corpus refreshes during the eight-week milestone, no more than 14 days apart, unless a dated upstream-pause notice is displayed; the Dune dashboard displays a visible coverage watermark throughout.
- Publish the corpus construction and refresh runbook.
- Publish the wash and score methodology used for public decisions, including definitions, thresholds, equations or SQL, exclusions, known failure modes, and interpretation guidance.
- Publish reconciliation checks showing that headline totals, scrubbed demand tables, and dashboard panels use the intended basis.
- State clearly that the settlement graph is observed behavior, not a catalog, KYC result, fraud verdict, or ranking of service quality.

#### Acceptance criteria

- At least four dated corpus refreshes are published across the milestone, no more than 14 days apart absent a dated pause note, each with raw and scrubbed payer bases separately labeled.
- The Dune dashboard and downloadable/public query outputs show the same coverage date and reconcile to the published refresh notes.
- An independent reviewer can follow the public method and reproduce the published wash/score inputs from the released tables or queries.
- No public table silently substitutes the raw payer count for the scrubbed demand base.
- If an upstream data source prevents a scheduled refresh, the dashboard carries a dated pause note rather than presenting stale data as current.

The success metric is inspectability and reproducibility, not a larger catalog or a higher raw transaction count.

### Milestone 3 — Foreign seats, not catalog growth

**Funding:** USD 14,000  
**Timeline:** Weeks 7–14, in parallel with Milestone 2

#### Deliverables

- Complete settle-gate shadow coverage on the hosted settlement path. The hosted service already runs `enabled=true, shadow=true, enforcing=false`; the funded work is what does not exist yet: durable decision logging on the path that actually settles, the published sample-size/error threshold, and the evaluation over real shadow traffic.
- Before any enforce activation, publish the named sample-size/error threshold, the observed shadow result, and a dated go/no-go note.
- If the threshold is not met, remain in shadow mode and publish a written pause. Safety takes precedence over claiming enforcement.
- Support and document an integration on infrastructure not operated by TWZRD.
- Publish a scrub-clean closeout artifact for at least one qualifying adoption path.

#### Acceptance criteria

Milestone 3 requires the product-development deliverables above **and at least one** of the following independently operated outcomes:

1. **Foreign Path B refusal:** an external x402 buyer seats the TWZRD hook on its payment client and publishes a refusal transcript with `signer_invocation_count=0` and `usdc_spent=0`; or
2. **Foreign seller integration:** a live Solana x402 seller operated outside TWZRD publishes a 402 payment requirement that names fee payer `4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE`, and the closeout includes a returned TWZRD trust artifact from that rail (for example the `merchant_attach` returned on settle). Naming the fee payer alone proves routing through TWZRD, not use of the trust gate.

The artifact must identify the integration, timestamp the run, show the selected Solana payment requirement, and pass TWZRD's published internal/demo scrub rules.

The following do **not** satisfy this milestone:

- catalog or directory growth
- `free_card_hits`
- npm download counts
- a TWZRD-owned refuse fixture
- a TWZRD-owned wallet or seller
- a self-declared run without matching operator and server-side evidence

If neither independently operated outcome exists by milestone close, Milestone 3 is not paid. Its scope may be revised only by written agreement with the Foundation; no internal substitute will be claimed.

## Budget

| Milestone | Use of funds | Amount |
|---|---|---:|
| 1. Refuse before sign | Deterministic fixtures and proof harness incl. transcript-schema reconciliation (~40%), client adapters and compatibility matrix (~25%), clean-checkout CI and drift gates (~20%), reproducible documentation and examples (~15%) | USD 12,000 |
| 2. Settlement graph public good | Corpus/query engineering and refresh automation (~40%), public wash/score method documentation (~25%), two-basis QA and reconciliation (~20%), infrastructure costs for Dune/RPC/hosting (~15%) | USD 14,000 |
| 3. Foreign seats | External integration support (~40%), settle-gate shadow coverage and evaluation (~35%), independently verifiable closeout evidence and QA (~25%) | USD 14,000 |
| **Total** |  | **USD 40,000** |

Percentages are planning allocations tied to the deliverables above, not a market average. Funding is milestone-based and contingent on the acceptance criteria above. Catalog size, free preflight traffic, and the team's own fixtures are not substitutes for delivery.

## Public-good commitment

The following grant outputs will remain public:

- the buyer-side gate and integration examples
- the refuse-before-sign harness and transcripts
- CI and compatibility checks
- the two-basis corpus outputs and refresh notes
- the Dune dashboard and queries
- the wash/score methodology needed to inspect and reproduce public decisions
- milestone closeout reports

### Boundary: public method, private hosted implementation

TWZRD will continue to operate a private hosted scoring implementation. That is compatible with this grant only under an explicit boundary, so here it is: the grant-funded **input definitions, event-level exclusion rules, the scoring formula used for public decisions, reference queries, and the versioned decision methodology** will be public and sufficient for an independent reviewer to reproduce a published decision from released inputs. The hosted service's implementation, infrastructure, and operational tuning are not funded deliverables and are not promised. If the published material turns out not to reproduce a published decision, that is a Milestone 2 failure, not a permitted gap.

The hosted free preflight will remain available without signup during the grant period and for at least 12 months after grant completion, subject to a published deprecation and migration policy if it must ever change. Optional paid V6 receipts may support post-grant maintenance, but the public method and funded tooling will not be withdrawn behind the paid receipt.

## Why Solana

Solana makes small, frequent x402 payments economically plausible, while its public ledger makes the settlement graph reconstructable. Its explicit transaction construction and signing lifecycle also provides a crisp enforcement boundary: a deny can abort before the payer's signer is invoked. Fee-payer sponsorship allows a resource server to cover SOL fees while the buyer pays in USDC, which is directly relevant to the seller-integration acceptance path.

The funded artifacts are Solana-specific even though the high-level gate interface is portable: the public corpus is reconstructed from Solana USDC transfers and Solana fee-payer/facilitator semantics, and the seller path validates SVM transaction construction, SPL-token payment requirements, and zero-SOL buyer operation. Those datasets, fixtures, and transaction-level controls do not transfer to another network without rebuilding them.

The gate envelope can recognize other networks, but this proposal does not claim equivalent behavioral coverage elsewhere. The grant scope is Solana settlement data, Solana USDC payment requirements, and Solana pre-sign enforcement.

## Ecosystem role

Coinbase facilitators, PayAI, Dexter, and other x402 infrastructure verify, sponsor, settle, screen, or report payments. TWZRD's funded role is narrower: evaluate the seller from observed Solana settlement behavior before the buyer signs, and make the evidence and method inspectable.

The project will not claim affiliation with Coinbase, the x402 Foundation, Solana Foundation, or t54. The funded public datasets and decisions are derived from public chain activity and published facilitator or resource directories.

## Team and execution advantage

TWZRD is operated by [OPERATOR NAME — fill before submission], [role — fill before submission], the builder who shipped the existing gate, hosted MCP, signed V6 receipts, public Solana corpus, and Dune dashboard. Availability for this grant: [hours/week — fill before submission]. Representative shipped work: `twzrd-x402-gate` 0.7.x–0.8.18 on npm, Agent Intelligence 0.5.x hosted at intel.twzrd.xyz, and the public Dune corpus. Infrastructure is currently single-operator; the continuity risk and its mitigation are listed under Risks. The grant begins from working software and dated evidence rather than a concept-stage implementation.

The execution advantage is continuity across all three layers:

1. the counterparty evidence,
2. the local pre-sign decision, and
3. the proof that a deny prevented signer invocation.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| x402 client lifecycle changes | Pin tested versions, publish a compatibility matrix, and run CI against the supported lifecycle hooks. |
| Corpus or upstream data delay | Display the coverage watermark and a dated pause; never label stale data current. |
| False refusal | Include a clean-control path, version the decision policy, publish an evaluation set with observed false-positive behavior, provide a documented review route for sellers who believe they are misclassified, and require shadow evidence before settle-gate enforcement. |
| Vanity adoption | Keep discovery metrics separate from payment-path seats and apply the published internal/demo scrub. |
| External integration is not fully controllable | Milestone 3 is unpaid if its independently operated outcome does not exist; its scope changes only by written agreement with the Foundation, and internal activity is never substituted. |
| A signed receipt is mistaken for a live guarantee | Document V6 as a signed snapshot at issue time, not proof of delivery or perpetual trust. |
| Methodology gaming after publication | Version the methodology, monitor for adversarial patterns against published thresholds, and document known failure modes with each refresh. |
| Single-operator continuity | Publish the corpus-refresh and proof-CI runbooks as grant outputs so any maintainer can reproduce them; all funded artifacts live in public repositories. |

## Sustainability

After the grant, free preflight remains the public entry point, committed for at least 12 months post-grant with a published deprecation and migration policy if it must ever change. Grant funds pay only for public artifacts; the private hosted implementation is not itself a funded deliverable. Paid V6 receipt revenue does not restrict the free gate, and the public reference implementations remain usable without purchasing receipts. Corpus refresh procedures and dashboard watermarks make ongoing maintenance visible and auditable.

## Public links

- Agent contract: https://intel.twzrd.xyz/llms.txt
- Hosted MCP and API: https://intel.twzrd.xyz
- Public skill: https://intel.twzrd.xyz/skill.md
- Public distribution mirror: https://github.com/twzrd-sol/twzrd-trust
- Buyer gate: https://www.npmjs.com/package/twzrd-x402-gate
- Dune dashboard: https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official
- Mechanism transcript (block + clean control, `0.8.18`): https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/20260819-refuse-and-clean-control-0.8.18.md
- Corpus note, current refresh 2026-08-18: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proposals/corpus-note-2026-08-18.md
- Corpus note, prior refresh 2026-08-16: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proposals/corpus-note-2026-08-16.md
- Corpus note, prior refresh 2026-07-09: https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proposals/corpus-note-2026-07-09.md
