# Changelog

## 0.2.0 (2026-11-12)

### Changed

- Removed HTTP `POST /reset`. Operators resume by removing the `.kill` and
  `.pause` sentinel files; the low-friction `POST /kill` emergency stop remains.

### Fixed

- Legacy `kill_switch.enable_api_endpoint` now accepts only a literal YAML
  boolean. String values such as `"false"`, `off`, and `no` fail at startup
  instead of becoming truthy and enabling the endpoint.

## 0.1.11 (2026-11-11)

### Changed

- The checks before a call now count prompt tokens. Every byte of the request body the proxy forwards counts as one prompt token (or every byte it received, when that is more). For text carried in the body this is an upper bound: a tokenizer cannot produce more tokens than the text has bytes, and a JSON string is never shorter than the text it decodes to. It is not a bound on tokens an upstream adds itself (message framing, a hidden system prompt); the README states what is assumed. The count is added to the per-minute token hold and, at the model's input rate, to the dollar estimate. A large prompt with a small `max_tokens` used to be forwarded in 0.1.10; it is now checked against the per-request cap and the windows. README "Prompt-token bound" has the argument and its limits.
- For any single request the estimate only rises: one that 0.1.10 refused is still refused, and some that 0.1.10 forwarded are now refused: a text request whose bytes exceed `max_tokens_per_minute` (100,000 by default, so about 100 kB), or whose bytes at the input rate exceed `max_cost_per_request_usd`. Raise those limits if you send large prompts on purpose.
- A request that is over `max_tokens_per_minute` on its own is refused without writing the 60-second pause file, since waiting cannot make it fit. Before, a `max_tokens` above the limit wrote the pause, so a small request sent in the next minute was refused too; it is now checked on its own. A request that fits alone but not on top of the last minute's spend still writes the pause. While the hour or day spend is at or over its limit, every request that passes the kill switch, a non-budget pause and the model allowlist is refused with the daily or hourly pause first (the daily one when both are spent), whatever its size. Before, a request over the per-request cap, or one refused by the per-minute check, was refused without the long pause even when the hour was spent, and with both windows spent the hourly pause came first. With room left, a request refused as too large on its own (per-minute limit or per-request cap) writes no pause, including some for which 0.1.10 wrote the hourly or daily pause because its smaller estimate did not fit what was left. A request whose larger estimate does not fit what is left of the hour or day writes the hourly or daily pause, as such a refusal did in 0.1.10; that can now happen to a request 0.1.10 forwarded.
- The proxy no longer shortens a pause it saw in force when it checked the request. Before, a 60-second per-minute refusal during an hourly or daily budget pause rewrote the pause file with 60 seconds, which released the payment gate after a minute, and an hourly refusal cut a daily pause to one hour. A pause another process writes at the same moment can still be replaced.
- A model id with a `:suffix` other than `:free`, `:nitro`, `:floor`, `:extended` or `:thinking` holds at least the per-request cap, because a variant can make the upstream add prompt content the body does not carry. Every suffix on the id is checked, and an id with an `@` (a preset) holds the cap too.
- A request whose prompt is not plain text holds at least the per-request cap, with or without `max_tokens`. That covers image, audio and file parts, `tools`, `response_format`, and any request field the proxy does not know, because the upstream can bill prompt tokens for them that the byte count does not bound. Before, such a request with `max_tokens` held only `max_tokens` at the output rate. If upstream answers such a call without usage, the ledger records the cap for it; with the defaults, ten of those use the $5 hourly limit.
- Without `max_tokens` the hold is still the per-request cap, and now the prompt bound's cost when that is higher. The token hold is the request bytes, where it used to be 0.
- The output limit is the larger of `max_tokens` and `max_completion_tokens`, times `n`. Before, only `max_tokens` was read, once. `n` other than 1, a `service_tier` other than `default` or `flex`, and `max_completion_tokens` without `max_tokens` also hold at least the per-request cap.
- A `max_tokens` below 1 is treated as missing, so the per-request cap is held. Before, the proxy took a negative one as given, so the hold was negative and lowered the spend other calls were checked against, and 0 held nothing.
- `createBudgetGate` (new in this release, see Added): `evaluate()` and `estimate()` take `promptBytes` and `promptTextOnly`, and the package exports `isTextOnlyPrompt(body)`. `budgetInputForChatRequest(text)` reads all four inputs from the exact text you send, with the proxy's reading of the model, output limit and text-only flag (the proxy's byte count for the same text can be higher, never lower, since it re-serializes the body), and `chatOutputLimit(body)` gives the output limit alone. `maxTokens` accepts `Infinity`, which `chatOutputLimit` returns when the limit times `n` overflows; every limit refuses it. `isTextOnlyPrompt` is false when `max_completion_tokens` is set without a usable `max_tokens`. Without `promptBytes` the dollar estimate is never below `maxCostPerRequestUsd`. A `promptBytes` that is not a non-negative whole number throws.
- Unchanged: a call that ends with upstream usage is ledgered at the real cost. A call that ends without usage is ledgered at the hold, which is now the larger estimate. A model priced at $0 still holds no dollars.

### Added

- Programmatic admission. `import { createBudgetGate } from "@twzrd1111/agent-killswitch"` exposes the proxy's pure gate math for in-process callers such as Mastra's `beforeToolCall` hook. Bind the limits once (`createBudgetGate({ maxTokensPerMinute, maxUsdPerHour, maxUsdPerDay, maxCostPerRequestUsd, modelRates?, allowedModels?, zeroPriceModels? })`), then call `gate.evaluate({ model, maxTokens?, window, killed?, paused?, pauseReason?, pauseDecisionId? })` or `gate.estimate({ model, maxTokens? })` per tool call. The helper does no I/O and keeps no spend state: the caller supplies the live spend window (including in-flight holds) and records actual usage after an allowed call completes. Limits, model rates and model lists are snapshotted and frozen at construction, and every checked request field is read exactly once, so accessor-based windows, options and price rows cannot fail open; an empty `allowedModels` list throws at construction because the gate math reads `[]` as "no allowlist" (pass `null` for that). Malformed options, requests and model rates throw rather than fail open, and `estimate` returns the same token/dollar hold the proxy uses in flight. The HTTP proxy remains the way to get the JSONL ledger, the kill file and the upstream lifecycle.

### Fixed

- A configuration error at startup prints one `agent-killswitch:` line and exits 1 instead of a Node stack trace. This covers a missing upstream key, an invalid number or port, a config file that is not valid YAML, and a ledger path that cannot be read. A missing key names the configured key variable and where free models can be listed instead (`KILLSWITCH_FREE_MODELS`, and `compute.free_models` under a binding policy).
- A numeric setting that is not a non-negative number now names its variable (`KILLSWITCH_MAX_USD_DAY must be a non-negative number, got 'lots'`), not only the value.
- A port that is not a whole number from 0 to 65535 is refused at startup. Before, an out-of-range or fractional port in the environment crashed in `listen`, and a fractional port in the config file was rounded down.
- An empty `KILLSWITCH_PORT` means unset, as an empty value does for every other setting, so the config file's port or 4020 is used. Before, it listened on a random port.

## 0.1.10 (2026-11-11)

### Added

- Ledger hash chain. Every new ledger line carries `prev`, the SHA-256 (hex) of the exact bytes of the line before it, or `"genesis"` for the first line. This is the convention `twzrd-x402-gate`'s durable spend ledger already uses. The writer reads the file's last line right before it appends, so several copies sharing one ledger file stay on one chain. A `prev` the caller passes is ignored.
- `agent-killswitch verify-ledger [path] [--strict] [--json]` checks the chain offline, with no config, API key or network. It reports breaks (an edited, removed or reordered line, reported at the line after it), forks from two copies appending at once, rows written before the chain existed, unparseable lines and a torn tail. It prints the head hash to record. Exit 0 intact, 1 broken (or a `--strict` finding), 2 cannot check. On its own, the chain does not show a removed newest line or a full rewrite with recomputed hashes; a head recorded elsewhere does.
- Spend accounting, replay and the line format are otherwise unchanged. Older readers ignore the new field.

## 0.1.9 (2026-11-11)

### Added

- Record requested and upstream-reported served model IDs with exact-string mismatch telemetry for JSON and SSE responses, without logging content.
- Add verified provider text-rate estimates and validated operator `model_rates` / `KILLSWITCH_MODEL_RATES` overrides across admission, holds and settlement. Unknown IDs retain the fixed $15/$60 fallback.
- The built-in table covers the Anthropic, DeepSeek and Gemini OpenAI-compatible endpoints (`claude-sonnet-5-5`, `deepseek-flash`, `gemini-3.6-flash`, 33 ids) and 37 OpenRouter ids. Each row is the highest price the upstream can bill for that id, including any premium the request body can select, because the agent being limited writes the body. Rows are conservative budget estimates for the limits, not the price a given call pays. Direct Gemini rows use the Priority tier and audio input (the compatibility layer honours `service_tier="priority"` and `input_audio`): `gemini-2.5-flash` is $1.80/$4.50, not the $0.30/$2.50 standard text price. Anthropic rows include fast mode where offered and the 1.1x `inference_geo` multiplier on Claude 4.6 and later. OpenRouter rows take the dearest endpoint it can route to, at the undiscounted price, since it picks the provider per request: `anthropic/claude-sonnet-4.6` is $3.30/$16.50 (regional Bedrock and Vertex), not the $3/$15 catalog headline. Tiered models use their top prompt-length tier, and announced increases (Gemini 3.6/3.8 Flash on 2027-01-01, Gemini 4 on 2026-12-01) are already applied. A known row may sit above the fallback (`claude-fable-5-2` $17.60/$88) and keeps its price, and so does an unknown id that extends it with `-` or `:` (`anthropic/claude-fable-5.2:nitro`); this also applies to operator overrides. `deepseek-chat` and `deepseek-reasoner` are not priced, because DeepSeek's pricing page no longer lists them.

### Fixed

- A port that is already in use no longer ends in a Node stack trace. The CLI prints one line naming the port and host, that another agent-killswitch may be running, and how to pick another port (`KILLSWITCH_PORT`), then exits 1. A port the user may not bind (`EACCES`) gets the same treatment.
- A model on the free allowlist (`KILLSWITCH_FREE_MODELS` / `compute.free_models`) that has no row in the price table is now priced at $0, where it used to be billed at the o1 fallback rate. A local model behind Ollama no longer runs into the hourly dollar limit on spend that never happened. A listed model that has a price row keeps it, and a model off the list is still priced as o1.
- A call to a $0 model without `max_tokens` holds $0, where it used to hold the per-request cap. This also applies to `nvidia/nemotron-3.5-bolt`.
- The $0 price is for unpaid calls. A call that carries a payment credential (`X-Payment`, `Payment-Signature`, any `X-Payment-*`, or `Authorization: Payment ...`) is priced as if the model were not on the list, so a keyless MPP/x402 buyer keeps the dollar limits. A dated or suffixed id of a priced model (`gpt-4o-2024-11-20`) on the list also keeps the o1 fallback.
- Ledger rows already written at the o1 rate still count until they age out of the hourly and daily windows, so a proxy that hit the limit before the upgrade stays limited for up to 24 hours unless the ledger is moved aside.
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
