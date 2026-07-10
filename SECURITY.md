# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Liquid Attention Protocol (on-chain program, server, SDK, or agent infrastructure), please report it responsibly.

**Email**: security@twzrd.xyz

**What to include**:
- Description of the vulnerability
- Steps to reproduce
- Affected component (on-chain program, server API, SDK, intel API)
- Impact assessment (fund loss, data exposure, denial of service, etc.)

**Response timeline**:
- Acknowledgment within 48 hours
- Initial assessment within 7 days
- Fix timeline communicated within 14 days

GitHub issues on this repository are also monitored: https://github.com/twzrd-sol/twzrd-trust/issues

## Scope

| Component | Address / URL | In Scope |
|-----------|--------------|----------|
| AO Program (mainnet) | `GnGzNdsQMxMpJfMeqnkGPsvHm8kwaDidiKjNU2dCVZop` | Yes |
| Server API | `api.twzrd.xyz` | Yes |
| Agent Intel API | `intel.twzrd.xyz` | Yes |
| Frontend | `twzrd.xyz` | Yes |
| SDK / packages | `@wzrd_sol/sdk`, `wzrd-client` (PyPI), packages in this repo | Yes |
| Relay | `/v1/relay/*` endpoints | Yes |

## On-Chain Program

The mainnet program `GnGzNdsQMxMpJfMeqnkGPsvHm8kwaDidiKjNU2dCVZop` is **immutable**: the upgrade authority was revoked in April 2026. No further on-chain upgrades are possible. Findings against the deployed program are still valuable for off-chain mitigations (server gates, SDK guards) and are in scope.

## Bug Bounty

No formal bug bounty program at this time. Significant findings will be acknowledged and credited.
