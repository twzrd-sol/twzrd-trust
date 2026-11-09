# Repository map

One page for humans and for agents: every top-level path in this repository,
what it is, who may edit it, and what breaks if it moves. The document index
is [docs/README.md](./README.md); this file is about the **folders**.

If this map disagrees with the tree, the tree is a bug in the map: open an
issue. Re-read on **2026-11-09**; versions are as the root README's table
reads on that date.

## What this repository is

The public source for TWZRD: hosted checks behind `https://intel.twzrd.xyz`,
the npm packages, and the receipt and record formats. The private upstream
monorepo keeps its own copy of the gate; this repo is an intentional fork in
places — see [AGENTS.md](../AGENTS.md) for the fork relationship and the one
supported install.

There are **two buildable products here**; everything else is a published
artifact mirrored in or meta-infrastructure:

- **`twzrd-x402-gate`** — the buyer-side gate (npm `twzrd-x402-gate`). Source here.
- **`agent-killswitch`** — the local spend proxy (npm `@twzrd1111/agent-killswitch`, `ghcr.io/twzrd-sol/agent-killswitch`). Source here.

## Top-level paths

### Source — edit these

| Path | What it is | Published by |
|---|---|---|
| `twzrd-x402-gate/` | Library + CLIs; the one package with source here. `npm run build` / root `npm run ci` covers it (with `twzrd-log-verifier` for the sibling typecheck). | `.github/workflows/publish.yml` |
| `agent-killswitch/` | Local OpenAI-compatible spend proxy: ceilings, kill file, JSONL ledger. Its own `package-lock.json`; `npm run test:agent-killswitch` from the root. | `.github/workflows/publish-agent-killswitch.yml` (refuses an undated CHANGELOG) + `agent-killswitch-image.yml` (GHCR) |
| `twzrd-log-verifier/` | Offline transparency-log verifier (npm `twzrd-log-verifier`). | `.github/workflows/publish-log-verifier.yml` |
| `eliza-plugin-source/` | TypeScript source the Eliza plugin is published from (`@wzrd_sol/eliza-plugin`). Not the artifact; its `README.publish.md` is the tarball README. | `.github/workflows/publish-eliza-plugin.yml` |
| `counsel_orchestration/` + `.grok/agents/` | Deterministic seven-role fail-closed counsel fold (Python + role briefs). CI runs `python3 -m unittest counsel_orchestration.test_decide`. Not published. | not published |
| `scripts/` | Publish pack/resync, mirror checkers, audit and proof tooling for the gate and the plugins. Tests sit beside the scripts (`node --test`). | the workflows and root `npm run ci` |

### Published-artifact mirrors — never edit; resync only from live

| Path | Mirrors | Resync |
|---|---|---|
| `eliza-plugin/` | `@wzrd_sol/eliza-plugin@0.10.1` (dist only) | `npm run resync:eliza` from the live tarball |
| `plugin-trustgate/` | `@wzrd_sol/plugin-trustgate@0.3.10` (dist only) | resync from live tarball |
| `twzrd-mcp-server/` | `twzrd-mcp-server@0.6.2` (dist only) | resync from live tarball |
| `server/` | The hosted site's public static files: `llms.txt`, `.well-known/`, `agent-card.md` | `.github/workflows/intel-mirror-sync.yml` |
| `SKILL.md` | Byte copy of `https://intel.twzrd.xyz/skill.md`. Root copy **and** `skills/twzrd-trust/SKILL.md` must stay byte-identical; `scripts/check-plugin-layout.test.mjs` asserts it. | re-sync from live |

### Docs, meta, and manifests

| Path | What it is | Rule |
|---|---|---|
| `README.md`, `QUICKSTART.md`, `REVIEW.md`, `MILESTONE.md` | Canonical front-door documents | Edit here; keep the version table truthful |
| `SECURITY.md`, `LICENSE` | Disclosure policy / MIT text | Keep `SECURITY.md` at root (GitHub's Security tab finds it there) |
| `AGENTS.md` | The build doctrine for agents entering this checkout | Edit carefully; canonical |
| `docs/` | Canonical doc index ([docs/README.md](./README.md)), specs, proofs, `archive/` (historical), `internal/` (maintainer-only) | New docs get an index entry |
| `glama.json`, `plugin.json`, `mcp.json` | Registry listing manifests (Glama, agent-plugins, MCP client config) | Edit only with an intentional listing change |
| `.github/workflows/` | CI (`ci.yml`) plus the publish and mirror-sync workflows | Publish-workflow edits need review; a changed expected_commit on publish is a separate order |

## Invariants (things that must not be done)

1. Do not `npm ci` inside `twzrd-x402-gate/` alone; the root install wires the
   sibling dependencies the gate's `typecheck` reads.
2. Do not edit anything under a mirror directory; do not hand-edit `dist/`; do
   not "fix" a mirror to match source — resync carries the truth.
3. Do not move or rename a top-level path without sweeping, in one change:
   `.github/workflows/**`, root `package.json` scripts and workspaces, every
   link in `README.md` and `docs/`, the manifests, and any test that pins a
   path (`check-plugin-layout.test.mjs`, `render-ecosystem.mjs --check`,
   `check-gate-release-drift.test.mjs`).
4. No new top-level directory without an entry here and in
   [docs/README.md](./README.md).
5. Mirrors stay mirrors. The only two products with buildable source are
   `twzrd-x402-gate` and `agent-killswitch`; the verifier
   (`twzrd-log-verifier`) is source too, small by design.
6. Registry listings (npm, GHCR, Glama, MCP registries, ClawHub) are changed
   by publish workflows under typed orders, never as a docs edit.

## Not in this repository

The upstream monorepo (`wzrd-final`), the hosted server package
(`twzrd-agent-intel`), and `x402-solana` (npm peer). See `AGENTS.md`.

## For the next reorganizer

If a folder here stops earning its place, the move is a dedicated docs PR
with the full sweep from invariant 3, not a silent `git mv`. Candidates seen
on 2026-11-09 and deliberately **not** moved: `counsel_orchestration/` +
`.grok/agents/` (CI-tested, small, want a home and an owner decision, not a
quiet drop), `docs/archive/` (historical; keep), the front-page rewrite
(tracked as the later pass for the root README, not this map).
