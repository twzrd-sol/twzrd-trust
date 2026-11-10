# Changelog

## Unreleased

- A port that is already in use no longer ends in a Node stack trace. The CLI prints one line naming the port and host, that another agent-killswitch may be running, and how to pick another port (`KILLSWITCH_PORT`), then exits 1. A port the user may not bind (`EACCES`) gets the same treatment.
- A model on the free allowlist (`KILLSWITCH_FREE_MODELS` / `compute.free_models`) that has no row in the price table is now priced at $0, where it used to be billed at the o1 fallback rate. A local model behind Ollama no longer runs into the hourly dollar limit on spend that never happened. A listed model that has a price row keeps it, and a model off the list is still priced as o1.
- A call to a $0 model without `max_tokens` holds $0, where it used to hold the per-request cap. This also applies to `nvidia/nemotron-3.5-bolt`.
- Unchanged: the per-minute token limit, the kill file and the pause sentinel apply to free models as before.

## 0.1.8 (2026-11-10)

Track 5 Binding Plane: shared `twzrd.binding_policy.v1` config envelope and `.pause` payment-gate backpressure sentinel.

- `loadConfig` accepts a `twzrd.binding_policy.v1` YAML/JSON document (`state_dir`, `compute`, `payment`) alongside the existing `config.yaml` layout, validating `compute` keys fail-closed while ignoring `payment` keys owned by `twzrd-x402-gate`.
- `checkPauseSwitch` reads `<state_dir>/.pause` (`twzrd.pause_sentinel.v1`):
  - Active (`now < until_unix_ms`): vetoes `/v1/chat/completions` with HTTP 429 `payment_gate_halt` before any upstream call, surfacing `decision_id` in the veto error object and on `GET /healthz` (`paused: true`, `pause_until_unix_ms`, `pause_reason`, `pause_decision_id`).
  - Expired (`now >= until_unix_ms`): allows requests through without requiring manual unlink.
  - Corrupt or unreadable `.pause`: fails closed with HTTP 429 `payment_gate_halt` (`corrupt_pause_sentinel`).
- `POST /reset` clears both `.kill` and `.pause`.

## 0.1.7 (2026-11-09)

The package now starts from `npx`.

- `package.json` declares a `bin` entry (`agent-killswitch` →
  `dist/index.js`) and `src/index.ts` carries the `#!/usr/bin/env node`
  shebang, so `npx --yes @twzrd1111/agent-killswitch` installs the package
  and starts the proxy directly. Before, the published package had no
  `bin`, so `npx` installed it and exited without starting anything. The
  Docker path is unchanged.
- The CLI entry check compared `import.meta.url` against `process.argv[1]`'s
  basename. Under a bin symlink that basename is `agent-killswitch`, not
  `index.js`, so the comparison never matched and the process exited 0
  without listening. It now compares the real paths of the invoked file and
  this module, so every npm/npx shim starts the server.
- README: adds an npm / npx setup section next to the Docker one, with the
  env-var-only path (no `config.yaml` needed when the defaults fit).

## 0.1.6 (2026-11-08)

Multi-instance spend is now visible across copies.

- Each proxy tracks its own byte offset into the JSONL ledger. Before every
  budget check — on `/v1/chat/completions` and on `/healthz` — it stats the
  file and reads the lines other running copies appended since its last read.
  Two proxies against one ledger now share the hourly and daily windows
  instead of each spending their own; the same two-copy overspend that 0.1.5
  closed for in-flight calls, now closed for copies.
- A line without its terminating newline is held until the rest arrives, so a
  torn write never crashes a refresh nor half-counts. A truncated or replaced
  ledger (new inode) resets the read position and is re-read in full within
  the same 48 h retention window the startup replay uses.
- The kill switch file is unchanged: it vetoes every copy the moment it
  exists, independent of the ledger.

## 0.1.5 (2026-11-08)

Tighter refusals: in-flight calls now count against the budgets.

- An allowed call holds its pre-call estimate until it finishes, so a second
  call checked while the first is in flight sees it. Before, two calls that
  each fit could both pass and together overrun the hourly limit.
- A request without `max_tokens` is checked at the per-request cap
  (`max_cost_per_request_usd`, $0.50 by default) against the hourly and daily
  limits. Before, it skipped the dollar check.
- A call that finishes without usage writes the held estimate
  (`"metered": "held_estimate"`) instead of nothing. This covers a 2xx with no
  usage, a stream ending without a usage event, a timeout (504), an
  unreachable upstream (502), or an error after the request was sent. It
  counts in `hour_usd` and replays after a restart. A non-2xx upstream answer
  without usage, such as a 402 challenge, still writes nothing.
- Holds are not written to the ledger until the call ends; a crash mid-call
  drops the hold. `/healthz` adds `in_flight`.
- README: says the proxy caps a bill rather than stopping a loop (a $0 loop
  keeps running until the kill file is touched), that the pre-call checks do
  not count prompt tokens, that traffic which never reaches the proxy is not
  capped, and that `nvidia/nemotron-3.5-bolt` is priced at $0.

## 0.1.4 (2026-11-08)

No runtime change: `dist/` is built from the same source as 0.1.3.

- Source and releases move to the public `twzrd-sol/twzrd-trust` repository
  (`agent-killswitch/`). `repository` and `bugs` in `package.json` point there.
- Published by the `publish-agent-killswitch.yml` workflow through npm
  Trusted Publishing, with an npm provenance attestation.
- The tarball now includes `LICENSE` (MIT).
- The test script lets the shell expand `test/*.test.mjs`, so the tests also
  run on Node 20.

## 0.1.3 (2026-11-08)

- `KILLSWITCH_FREE_MODELS` is an exact model allowlist. When it is set, any
  other model is vetoed with 403 `model_not_allowed` before upstream, and the
  process does not read or send an upstream API key. Response headers
  `X-Free-Model`, `X-Fallback-Used`, `X-Health-Reroute`, `X-Original-Model`,
  `X-Served-Model`, and `X-Fallback-Model` are copied through to the client.
- `nvidia/nemotron-3.5-bolt` is priced at zero in the local table. Unknown
  models stay at the most expensive known rate.
- Forward `WWW-Authenticate`, `Payment-Receipt`, `PAYMENT-REQUIRED`,
  `PAYMENT-RESPONSE`, and `X-Payment-*` from upstream to the client on both
  stream and non-stream chat-completion responses, including HTTP 402.
  Hop-by-hop headers, `Set-Cookie`, and `Authorization` are still not
  forwarded on the response. SSE bodies remain byte-for-byte, including
  `[DONE]`.
- Forward client payment headers upstream: `X-Payment`, `Payment-Signature`,
  `X-Payment-Signature`, and any other `X-Payment-*`. Upstream
  `Authorization` stays `Bearer ${apiKey}` unless the client sent an
  explicit 402 payment credential: present, not identical to that Bearer
  value, and either the `Payment` scheme or a non-Bearer value beside a
  payment header. An empty free-model key sends no Bearer. A second API
  key never replaces the configured one. The spend caps still price the
  model call, not the payment blob.

## 0.1.2 (2026-11-07)

- The upstream call now has a timeout: `upstream.timeout_ms` /
  `KILLSWITCH_UPSTREAM_TIMEOUT_MS`, default 60000, `0` disables. It covers the
  response headers, plus the whole body when not streaming. The client gets
  504 `upstream_timeout`, or 502 `upstream_unreachable` when upstream cannot be
  reached. Before this, a stalled upstream held the request open until
  Node fetch gave up on its own (300 s by default) and the client got a
  generic 500.
  Failed requests are not metered.
- The default kill file is now `./data/.kill` (was `./.kill`). In the Docker
  image it sits on the mounted `data/` volume, so a host-side
  `touch ./data/.kill` reaches the container. A `config.yaml` copied from the
  old example sets `./.kill` explicitly: change it (see README, "Upgrading").
- README: what the kill switch does and does not protect against (any local
  process, including the agent, can lift it), the upstream failure codes, and
  a working support link.
- Dockerfile installs from the lockfile with `npm ci`; `.dockerignore` keeps
  `node_modules`, `dist`, `data/`, `config.yaml` and the kill file out of the
  build context.
- Offline test suite (`npm test`, `node:test`, stub upstream on loopback).
- package.json: `homepage` points at the npm page, `bugs` at the public
  tracker, the `repository` field that pointed at an unrelated repo is
  removed, and `publishConfig.access` replaces a non-standard top-level
  `access` key.

## 0.1.1 (2026-11-07)

- The Docker image sets `KILLSWITCH_HOST=0.0.0.0` so a published port reaches
  the server. Local runs still bind `127.0.0.1` by default.

## 0.1.0 (2026-11-07)

- First release: local reverse proxy for OpenAI-compatible
  `/v1/chat/completions`, with token-per-minute, hourly, daily and per-request
  limits, a file and HTTP kill switch, and an append-only JSONL spend ledger
  replayed on restart.
