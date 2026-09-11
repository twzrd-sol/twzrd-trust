# Eliza V7 readiness plan

Status: source migration needed

This note turns the remaining Eliza gap from issue #90 into an executable
migration map. It does not make `eliza-plugin/` buildable in this public mirror.
That package is still an artifact-only mirror unless source is intentionally
restored as part of a coordinated release.

## Current evidence

- `main` is aligned to the current trust release line after #89.
- `eliza-plugin/package.json` now depends on `twzrd-x402-gate` `^0.9.5`.
- `twzrd-mcp-server/package.json` now depends on `twzrd-receipt-verifier`
  `^1.4.0` and `twzrd-x402-gate` `^0.9.5`.
- `plugin-trustgate/` is synced to the published `0.3.6` runtime artifact.
- `eliza-plugin/` remains artifact-only and V6-oriented in its README and `dist/`.
- Historical source is recoverable from repo history:
  `git show 98e4b78:eliza-plugin/src/actions/intel-trust.ts`
  and the surrounding `eliza-plugin/src/` tree.
- The helper script `scripts/extract-eliza-source-baseline.mjs` can list or
  extract that historical baseline into a separate migration directory without
  changing `eliza-plugin/`.

## Source baseline

The earliest public release commit (`98e4b78`) contains TypeScript source and
tests for the Eliza plugin before the public mirror was stripped to artifacts:

- `src/actions/intel-trust.ts`
- `src/actions/verify-receipt.ts`
- `src/actions/intel-preflight.ts`
- `src/client.ts`
- `src/client-factory.ts`
- `src/paying-fetch.ts`
- `src/intel-helpers.ts`
- `src/index.ts`
- `test/plugin-registration.intel.ts`

That source is not automatically current. Later artifact-only releases added
surfaces such as `merchant-card`, so the migration should compare historical
source with the current `dist/` package before editing or publishing.

To extract the historical baseline for comparison:

```bash
node scripts/extract-eliza-source-baseline.mjs --target /tmp/eliza-plugin-source-baseline
```

## Required V7 work

1. Restore or obtain the actual upstream Eliza plugin source.

   The public mirror has enough historical source to identify the shape of the
   plugin, but a release should start from the real upstream source used to
   publish `@wzrd_sol/eliza-plugin@0.6.1`.

2. Update paid trust action semantics.

   `src/actions/intel-trust.ts` in the historical baseline describes paid
   receipts as `V5/V6` and reports `Receipt v${receipt.version}` without a V7
   policy distinction. The migrated action should name the current V7 receipt
   surface, preserve preflight-before-pay, and clearly label legacy V6 results
   if the service or SDK can still return them.

3. Update offline verification semantics.

   `src/actions/verify-receipt.ts` in the historical baseline verifies V5/V6.
   The V7 migration should route through the verifier or SDK surface that
   understands V7, surface signed freshness/provenance status, and keep V6
   downgrade wording consistent with `docs/receipt-v6-spec.md`.

4. Update Eliza registration tests.

   `test/plugin-registration.intel.ts` includes a V6 fixture and asserts that
   the action does not crash on the V6 path. The new test suite should include:

   - plugin registration under `@elizaos/core`
   - preflight-before-pay block with zero payment attempts
   - paid trust response carrying a V7 receipt
   - offline V7 verification callback and result shape
   - legacy V6 verification path with explicit downgraded freshness status

5. Publish and resync.

   After the source package passes its own tests, publish the next
   `@wzrd_sol/eliza-plugin` version, then resync `eliza-plugin/` in this mirror
   from the published artifact. Keep the no-op scripts here unless source is
   intentionally added to this public mirror.

## Do not do

- Do not hand-edit `eliza-plugin/dist/` and call it a source migration.
- Do not broaden package pins as a substitute for V7 receipt handling.
- Do not import implementation from `witness`, `outbid`, `trade`, `wzrd-final`,
  or other lanes.
- Do not make `server/` buildable as part of this work.

## Completion evidence

Eliza readiness is complete only when all of the following are true:

- the Eliza plugin source is available for review,
- V7 receipt handling is implemented in source,
- Eliza registration and V7 receipt tests pass from source,
- the npm package is published,
- this public mirror is resynced from that published package,
- artifact checks in this repository pass after the resync.
