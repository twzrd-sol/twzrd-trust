# AGENTS.md

## Cursor Cloud specific instructions

### Repo layout / what is actually developable

This repo is a **public mirror**. Most top-level directories are published-artifact
mirrors, **not** buildable source:

- `twzrd-x402-gate/` — the **only** package with real `src/` + `test/`. All development,
  linting, building, and testing happens here.
- `eliza-plugin/`, `plugin-trustgate/`, `twzrd-mcp-server/` — ship `dist/` only (no `src/`,
  no lockfile). Their `package.json` `test`/`build` scripts reference files that are not in
  this mirror, so they are not buildable/testable here. Don't try to `npm install`/build them.
- `server/` — static docs + `.well-known` only. Its `Dockerfile` installs a private Python
  package (`twzrd-agent-intel`) that is **not** in this repo, so it cannot be built/run here.

### twzrd-x402-gate (the one service)

Node 22 / npm 10 (package `engines` requires node >=18). Package manager is **npm**
(`package-lock.json`). It is an **ESM-only TypeScript library + CLI**, not a long-running
server — there is nothing to "serve"; you run it via tests, example scripts, or its `bin/`
CLIs. All commands run from `twzrd-x402-gate/`.

- Lint: there is **no separate lint script**. `npm run typecheck`
  (`tsc --noEmit -p tsconfig.check.json`, covers `src` + `test`) is the lint/static-check.
- Build: `npm run build` (`tsc` → emits `dist/`, `src` only).
- Test: `npm test` — runs ~40 `tsx` test files sequentially; the run stops at the first
  failing file. Tests are self-contained (no external services needed).
- Run / demo (core "hello world"): `npm run gate-eval-refuse` runs the buyer trust gate
  end-to-end and proves it refuses payment to a bad merchant before the wallet signs
  (`signer_invocation_count: 0`, `usdc_spent: 0`). Other example scripts live under
  `examples/` and in the `scripts` block of `package.json`.

### Non-obvious gotchas

- The `bin/` CLIs (e.g. `gate-eval-refuse`) load from `dist/`, so **`npm run build` must
  have run** before invoking them (the update script installs deps but does not build; run
  `npm run build` first if `dist/` is stale or missing).
- `gate-eval-refuse` and several `examples/*` make **live network calls to
  `https://intel.twzrd.xyz`** (free preflight, no key/signup). They need outbound egress;
  they spend **no** USDC. If egress is blocked these demos fail even though unit tests pass.
- The x402/Solana peer deps are declared as optional `peerDependencies` but are present as
  `devDependencies`, so a plain `npm ci` in `twzrd-x402-gate/` is enough to build and test.
