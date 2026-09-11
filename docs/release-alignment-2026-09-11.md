# Release alignment audit — 2026-09-11

This note records the public-mirror alignment check across `twzrd-trust`, the
published ElizaOS packages, and the sibling `witness` and `outbid` repositories.
It is an audit of release surfaces, not a claim that the sibling repositories
share one implementation or release train.

## Current active surfaces

| Surface | Observed current state | Assessment |
|---|---|---|
| `twzrd-x402-gate` | `0.9.5`; the active `main` docs pin `x402-solana@3.0.0` and verifier `^1.4.0` | Current for this release line |
| `twzrd-receipt-verifier` | npm latest `1.4.0` | Current floor is `^1.4.0` |
| `@elizaos/core` | npm stable `1.7.2`; root lock resolves `1.7.2` | Current stable line; package ranges remain broad (`^1.0.0`) |
| `@wzrd_sol/eliza-plugin` | npm latest `0.6.1`, published 2026-07-23 | Artifact is old relative to the V7 service docs and still describes V6 receipts |
| `@wzrd_sol/plugin-trustgate` | npm latest `0.3.6`, published 2026-09-09 | Mirror was stale at `0.3.4`; runtime artifact has been synced on this branch |
| `twzrd-mcp-server` | repository package `0.5.2` | Its active gate/verifier pins are updated on this branch |

## Sibling protocol assumptions

`witness` `master` and `outbid` `main` both use x402 `2.23.0` across their
core/fetch/SVM packages. The gate workspace retains its tested `2.22.0`
development surface, while the MCP workspace resolves `2.24.0` through its
broader `^2.17.0` declarations. This is a compatibility-matrix difference;
it is not evidence that unfinished sibling branches should be merged into this
public mirror.

The behavioral boundary is coherent: Witness retrieves and signs observations,
Outbid exposes paid/read-only board and reader rails, and TWZRD evaluates a
counterparty before a payer signs. Witness explicitly uses `reader.outbid.sh`
and the Outbid skill recommends TWZRD as an optional preflight. No source import
or shared package dependency is required by either sibling repository.

## Changes made on this branch

- `eliza-plugin/package.json`: `twzrd-x402-gate` `^0.9.4` → `^0.9.5`.
- `twzrd-mcp-server/package.json`: gate `^0.9.4` → `^0.9.5`; verifier
  `^1.3.0` → `^1.4.0`.
- `plugin-trustgate`: version/lock metadata `0.3.4` → `0.3.6`, plus the
  published classifier fix preventing `mainnet-beta` from skipping facilitator
  or Faremeter trust gating.

The mirror intentionally retains no-op scripts in artifact-only packages:
their published source/tests are not present in this repository and must not be
made to appear buildable here.

## Remaining release boundary

The Eliza plugin's `dist/` and npm package are V6-oriented, while the current
TWZRD service documentation advertises V7 receipts. This cannot be safely
resolved by changing a dependency pin: the public mirror has no plugin source,
and the published Eliza plugin has no newer release. A proper resolution needs
the upstream source, V7-compatible SDK/API changes, receipt tests, and a
coordinated npm publish followed by artifact re-sync.

Historical proposal documents retain older pins by design and are excluded from
the active release check.

## Verification

On this branch:

- `npm run typecheck --workspace=twzrd-x402-gate` passes.
- `npm test` passes: 62 gate tests, 100 log-verifier tests, and artifact checks.
- `npm run test:artifacts` passes.
- The synced network classifier recognizes `mainnet-beta`, `mainnet`, CAIP-2
  Solana, and devnet, and rejects Base.
