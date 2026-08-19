# Corpus Note — Solana x402 Settlement Corpus, refresh of 2026-08-18

Supporting note for the corpus values cited in
[`solana-x402-trust-tooling.md`](./solana-x402-trust-tooling.md). Written 2026-08-19.
Current cited baseline. Prior dated refreshes:
[`corpus-note-2026-08-16.md`](./corpus-note-2026-08-16.md),
[`corpus-note-2026-07-09.md`](./corpus-note-2026-07-09.md).

## Definitions

Same as the 2026-08-16 note, with the construction made explicit:

| Term | Definition |
|---|---|
| Payment | One observed Solana USDC transfer (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) whose fee payer (first signer) is a **known facilitator** on the published allow-list. There is no x402 program; this shape is the definition. Payer = source token-account owner; merchant = dest token-account owner. |
| Coverage | Vintage of the **known-facilitator classic-USDC index**, not the entire Solana x402 universe. Self-facilitated, unknown-sponsor, never-seen-merchant, and non-USDC legs are out of this table. |

Coverage watermark: **2026-08-18 UTC** — known-facilitator classic USDC, watermarked. Completeness here means “no missing complete-day inside the allow-list,” not “every x402 settle on Solana.”

## Snapshot values (Dune refresh, 2026-08-18)

Published dashboard: <https://dune.com/twzrd_analyst/twzrd-x402-on-solana-official>
(Dune dashboard 215276). Freshness query 7913460, execution `01M0CPK69Y83EKFMYJ6AJF0RAW`
on 2026-08-19, reports:

- `kpi_vintage_day` = 2026-08-18
- `corpus_last_payment` = 2026-08-18 23:59:45+00
- `corpus_freshness` = FRESH
- `corpus_payments` = 2,707,821
- `corpus_usdc_volume` = 707,196.61

These match the VPS upload `dataset_twzrd_x402_kpis` built 2026-08-19T00:26:09Z
(`complete_day=2026-08-18`).

| Metric | Value | Basis |
|---|---|---|
| Observed payments | 2,707,821 | raw |
| Payers | 106,220 | raw |
| Merchants | 16,015 | raw |
| Labeled facilitators | 17 | raw |
| Settled USDC | $707,197 | raw (707,196.61 rounded) |
| Median payment | $0.02 | raw |
| Scrubbed demand base | 105,768 payers | scrubbed (`scrubbed_payer_base` on 7913460) |
| One-and-done payers | 39% | scrubbed |
| Trusted-recurring payers | 4,874 (4.61%) | scrubbed; ≥5 payments across ≥2 merchants |

Arithmetic check: 4,874 / 105,768 = 4.608% (cited as 4.61%). Payers excluded from the
scrubbed base: 106,220 − 105,768 = 452, or 0.43% of raw — the same exclusion *count*
and rate as the 2026-08-16 refresh (452 / 106,200 = 0.43%).

## Reproduction query

```sql
SELECT count(*)                                        AS payments,
       count(DISTINCT payer)                           AS payers,
       count(DISTINCT merchant)                        AS merchants,
       round((sum(usdc_amount_micro) / 1e6)::numeric)  AS settled_usdc,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY usdc_amount_micro) / 1e6)::numeric, 3) AS median_usdc
FROM x402_solana_events
WHERE block_time <= '2026-08-18 23:59:59+00';
```

Local Postgres on 2026-08-19, scoped to the 2026-08-16 watermark, reproduced the
prior note exactly (2,665,308 / 106,200 / 16,011 / 666,794). The 2026-08-18
headline figures are taken from the published Dune KPI upload, not a second
independent SQL run of the scrub pipeline.

## Change since the 2026-08-16 refresh

| Metric | 2026-08-16 | 2026-08-18 | Change |
|---|---:|---:|---:|
| Payments | 2,665,308 | 2,707,821 | +1.6% |
| Payers (raw) | 106,200 | 106,220 | +20 |
| Merchants | 16,011 | 16,015 | +4 |
| Settled USDC | $666,794 | $707,197 | +$40,403 |
| Trusted-recurring | 4,867 (4.6%) | 4,874 (4.61%) | +7 |
| Scrubbed demand base | 105,748 | 105,768 | +20 |

This is a two-complete-day increment after the daily upload, not a structural break.
The 2026-07-09 → 2026-08-16 jump (payments +61.6% on payers +2.9%) remains the
concentration observation; it is documented on the 2026-08-16 note and is unchanged
by these two days.

## Basis discipline

The raw and scrubbed bases must not be interchanged. These are ecosystem observations,
not TWZRD customer counts.
