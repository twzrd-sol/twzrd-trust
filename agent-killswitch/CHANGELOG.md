# Changelog

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
