# AGENTS.md

## Cursor Cloud specific instructions

### Repo layout / what is actually developable

This repo is a **public mirror**. Most top-level directories are published-artifact
mirrors, **not** buildable source:

- `twzrd-x402-gate/` — the primary package with real `src/` + `test/`. Gate
  development, linting, building, and testing happens here **after a root install**.
- `twzrd-log-verifier/` — real `src/` + `test/`. Gate typecheck imports this
  sibling; it is why a gate-only `npm ci` is not enough.
- `eliza-plugin-source/` — restored V7 Eliza plugin TypeScript (issue #90). Real
  `src/` + `test/`. Lint: `npm run typecheck --workspace=@wzrd_sol/eliza-plugin-source`.
  Test: `npm test --workspace=@wzrd_sol/eliza-plugin-source`. This is **not** the
  public artifact. `@wzrd_sol/eliza-plugin@0.7.0` is the live npm line. Pack with
  `npm run pack:eliza`. Publish via `.github/workflows/publish-eliza-plugin.yml`
  or an `eliza-plugin-v*` tag. Resync the mirror only from the live tarball:
  `node scripts/resync-eliza-plugin.mjs --version <live>`.
- `eliza-plugin/`, `plugin-trustgate/`, `twzrd-mcp-server/` — ship `dist/` only (no `src/`,
  no lockfile). Their `package.json` `test`/`build` scripts are no-ops in this
  mirror. Don't try to `npm install`/build them, and do not hand-edit `eliza-plugin/dist/`.
- `server/` — static docs + `.well-known` only. It cannot be built or run from this
  tree (`twzrd-agent-intel` is not published here).

### Install (read this before any command)

CI (`.github/workflows/ci.yml`) is the bootstrap: **root** `npm ci`, then
`npm run ci`. Node **20** in CI, `engines` `>=18`. Node 22+ works.

```bash
# from the repo root — the only supported install
npm ci
npm run build
npm run typecheck
npm test --workspace=twzrd-x402-gate
npm run gate-eval-refuse --workspace=twzrd-x402-gate
```

**Do not** `npm ci` inside `twzrd-x402-gate/`. Gate `tsconfig.check.json` typechecks
sibling `twzrd-log-verifier/src`, which needs `bs58`, `tweetnacl`, and `js-sha3`
from that workspace. Only the **root** `package-lock.json` installs them.
`twzrd-x402-gate/package-lock.json` is publish-only for that package on npm; it
is not a supported way to develop this checkout.

### twzrd-x402-gate (the one service)

It is an **ESM-only TypeScript library + CLI**, not a long-running server —
there is nothing to "serve". After the **root** install, run commands from
`twzrd-x402-gate/` or via `npm run <script> --workspace=twzrd-x402-gate`.

- Lint: there is **no separate lint script**. `npm run typecheck`
  (`tsc --noEmit -p tsconfig.check.json`, covers `src` + `test` + sibling
  verifier) is the lint/static-check.
- Build: `npm run build` (`tsc` → emits `dist/`, `src` only).
- Test: `npm test` — `tsx --test` over `test/*.test.ts` (self-contained; no
  external services).
- Hello-world (closes, 0 USDC): `npm run gate-eval-refuse` — buyer trust gate
  refuses a bad merchant before the wallet signs (`signer_invocation_count: 0`,
  `usdc_spent: 0`). `npm run x402-solana-before-payment-proof` is a **seat**
  proof; it can exit 2 when the live clean fixture is wash-flagged. Do not use
  it as the first demo.

### Non-obvious gotchas

- The `bin/` CLIs (e.g. `gate-eval-refuse`) load from `dist/`, so **`npm run build`
  must have run** first.
- `gate-eval-refuse` and several `examples/*` make **live network calls to
  `https://intel.twzrd.xyz`** (free preflight, no key/signup). They need outbound
  egress; they spend **no** USDC. If egress is blocked these demos fail even
  though unit tests pass.
- `x402-solana` is an optional peer. Consumers install
  `twzrd-x402-gate@0.9.7 x402-solana@3.0.0`. This checkout lists `x402-solana`
  as a gate **devDependency** so the seat is present after root `npm ci`. It is
  still not required to typecheck, build, or run `gate-eval-refuse`.
