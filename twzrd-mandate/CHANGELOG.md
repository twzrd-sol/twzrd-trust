# Changelog

## 0.1.0 (2026-11-17)

First release.

- `twzrd.mandate.v1`: a signed spend mandate with three issuer modes
  (`human-operator`, `self-mandated`, `ephemeral-session`). An expired,
  edited, unsigned or malformed mandate stops the runtime.
- `mandate init`, `self-issue`, `session`, `verify`.
- `mandate serve`: a loopback sidecar with an MCP proxy (`/mcp`, and
  `mcp-stdio`), a governed paid-HTTP route (`/pay/<url>` and plain-http
  `HTTP_PROXY`), an OpenAI-compatible metered route (`/v1/*`), and a
  control API (`/health`, `/mandate/status`, `/mandate/ledger`,
  `/mandate/heartbeat`, `/mandate/kill`, `/mandate/resume`).
- Six pre-sign refusal layers, each proven with zero signatures by
  `mandate verify-breakers`.
- x402 exact-amount USDC settlement on Solana and Base through a pay module
  the operator supplies; the package holds no key.
- V7 receipt verification under the pinned key, and receipt-log inclusion,
  after a paid call when the mandate requires them.
- A hash-chained decision ledger and a signed heartbeat
  (`twzrd.mandate.heartbeat.v1`).

Not in this release: MPP settlement (an MPP challenge is refused), and any
run against a funded wallet. See "Limits of 0.1.0" in the README.
