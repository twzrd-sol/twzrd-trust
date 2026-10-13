# Supported path and Radio LAN release boundary

Date: 2026-10-13
Status: draft decision record for maintainer review. This document proposes the support policy; it does not change registry metadata, other repositories, production flags, or permissions.

## Supported path

The public reference is twzrd-sol/twzrd-trust. The default connector is the hosted Intel MCP at https://intel.twzrd.xyz/mcp. The primary developer path is twzrd-x402-gate plus twzrd-receipt-verifier.

The public reference is not the sole source repository for every component. Follow AGENTS.md for source-versus-artifact boundaries and upstream fork relationships.

| Surface | Proposed status | Public guidance | Accountable owner |
|---|---|---|---|
| twzrd-trust | Supported public reference | Canonical ecosystem description, installation guidance and reviewable client code | Zo |
| Hosted Intel MCP | Supported default connector | Start here for free hosted checks | Zo |
| twzrd-x402-gate | Supported developer path | Enforce policy on the actual pay path before signing | Zo |
| twzrd-receipt-verifier | Supported developer path | Verify supported receipts offline against the appropriate published key | Zo |
| twzrd-preflight | Supported OpenClaw adapter | Only payments through its wrapped fetch are covered; do not imply universal tool coverage | Zo |
| Local twzrd-mcp-server / twzrd-mcp | Secondary connector | Optional local client; paid calls require explicit enablement and spend limits | Zo |
| plugin-trustgate / eliza-plugin | Secondary framework adapters | Maintain their documented framework-specific scope; promotion requires artifact verification | Zo |
| @wzrd_sol/solana-agent-plugin | Deprecated for new integrations | Legacy attention/rewards path; direct new users to hosted Intel MCP or the gate | Zo |
| Old wzrd-mcp README and its onboarding path | Deprecated for new integrations | Historical attention/rewards documentation; point new users to twzrd-trust | Zo |
| Other packages and connectors | Unclassified pending inventory | No supported designation until maintainer review of published artifact and current API compatibility | Zo |

Zo is the accountable primary; implementation may be delegated through reviewed changes.

### Release acceptance

Before promoting a package or connector:

1. Record the package version, source commit, published artifact digest and verification date.
2. Run the installed published artifact through its documented flow. For the gate, prove refusal occurs before signing with zero signer invocations and zero spend; verify spend-cap behavior with deterministic tests.
3. Verify receipt interoperability where applicable and connector compatibility with the current hosted contract.
4. Make registry descriptions, READMEs, examples and discovery documents describe the same product and actual coverage.
5. Record the release owner and rollback or version-recovery procedure.

Read current versions from the release manifest or registry when verifying; this policy is not a version lock. Prefer live tool discovery over hardcoded MCP tool counts.

### Follow-up implementation

- Apply the deprecation notice to the old MCP README in its own repository.
- Apply npm deprecation metadata for @wzrd_sol/solana-agent-plugin through a human-authorized publishing workflow.
- Complete the remaining package/connector inventory.
- Record release verification receipts before marking these follow-ups complete.

This docs PR does not execute any of those changes.

## Radio LAN: controlled beta

Radio LAN remains a distinct product. The beta scope is discovery, sign-in, free seasons and points.

Hold promotion of backing and ICELAN claims until at least one real eligible user completes the production journey with evidence:

join → return/sign in → link wallet → review and approve claim → confirmed on-chain claim.

Retain a dated verification receipt with the released build, network, transaction signature and confirmation result. Account identifiers and identity-link evidence stay private; publish only consented, necessary evidence.

This is a promotion boundary, not an instruction to disable existing production features or transact from an agent session. Funding a vault or observing an enabled claim handler is not proof of a completed user payout.

The operator reports the legal pages are already live. Treat that release task as complete; do not claim an independent live check was performed in this docs PR.

## Review sources

- README.md and docs/ECOSYSTEM.md in this repository.
- AGENTS.md for source and artifact boundaries.
- twzrd-sol/wzrd-mcp README.md for the legacy path.
- twzrd-sol/ansem-radio-private README.md, apps/hub/README.md and docs/LEGAL_RELEASE_20261009.md for the beta boundary and historical evidence.
