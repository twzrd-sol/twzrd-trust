# Corpus Note — Solana x402 Settlement Corpus, refresh of 2026-07-09

Supporting note for the corpus values cited in
[`solana-x402-trust-tooling.md`](./solana-x402-trust-tooling.md). Written 2026-08-19.

> **Scope (applies to every figure below).** This is the **known-facilitator classic-USDC index**, not the entire Solana x402 universe. A row is a classic-USDC SPL transfer whose fee payer is on the published known-facilitator allow-list. Self-facilitated legs (payer or merchant pays own gas), unknown third-party sponsors, merchants who never used a known facilitator, and non-USDC mints are **out of scope**. "Complete" below means no missing complete-day *inside the allow-list* — not every x402 settlement on Solana. Retained as a dated historical refresh; the current definition lives in [`corpus-note-2026-08-18.md`](./corpus-note-2026-08-18.md).

## Definitions

| Term | Definition |
|---|---|
| Payment | One observed Solana USDC transfer event attributed to an x402 settlement in the corpus event table (`x402_solana_events` row). USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. |
| Payer | Distinct sending wallet across payments in scope. |
| Merchant | Distinct receiving `payTo` wallet across payments in scope. |
| Raw basis | All **in-scope** payments, no demand exclusions applied. In-scope is defined by the banner above; this is not a census. |
| Scrubbed basis | Raw minus event-level exclusions for disclosed TWZRD-internal wallets, demo-exposed fixtures, and test-shaped activity. The full exclusion method (definitions, thresholds, SQL) is a Milestone 2 deliverable of the linked proposal. |
| Coverage watermark | 2026-07-09 UTC — this index is complete through that day *inside the allow-list*. Not a claim about x402 settlement outside the known-facilitator set. |

## Snapshot values (Dune refresh, 2026-07-09)

Published dashboard: <https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official> (Dune dashboard 215276).

| Metric | Value | Basis |
|---|---|---|
| Observed payments | 1,649,588 | raw |
| Payers | 103,243 | raw |
| Merchants | 12,832 | raw |
| Settled USDC | $433,213 | raw |
| Median payment | $0.03 | raw |
| Scrubbed demand base | 102,801 payers | scrubbed |
| One-and-done payers | 39.1% | scrubbed |
| Trusted-recurring payers | 3,613 (3.51%) | scrubbed; threshold: at least 5 payments across at least 2 merchants |

Arithmetic check: 3,613 / 102,801 = 3.5145% (cited as 3.51%). Payers excluded from the
scrubbed base at this refresh: 103,243 − 102,801 = 442.

## Reproduction query

Against the corpus event table, scoped to the watermark:

```sql
SELECT count(*)                                        AS payments,
       count(DISTINCT payer)                           AS payers,
       count(DISTINCT merchant)                        AS merchants,
       round((sum(usdc_amount_micro) / 1e6)::numeric)  AS settled_usdc,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY usdc_amount_micro) / 1e6)::numeric, 3) AS median_usdc
FROM x402_solana_events
WHERE block_time <= '2026-07-09 23:59:59+00';
```

## Post-hoc re-run (2026-08-19) and honest divergence

The corpus table is a living index: events with `block_time` before the watermark can be
indexed after the refresh that froze the snapshot. Re-running the query above on
2026-08-19 over the same window returns slightly higher values than the frozen snapshot:

| Metric | 2026-07-09 snapshot | 2026-08-19 re-run, same window | Delta |
|---|---|---|---|
| Payments | 1,649,588 | 1,676,758 | +27,170 late-indexed |
| Payers | 103,243 | 103,479 | +236 |
| Merchants | 12,832 | 12,858 | +26 |
| Settled USDC | $433,213 | $434,530 | +$1,317 |
| Median payment | $0.03 | $0.022 | recomputed over the backfilled window |

Interpretation: the snapshot values are the dashboard's frozen refresh output and are the
numbers cited in the proposal; the re-run shows the same window after ~6 weeks of
late-indexed backfill. Neither is wrong — they answer "what did the refresh publish" and
"what does the window contain now". The proposal's Milestone 2 formalizes this with dated
refresh notes so every published figure carries its refresh date, not just its coverage
watermark.

The scrubbed-basis figures (102,801 / 39.1% / 3,613) are refresh outputs of the scrub
pipeline; the pipeline's definitions and SQL are a Milestone 2 deliverable and are not
yet independently reproducible from public materials. They are labeled accordingly in
the proposal.

## Known limitations of this note

- The reproduction query names the internal corpus table; the public equivalents are the
  Dune queries backing dashboard 215276. Publishing the query-by-query mapping and result
  checksums is part of the Milestone 2 refresh-note format.
- The watermark is six weeks old at proposal date (2026-08-19). The proposal cites it as a
  dated baseline, not as "current".
