# Eliza plugin source (V7 migration)

This directory is the restored, V7-migrated TypeScript source for
`@wzrd_sol/eliza-plugin`. It is **not** the public artifact mirror.

- `eliza-plugin/` stays artifact-only (`dist/`, no-op scripts) until a
  coordinated npm publish and resync.
- This package is private as `@wzrd_sol/eliza-plugin-source` so it does not
  collide with the mirrored workspace name.

## What was restored

Historical TypeScript came from this repo at
`98e4b78779980c4b5b9581b78dfe292eda82aad5` (extractor:
`scripts/extract-eliza-source-baseline.mjs`). The 0.6.1 artifact added
`WZRD_MERCHANT_CARD`; that action is forward-ported here from the mirrored
`eliza-plugin/dist/actions/merchant-card.js`, not from another lane.

Investigation (do not import from these):

| Location | Finding |
|---|---|
| `twzrd-sol/eliza-plugin` (private) | Earn-loop v0.2.0 from March 2026. Not the 0.6.1 intel plugin. |
| `twzrd-sol/wzrd-velocity` `agents/eliza-plugin` | Historical home in the 0.3.0 baseline `package.json`. No longer hosts the intel plugin. |
| `twzrd-sol/wzrd-final` `agents/eliza-plugin` | Still `@wzrd_sol/eliza-plugin@0.6.1` / V6. Readiness plan forbids importing that lane. |
| npm `@wzrd_sol/eliza-plugin@0.6.1` | Published 2026-07-23. Public `eliza-plugin/` is the artifact resync of that tarball. |
| This repo publish workflow | Gate publish plus `.github/workflows/publish-eliza-plugin.yml` / `eliza-plugin-v*` tags. Pack with `npm run pack:eliza`. Resync the artifact mirror from the live tarball: `node scripts/resync-eliza-plugin.mjs --version <live>`. |

## V7 vs legacy V6

Paid trust (`WZRD_INTEL_TRUST`) names the current V7 receipt surface. Offline
verify (`WZRD_VERIFY_RECEIPT`) uses `twzrd-receipt-verifier@^1.4.0`.

| Version | Freshness status | Notes |
|---|---|---|
| **V7** (current) | `signed` | `recheck_after_unix`, `staleness_days`, `score_decay_model` are leaf-bound. |
| **V6** (legacy) | `derived_from_timestamp` | Those three fields are advisory. Enforce `max_age_seconds` against signed `timestamp_unix`. See `docs/receipt-v6-spec.md`. |
| **V5** (legacy) | `unauthenticated` | Provenance and freshness are unsigned. |

`@wzrd_sol/sdk@0.4.8` still implements only V5/V6 leaf bindings and defaults to
the v1 signing key. This source keeps the SDK for free preflight, merchant_card,
and paid `fetchIntelTrust`, and routes verification through the verifier.

Classification uses the verifier domain allowlist only
(`TWZRD:AO_REPUTATION_RECEIPT_V{5,6,7}` and attention V5/V6). Envelope
`version` / `kind` cannot promote a V6 body to `freshness=signed`. That label
is set only after `twzrd-receipt-verifier` returns `valid === true` **and**
`freshness_unauthenticated === false` on a V7 domain. A missing
`freshness_unauthenticated` flag is treated as unauthenticated.

`TRUSTED_RECEIPT_PUBKEY` remains the SDK v1 re-export for compatibility. Pin
`CURRENT_RECEIPT_PUBKEY` (v2) when calling `verifyReceipt`. Do not pass the v1
key or live V7 receipts will fail closed.

## `verifyReceipt` vs published 0.6.1

Source `verifyReceipt` and `getIntelClient().verify` are **synchronous**. They
do not accept `fetchPubkey` / `apiBase` (0.6.1 delegated those to the SDK) and
they return `receiptVersion` + `freshness` instead of SDK `leafVersion`. Paid
trust runs this verifier on the returned receipt before labeling freshness.

## Test (source, not mirrored dist)

```bash
cd eliza-plugin-source
npm test
npm run typecheck
```

`npm test` covers Eliza registration under `@elizaos/core`, preflight-before-pay
with zero payment attempts, a paid-trust V7 fixture, official V7 example
verification, and the legacy V6 downgrade label.

## Publish and public-mirror resync

Do not rename this workspace package to `@wzrd_sol/eliza-plugin` (it would
collide with the artifact mirror). Pack and publish through the scripts:

```bash
node scripts/pack-eliza-plugin.mjs
node scripts/assert-eliza-publish-pack.mjs
```

Human-gated release: Actions → **Publish @wzrd_sol/eliza-plugin to npm**
(`.github/workflows/publish-eliza-plugin.yml`) with `expected_version` matching
this `package.json` (currently `0.7.0`). That workflow must exist on `main`
before it can be dispatched. Until this branch merges, pass `source_ref` as
the branch that contains `eliza-plugin-source/`.

After the version is live on npm:

```bash
node scripts/resync-eliza-plugin.mjs --version 0.7.0
```

That overwrites `eliza-plugin/` from the **published** tarball only. Do not
hand-edit `eliza-plugin/dist/` as a substitute.
