# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in **TWZRD Trust / Agent Intel** (intel API, trust
packages in this repository, receipt verification, or x402 buyer-side gates), please report
it responsibly.

**Email**: security@twzrd.xyz

**What to include**:
- Description of the vulnerability
- Steps to reproduce
- Affected component (intel API, package in this repo, SDK, relay, on-chain program)
- Impact assessment (fund loss, data exposure, denial of service, etc.)

**Response timeline**:
- Acknowledgment within 48 hours
- Initial assessment within 7 days
- Fix timeline communicated within 14 days

GitHub issues on this repository are also monitored: https://github.com/twzrd-sol/twzrd-trust/issues

## Scope (primary)

| Component | Address / URL | In Scope |
|-----------|--------------|----------|
| Agent Intel API | `intel.twzrd.xyz` | Yes |
| Packages in this repo | `twzrd-x402-gate`, `twzrd-mcp-server`, `@wzrd_sol/plugin-trustgate`, `@wzrd_sol/eliza-plugin`, etc. | Yes |
| Receipt verifier | `twzrd-receipt-verifier` (npm / PyPI) | Yes |
| Frontend | `twzrd.xyz` | Yes |

## Legacy deployed components (still in scope)

These are no longer the primary product story on `twzrd-trust`, but they remain deployed and
eligible for responsible disclosure:

| Component | Address / URL | Notes |
|-----------|--------------|-------|
| AO Program (mainnet) | `GnGzNdsQMxMpJfMeqnkGPsvHm8kwaDidiKjNU2dCVZop` | Immutable since Apr 2026 |
| Legacy server API | `api.twzrd.xyz` | Agent auth, earn lane, claims |
| SDK | `@wzrd_sol/sdk`, `wzrd-client` (PyPI) | Protocol + agent clients |
| Gasless relay | `/v1/relay/*` on `api.twzrd.xyz` | Claims and sponsored txs |

Findings against the immutable on-chain program are still valuable for off-chain mitigations
(intel gates, SDK guards) even when no upgrade is possible.

## On-Chain Program

The mainnet program `GnGzNdsQMxMpJfMeqnkGPsvHm8kwaDidiKjNU2dCVZop` is **immutable**: the
upgrade authority was revoked in April 2026. No further on-chain upgrades are possible.

## Bug Bounty

No formal bug bounty program at this time. Significant findings will be acknowledged and credited.