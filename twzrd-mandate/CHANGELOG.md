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

Hardened before release, after an internal security review:

- The signed amount is always the recorded spend; a settlement report that
  differs from it pauses spending instead of lowering the recorded spend.
- The spend and a `pending` decision line are written to disk before a
  payment leaves; a payment whose process died is recorded and pauses
  spending at the next start (`payment_unresolved`).
- A violation pause lasts until the mandate expires, or until `resume`.
- Receipts older than 900 seconds, or already accepted once, are refused;
  a wallet in the request's query string no longer counts as a subject.
- The MCP proxy forwards the message it parsed and refuses keys that a
  case-insensitive decoder could read differently.
- The `/v1` meter answers only the sidecar (per-start token) and does not
  start without `inference` in `allowedTools`.
- Pinning an operator issuer turns self-signed mandates off unless
  `--allow-self-mandate` is given.
- Response bodies are capped while they stream, not after.
- An agent's own `Authorization: Payment` header is dropped.
- A ledger that no longer contains the head the last heartbeat signed is
  refused on start.
- `mandate kill` and `resume` follow `killswitchDir` only from a mandate
  whose signature verifies, and `kill` always tells the sidecar too.
- A target URL with credentials is refused; URLs in ledger error text are
  cut to scheme, host and path.

Not in this release: MPP settlement (an MPP challenge is refused), and any
run against a funded wallet. See "Limits of 0.1.0" in the README.
