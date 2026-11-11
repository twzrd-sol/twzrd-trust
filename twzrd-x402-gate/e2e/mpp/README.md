# MPP settlement harness

One pinned MPP charge to `intel.twzrd.xyz/v1/intel/quick`, plus the zero-spend check that
proves the client still parses today's challenge. Graduated here from an unversioned
local drafts directory, because a production settlement proof that
lives nowhere is one cleanup away from being unrepeatable.

## Why this is not a general client

`pay-quick-once.mjs` is deliberately narrow. It refuses unless:

- the key derives to the proof payer `64NsKhbNGZCEj6sgTtjzscfuXSZSEpD1GoBXbT45yv4J`
  (skipped only under `LOOPBACK`, where nothing can settle);
- the challenge is exactly `1000` base units of USDC to
  `GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs` on Solana `mainnet`, `solana`/`charge`;
- no second challenge arrives — `maxPaymentRetries: 1` and an `approved` guard that throws.

It prints public values only. It never retries. It does **not** cap the sponsor's fee: the
seller enforces that (`mpp.py`: compute-unit limit 200,000 and price 10,000 microlamports,
i.e. ~12,000 lamports per payment, measured 10,001 on 2026-11-11).

## Zero-spend check

```bash
npm ci
node loopback-check.mjs <throwaway-key.json>    # expect: credentials received 1; scheme Payment
```

It fetches intel's live unpaid 402 once (user-agent `twzrd-mpp-settle-test/1`), so funnel
telemetry shows one unpaid hit per run. The signed credential goes only to a local loopback
server. Use a key that holds nothing, and delete it afterwards.

`package-lock.json` is the dependency tree that produced both settlements (viem 2.57.11).
Install with `npm ci`. A fresh `npm install` fails with ERESOLVE: viem 2.57.18 and later
declare an optional peer `mppx >= 0.17.0`, which conflicts with the `mppx` 0.15.0 pin.

## Paid run

```bash
node pay-quick-once.mjs <payer-key.json>
```

Requires an explicit operator authorization naming the payer, the endpoint, the recipient,
the network, the amount, and one payment with no retry. Expected proof path: `status 200`,
a `payment-receipt` header, then the receipt JSON.

## Settlements this harness produced

| Date | Tx | Amount | Notes |
|---|---|---|---|
| 2026-10-26 | `3hTBcnhmamkoJFscXeXDCtQ7iwMDivqpARio1h7Bedb9k8tdcuiN94TaLx3bsnkMVizJ8WUe81Y8fkPgWeSeEo96` | 0.001 USDC | first MPP settlement; house payer `64NsKhbN…`; `payer_is_external f` |
| 2026-11-11 | `59S5ZzMoWHianPVF1yeqzeijvNjoHUedXdsKbGzFfunbrkQgtnuiadKhSuCGM7A7KEViDZykVwWyLPR2mNkXTy5q` | 0.001 USDC | regression proof on the current seller; slot 468219877; fee 10,001 lamports, sponsor-paid |

Both are internal-payer settlements. **External MPP settlement remains unproven.**

## Pins

`mppx@0.15.0`, `@solana/mpp@0.7.0`, `@solana/kit@6.10.0` — exact versions, because the point
of a regression proof is comparability. Do not let a range float them. `mppx` 0.15.0 depends
on `viem >=2.57.1`, so only the lockfile holds viem at 2.57.11; do not regenerate it with
`--legacy-peer-deps` to get past the ERESOLVE above. If these pins stop resolving, that is a
finding, not a maintenance chore.
