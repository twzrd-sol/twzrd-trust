# Changelog

## Unreleased

- A purchase is paid at most once inside the dedupe window. Each paid call
  is hashed (method, full URL, request body, `Idempotency-Key` header,
  recipient, chain, asset, amount); an identical one whose payment left in
  the last 60 seconds is refused at layer 4 with `duplicate_purchase` and
  nothing signed. The window runs from the end of the paid call, and an
  identical call is refused for as long as one is in flight. Over MCP a
  `tools/call` is keyed on tool name and arguments, not the JSON-RPC id;
  `params._meta["twzrd/idempotency-key"]` names a new purchase. Identical calls in flight together pay once, and a restart
  rebuilds the window from the decision ledger. A call that paid nothing
  does not count. Behaviour change: an agent that buys the same URL twice a
  minute on purpose must now send a new `Idempotency-Key`, or the operator
  sets `serve --dedupe-window off` (`dedupeWindowSeconds: 0`).
- The outcome line of a call that signed a payment carries `responseSha256`,
  the SHA-256 of the bytes the payment bought, and the `pending` and
  outcome lines carry `dedupeKey`. Both are optional members; existing
  ledgers verify unchanged.
- `trustScreen: "off"` (optional mandate member; `init --trust-screen off`)
  makes no trust lookup: the runtime skips the preflight and the gate's
  wash lookup. (With `requireMerkleInclusion` set, receipt inclusion proofs
  are still fetched from the receipt log, which defaults to the intel host.) It needs `minTrustScore` 0. The
  chain and counterparty lists, caps and 402 checks still apply. A mandate
  without the member is "required", and its signed bytes are unchanged.

## 0.1.2 (2026-11-26)

Security: depends on `twzrd-x402-gate` 0.28.1. 0.1.1 pinned 0.26.0, which is
inside GHSA-6cqg-vwmj-qw2v (fallback routing paid an unallowlisted route by
default) and is deprecated on npm. The mandate's payment transport already
refused any request that is not the call's own target, so a mandate never took
a fallback route; this release removes the deprecated dependency, and the
`"overrides"` workaround, for installs. The mandate's own code is unchanged
since 0.1.0; the gate's CHANGELOG (0.27.0 to 0.28.1) lists what changes
underneath.

## 0.1.1 (2026-11-18)

Security: depends on `twzrd-x402-gate` 0.26.0. 0.1.0 pinned 0.24.0, which is
inside GHSA-c6g3-6gf7-qc37 and GHSA-c7fj-pv9m-pjq4 (high) and is deprecated
on npm. The mandate's own code is unchanged since 0.1.0; the gate's CHANGELOG
(0.25.0 to 0.26.0) lists what changes underneath.

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
