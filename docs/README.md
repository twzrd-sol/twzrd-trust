# Document index

Every Markdown document in this repository, what it is for, and whether it is
**canonical** (describes the product as it is), **historical** (a dated record,
kept as written) or **internal** (maintainer notes, not integrator guidance).
Versions and live-surface facts were verified on **2026-10-24**; the
[README](../README.md#versions-verified-2026-10-24) carries the version table.

A canonical document that disagrees with the code is a bug: open an issue. A
historical document is not updated when the product moves; its banner says
where the current state lives.

## Start here

| Document | Status | What it is |
|---|---|---|
| [README.md](../README.md) | canonical | What TWZRD is, what is live, how to start, verified versions, the generated ecosystem block |
| [QUICKSTART.md](../QUICKSTART.md) | canonical | Guard a paying fetch in a few commands; lower-level APIs behind a fold |
| [twzrd-x402-gate/QUICKSTART.md](../twzrd-x402-gate/QUICKSTART.md) | canonical | The runnable buyer-wrapper quickstart (offline blocked payment, real x402 client) |
| [twzrd-x402-gate/README.md](../twzrd-x402-gate/README.md) | canonical | Package reference: entry points, defaults by entry point, networks, refusal codes, config. Several sections are asserted by tests |
| [twzrd-x402-gate/CHANGELOG.md](../twzrd-x402-gate/CHANGELOG.md) | canonical | Release history and the versioning policy (a change to allow/refuse ships in a minor) |
| [twzrd-x402-gate/COMPATIBILITY.md](../twzrd-x402-gate/COMPATIBILITY.md) | canonical | Registry state, dist-tags, and the behavioural changes between releases, newest first |
| [AGENTS.md](../AGENTS.md) | canonical | What is source and what is a published-artifact mirror; the one supported install; the fork relationship with the upstream monorepo |
| [SECURITY.md](../SECURITY.md) | canonical | Disclosure policy and scope |

## Product and ecosystem

| Document | Status | What it is |
|---|---|---|
| [ECOSYSTEM.md](./ECOSYSTEM.md) | canonical | Every piece, alone and plugged in; the generated block shared with the README and other repositories (`ecosystem.json` is the source) |
| [COMMERCE-KIT.md](./COMMERCE-KIT.md) | canonical | The six-step commerce loop: directory, preflight, policy, pay or refuse, verify, evidence bundle |
| [BUYER-FETCH.md](./BUYER-FETCH.md) | canonical | Contract and verification record of `createBuyerFetch` |
| [taxonomy.md](./taxonomy.md) | canonical | Terms: ReadinessCard, quickCheck, AutoGate, bind-v1, Path A, merchant card |
| [consumer-adjacency.md](./consumer-adjacency.md) | canonical | When an agent sees both card rails and Solana x402: one routing rule, three evidence objects |
| [facilitator-trust-in-3-lines.md](./facilitator-trust-in-3-lines.md) | canonical | The `@wzrd_sol/plugin-trustgate` settle hook for self-hosted facilitators |
| [apn-compatibility-packet.md](./apn-compatibility-packet.md) | canonical | Where the gate sits in Agent Payment Node's inspect, prepare, approve flow; table asserted by a test |
| [glama-listing.md](./glama-listing.md) | canonical | Directory listing copy: zero-setup proof, sample responses, install options, outage behaviour |
| [SUPPORT_MATRIX.md](./SUPPORT_MATRIX.md) | canonical | Which surfaces are supported, secondary or deprecated, and who is accountable |
| [ACCESS_AND_RECOVERY.md](./ACCESS_AND_RECOVERY.md) | canonical | Accountability register for repositories, registries, hosting and DNS; no credentials |
| [MILESTONE.md](../MILESTONE.md) | canonical | The seven-day external integration milestone and how it would be proven; not yet attempted |
| [server/agent-card.md](../server/agent-card.md) | canonical | Human-readable agent card for the hosted MCP |
| [SKILL.md](../SKILL.md) | canonical mirror | Byte copy of the live `https://intel.twzrd.xyz/skill.md`; re-synced from live, never edited here (the listing-key fingerprint in the README is the independent pin) |

## Specifications and review

| Document | Status | What it is |
|---|---|---|
| [REVIEW.md](../REVIEW.md) | canonical | External review map for bind-v1 with three mainnet transactions to recompute |
| [receipt-v6-spec.md](./receipt-v6-spec.md) | canonical | AO-Receipt V6 layout and the V7 migration (V7 is what is issued today; V5 and V6 still verify) |
| [payment-decision-v1-spec.md](./payment-decision-v1-spec.md) | canonical, frozen | `twzrd.payment_decision.v1`: the portable decision record the gate signs with your own key |
| [resource-bind-v2-spec.md](./resource-bind-v2-spec.md) | canonical, client only | `rb2:` folds the decision id into the bound leaf; `rb1:` is frozen |
| [transparency-log.md](./transparency-log.md) | canonical, v0.2 draft over a live v0.1 log | Receipt transparency log: what is live (signed heads, inclusion and consistency proofs, on-chain anchors as the tree advances) and what v0.2 adds (key directory) |
| [security-assurance.md](./security-assurance.md) | canonical | Security properties, the reproducible receipt proof, trust boundaries and non-claims |
| [twzrd-log-verifier/README.md](../twzrd-log-verifier/README.md) | canonical | Offline verifier for the transparency log; source here, not on npm. Its anchor check reads the live program form and the draft memo form |

## Package mirrors

These READMEs are copies of the published tarball and are re-synced, never edited here.

| Document | Status | Mirrors |
|---|---|---|
| [twzrd-mcp-server/README.md](../twzrd-mcp-server/README.md) | canonical mirror | `twzrd-mcp-server@0.6.0` on npm (identical on 2026-10-24) |
| [eliza-plugin/README.md](../eliza-plugin/README.md) | canonical mirror | `@wzrd_sol/eliza-plugin@0.8.1` on npm (identical on 2026-10-24) |
| [plugin-trustgate/README.md](../plugin-trustgate/README.md) | canonical mirror | `@wzrd_sol/plugin-trustgate`; the tree holds 0.3.9 while npm is 0.3.10, resync pending |
| [eliza-plugin-source/README.md](../eliza-plugin-source/README.md) | canonical | The TypeScript source the Eliza plugin is published from; `README.publish.md` beside it is the README packed into the tarball |

## Historical records

Dated. Kept as written, with a banner pointing to the current state.

| Document | Date | What it recorded |
|---|---|---|
| [proofs/seller-graph-payguard-closeout-2026-07-12.md](./proofs/seller-graph-payguard-closeout-2026-07-12.md) | 2026-07-12 | Discovery, merchant card and pre-sign block on package 0.5.4 |
| [proofs/20260716-wash-refuse-transcript.md](./proofs/20260716-wash-refuse-transcript.md) | 2026-07-16 | Superseded refuse transcript on 0.7.1 |
| [proofs/20260819-refuse-and-clean-control-0.8.18.md](./proofs/20260819-refuse-and-clean-control-0.8.18.md) | 2026-08-19 | Block plus clean-control pair on the published 0.8.18, TWZRD-operated |
| [proposals/corpus-note-2026-07-09.md](./proposals/corpus-note-2026-07-09.md), [2026-08-16](./proposals/corpus-note-2026-08-16.md), [2026-08-18](./proposals/corpus-note-2026-08-18.md) | July to August 2026 | Settlement-corpus snapshots of their dates |
| [proposals/solana-x402-trust-tooling.md](./proposals/solana-x402-trust-tooling.md), [solana-foundation-application-fields.md](./proposals/solana-foundation-application-fields.md) | 2026-08-19 | A public funding proposal as written then; not maintained |
| [proposals/settle-gate-enforce-activation-2026-08-19.md](./proposals/settle-gate-enforce-activation-2026-08-19.md) | 2026-08-19 | The hosted settle gate moving from shadow to enforce (still enforcing) |
| [release-alignment-2026-09-11.md](./release-alignment-2026-09-11.md) | 2026-09-11 | Mirror-alignment audit at the 0.9.5 release line |
| [eliza-v7-readiness-plan.md](./eliza-v7-readiness-plan.md) | 2026-09 to 2026-10 | The Eliza V7 migration plan; completed with 0.8.x |

## Internal

| Document | Status | What it is |
|---|---|---|
| [internal/discovery-planning.md](./internal/discovery-planning.md) | internal | Distribution channels and success criteria for maintainers |
| [strategy/gate-adoption-operator-proof.md](./strategy/gate-adoption-operator-proof.md) | canonical, operator-facing | Acceptance contract for the no-spend adoption-proof harness and evidence bundle |

## Keeping this index true

- Add a row when a document is added; move a row to Historical, with a banner in the file, when it stops describing the product.
- Mirrors (`SKILL.md`, `server/llms.txt`, `server/.well-known/mcp.json`, the package READMEs) are replaced from their source, never edited.
- `npm test` asserts the current install pin across the named documents, the pay-path contract and refusal tables in the gate README, and the generated ecosystem block. A refresh that breaks one of those tests has changed a documented contract; fix the test and the text together.
