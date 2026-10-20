# Access and recovery responsibility register

Date: 2026-10-13
Status: adopted policy and responsibility register (merged in #195). The completion evidence below remains pending verification.

This public document names accountable roles and required evidence. It is not an inventory of credentials, recovery-code locations, account IDs, private hosts or infrastructure configuration.

## Ownership

Zo is the accountable human primary across the surfaces below. A second human backup has not yet been designated.

Sealed recovery codes and a written recovery runbook are the interim recovery requirement, not a substitute for a second operator. Their existence, storage and usability have not yet been verified. Keep the actual material and sensitive recovery instructions outside this public repository.

No agent is assigned independent publish or DNS authority. Any agent-assisted release or administrative action must operate within explicit human authorization. This document does not verify or change existing credentials or permissions.

| Surface | Human primary | Human backup | Recovery evidence required |
|---|---|---|---|
| GitHub repositories and release controls | Zo | Unassigned | Account recovery, ownership/access review and documented release procedure |
| npm and other package registries | Zo | Unassigned | Account recovery, publisher inventory and documented publish/version-recovery procedure |
| Hosted Intel MCP and API | Zo | Unassigned | Deployment runbook, fresh external health evidence and known rollback |
| Cloudflare DNS and tunnels | Zo | Unassigned | Account recovery and private hostname/tunnel ownership map |
| Production host operations | Zo | Unassigned | Private host recovery runbook, backup/restore evidence and fresh status evidence |
| Product logins and identity providers | Zo | Unassigned | Admin recovery, provider ownership and documented account/session recovery |
| Secret management | Zo | Unassigned | Account recovery and private access inventory; no secrets in git |

The assigned primary role is an accountability decision, not proof of current provider permissions or ownership.

## Operating boundary

- Check both public edge and origin before diagnosing an outage. A healthy origin alone does not establish public availability.
- Production releases require a fresh status check, a verified artifact and a retained rollback.
- Recovery and access changes are human-attended. Avoid incidental credential rotation or session-secret changes during unrelated debugging.
- Keep account recovery codes, tokens, keys, secret-manager paths and detailed private topology out of this repository and PR discussion.

## Completion evidence

| Required follow-up | Owner | Status |
|---|---|---|
| Confirm primary access for each surface | Zo | Not verified |
| Designate a second human backup | Zo | Unassigned |
| Verify sealed recovery material is available | Zo | Not verified |
| Verify the private written recovery runbook exists and is usable | Zo | Not verified |
| Review effective agent publish and DNS access against the policy | Zo | Not verified; no permissions changed |
| Verify operational recovery and rollback evidence | Zo | Not verified |

A reviewer may record completion dates here without publishing the recovery material. Do not mark a step complete on the strength of a green test suite alone.

## Related records

- SUPPORT_MATRIX.md: supported public path and release boundary.
- Live private runbooks stay authoritative for current configuration.
