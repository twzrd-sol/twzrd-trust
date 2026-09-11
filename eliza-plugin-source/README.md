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
| This repo publish workflow | Publishes `twzrd-x402-gate` only. There is no Eliza publish/resync workflow here. |

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

## Test (source, not mirrored dist)

```bash
cd eliza-plugin-source
npm test
npm run typecheck
```

`npm test` covers Eliza registration under `@elizaos/core`, preflight-before-pay
with zero payment attempts, a paid-trust V7 fixture, official V7 example
verification, and the legacy V6 downgrade label.

## Publish and public-mirror resync (not done in this directory)

After merge, the remaining #90 acceptance items are:

1. Publish the next `@wzrd_sol/eliza-plugin` version from this source (rename
   `package.json` `name` to `@wzrd_sol/eliza-plugin`, un-private, build, npm
   publish). This repo's `.github/workflows/publish.yml` does not publish Eliza;
   historical publishes came from `wzrd-final`.
2. Resync `eliza-plugin/` from that published tarball (`dist/`, `package.json`,
   `README.md` only). Keep artifact-only no-op scripts unless source is
   intentionally moved into the public mirror.

Do not hand-edit `eliza-plugin/dist/` as a substitute for that release path.
