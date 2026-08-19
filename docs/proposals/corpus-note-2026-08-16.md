# Corpus Note — Solana x402 Settlement Corpus, refresh of 2026-08-16

Supporting note for the corpus values cited in
[`solana-x402-trust-tooling.md`](./solana-x402-trust-tooling.md). Written 2026-08-19.
Supersedes [`corpus-note-2026-07-09.md`](./corpus-note-2026-07-09.md), which is retained
as the prior dated refresh.

> **Scope (applies to every figure below).** This is the **known-facilitator classic-USDC index**, not the entire Solana x402 universe. A row is a classic-USDC SPL transfer whose fee payer is on the published known-facilitator allow-list. Self-facilitated legs (payer or merchant pays own gas), unknown third-party sponsors, merchants who never used a known facilitator, and non-USDC mints are **out of scope**. "Complete" below means no missing complete-day *inside the allow-list* — not every x402 settlement on Solana. Retained as a dated historical refresh; the current definition lives in [`corpus-note-2026-08-18.md`](./corpus-note-2026-08-18.md).

## Definitions

| Term | Definition |
|---|---|
| Payment | One observed Solana USDC transfer event attributed to an x402 settlement in the corpus event table (`x402_solana_events` row). USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. |
| Payer | Distinct sending wallet across payments in scope. |
| Merchant | Distinct receiving `payTo` wallet across payments in scope. |
| Raw basis | All **in-scope** payments, no demand exclusions applied. In-scope is defined by the banner above; this is not a census. |
| Scrubbed basis | Raw minus event-level exclusions for disclosed TWZRD-internal wallets, demo-exposed fixtures, and test-shaped activity. The full exclusion method (definitions, thresholds, SQL) is a Milestone 2 deliverable. |
| Coverage watermark | 2026-08-16 UTC — this index is complete through that complete UTC day *inside the allow-list*. Not a claim about x402 settlement outside the known-facilitator set. |

## Snapshot values (Dune refresh, 2026-08-16)

Published dashboard: <https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official>
(Dune dashboard 215276). Freshness query 7913460 reports `last_payment 2026-08-16 23:59:59+00`;
the Data Freshness Sentinel labels this refresh FRESH. Dashboard watermark reads
"complete UTC day 2026-08-16".

| Metric | Value | Basis |
|---|---|---|
| Observed payments | 2,665,308 | raw |
| Payers | 106,200 | raw |
| Merchants | 16,011 | raw |
| Labeled facilitators | 17 | raw |
| Settled USDC | $666,794 | raw |
| Median payment | $0.02 | raw |
| Scrubbed demand base | 105,748 payers | scrubbed |
| One-and-done payers | 39% | scrubbed |
| Trusted-recurring payers | 4,867 (4.6%) | scrubbed; threshold: at least 5 payments across at least 2 merchants |

Arithmetic check: 4,867 / 105,748 = 4.602% (cited as 4.6%). Payers excluded from the
scrubbed base at this refresh: 106,200 − 105,748 = 452, or 0.43% of raw — the same
exclusion rate as the 2026-07-09 refresh (442 / 103,243 = 0.43%), which is evidence the
scrub definition did not drift between refreshes.

## Reproduction query

```sql
SELECT count(*)                                        AS payments,
       count(DISTINCT payer)                           AS payers,
       count(DISTINCT merchant)                        AS merchants,
       round((sum(usdc_amount_micro) / 1e6)::numeric)  AS settled_usdc,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY usdc_amount_micro) / 1e6)::numeric, 3) AS median_usdc
FROM x402_solana_events
WHERE block_time <= '2026-08-16 23:59:59+00';
```

## Change since the 2026-07-09 refresh

| Metric | 2026-07-09 | 2026-08-16 | Change |
|---|---:|---:|---:|
| Payments | 1,649,588 | 2,665,308 | +61.6% |
| Payers (raw) | 103,243 | 106,200 | +2.9% |
| Merchants | 12,832 | 16,011 | +24.8% |
| Settled USDC | $433,213 | $666,794 | +53.9% |
| Trusted-recurring | 3,613 (3.51%) | 4,867 (4.6%) | +34.7% |
| Payments per raw payer | 16.0 | 25.1 | +57% |

## Known failure mode — concentration is not wash-flagged

Read the row above honestly: payments grew 61.6% while the raw payer base grew 2.9%, so
payments per payer rose from 16.0 to 25.1. Most of the additional volume comes from
existing wallets transacting more, not from a wider payer base.

The wash overlay does **not** flag that pattern. Circular-flow detection looks for self,
reciprocal, and ring edges; a single payer sending a high-volume one-directional stream to
one merchant is none of those, so it passes. TWZRD has directly observed this shape on the
Solana corpus: a single payer producing on the order of 10^5 settlements to one merchant
inside a single day, at roughly half a cent each, unflagged. Captive concentration is a
different detector's job and that detector does not exist yet.

Two things partly offset the concern and are stated for balance, not as a rebuttal:
merchants grew 24.8% and trusted-recurring payers grew 34.7%, both faster than the raw
payer base. Payers clearing the ≥5-payments-across-≥2-merchants bar growing faster than
the payer base is the opposite of what pure wash inflation produces.

Consequences a reader should apply:

- Do not cite a single-day settlement count without decomposing it by top payer. On a
  concentrated day one wallet pair can account for the large majority of settlements.
- Settlement **counts** are far more sensitive to concentration than settled **USDC**,
  because the concentrated flows observed so far are sub-cent.
- Building a concentration detector, and publishing its definition alongside the wash
  overlay, is Milestone 2 work under the "known failure modes" commitment.

## Basis discipline

The raw and scrubbed bases must not be interchanged. No published table substitutes the
raw payer count for the scrubbed demand base. These are ecosystem observations, not TWZRD
customer counts.
