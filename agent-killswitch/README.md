# Agent Spend Kill-Switch

A drop-in local reverse proxy that sits in front of any OpenAI-compatible
`/v1/chat/completions` endpoint. It enforces hard token/cost budgets, gives
you an instant file-based kill switch, and writes every decision to an
append-only JSONL ledger.

Point any OpenAI client at it by changing one variable — `OPENAI_BASE_URL` —
and calls through the proxy are refused once they would cross the limits you
set. It caps a bill: it does not detect a loop, and a loop that costs $0 (a
free model) keeps running until you touch the kill file. It listens on
`127.0.0.1` by default and talks to one configured upstream.

## 5-minute setup (npm / npx)

Requires Node.js 20 or newer. No global install needed:

```sh
# 1. One directory for the ledger and the kill file (same as the Docker flow)
mkdir -p ./data

# 2. Run — the only secret is your upstream key. With no config.yaml in
#    the working directory the proxy uses the defaults from
#    config.example.yaml (upstream https://api.openai.com/v1, port 4020,
#    kill file ./data/.kill, ledger ./data/spend-ledger.jsonl).
OPENAI_API_KEY="$OPENAI_API_KEY" npx --yes @twzrd1111/agent-killswitch

# 2. Point any OpenAI client at it
export OPENAI_BASE_URL="http://127.0.0.1:4020/v1"
```

To change limits or the upstream, write a `config.yaml` and pass it as the
first argument — `npx --yes @twzrd1111/agent-killswitch ./config.yaml` — or
set `KILLSWITCH_CONFIG`. `config.example.yaml` in this repository is a full
reference; every value has a `KILLSWITCH_*` env override (table below). The
kill file and the ledger land in `./data/` under the directory you run
from, so `touch ./data/.kill` stops it.

## 5-minute setup (Docker)

```sh
docker pull ghcr.io/twzrd-sol/agent-killswitch:0.1.9

mkdir -p ./data

docker run --rm \
  -p 127.0.0.1:4020:4020 \
  -v "$(pwd)/data:/app/data" \
  -e OPENAI_API_KEY \
  ghcr.io/twzrd-sol/agent-killswitch:0.1.9
```

Then:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:4020/v1
```

Emergency stop, from the directory where Docker was launched:

```sh
touch ./data/.kill
```

A missing config file already uses the defaults, so you do not need to copy
`config.yaml`. The host `./data` mount is only for the ledger and
`touch ./data/.kill`. The mounted directory preserves the ledger across
restarts. Workers sharing budgets must mount the same host directory.

Works with LangChain, AutoGen, CrewAI, Vercel AI SDK, Cursor, and anything
else that speaks `/v1/chat/completions` — streaming included.

## The kill switch

```sh
# Stop all spend immediately (no upstream call is made after this)
touch ./data/.kill     # or: curl -X POST http://127.0.0.1:4020/kill

# Resume
rm ./data/.kill        # or: curl -X POST http://127.0.0.1:4020/reset
```

With the Docker setup above, `./data` is mounted from the host, so from
the directory where Docker was launched, `touch ./data/.kill` reaches the
container.

**Upgrading from 0.1.0 or 0.1.1:** the default kill file moved from `./.kill`
to `./data/.kill`. The old `config.example.yaml` set `file_path: "./.kill"`
explicitly, so a `config.yaml` copied from it keeps the old path. In Docker
that path is `/app/.kill`, outside the mounted volume, and a host-side
`touch` never reaches it. Change it to `./data/.kill`, then check with
`curl http://127.0.0.1:4020/healthz` (`"killed": true` after the touch).

A vetoed request returns an OpenAI-shaped error so frameworks handle it
gracefully (HTTP 403 for the kill switch, 429 for budgets):

```json
{"error": {"type": "killswitch_veto", "code": "budget_exceeded",
  "message": "Hourly limit $5.00 hit", "spent_usd": 5.12, "limit_usd": 5.0}}
```

If upstream does not answer within `timeout_ms` (default 60 s) the proxy
returns 504 `upstream_timeout`; if it cannot be reached at all, 502
`upstream_unreachable` (both `"type": "killswitch_error"`). Upstream may
still bill a request it received before the timeout, so the call keeps its
pre-call hold (below) and the ledger records that estimate. A stream that has
started is never cut off by the timeout.

### In-flight holds

An allowed call holds its pre-call estimate from the moment it passes the
check until it finishes, so concurrent calls see each other's spend:

- **With `max_tokens`**: the token hold is `max_tokens`, and the dollar hold
  is all of those tokens at the model's output rate.
- **Without `max_tokens`**: the dollar estimate is the per-request cap
  (`max_cost_per_request_usd`, $0.50 by default), and the hourly and daily
  checks run against it. There is no token estimate, so the token hold is 0.
  A model priced at $0 holds no dollars.

When the call ends, the hold becomes a ledger line:

- **Upstream reports usage**: the real cost is written (`"metered": "usage"`).
- **The call finished without usage**: the held estimate is written
  (`"metered": "held_estimate"`). This covers a 2xx with no usage, a stream
  that ends without a usage event, a timeout, an unreachable upstream, or an
  error after the request was sent. A restart replays it.
- **Upstream answers non-2xx without usage** (for example a 402 payment
  challenge): the hold is released and no spend is written.

A veto before the request is sent leaves no hold. Holds live in memory only:
a crash while a call is in flight drops its hold rather than charging an
unsettled estimate forever. `/healthz` reports `in_flight`.

## What the kill switch protects against

It caps what a **runaway** agent can spend (a loop, a retry storm, a prompt
that will not end) and refuses the next call once a limit would be crossed.
It does not stop the loop itself: calls that stay under the limits keep
going until you touch the kill file, and a call already sent upstream runs
to its end. It does not stop an **adversarial** agent either. Any local process that can
write the kill file's directory, or reach `127.0.0.1:4020` while the kill
API is on, can lift the kill with `rm` or `POST /reset`, and that includes
the agent itself. If the agent could act against you:

- run the proxy as a different user or in a container, with `data/` not
  writable by the agent;
- set `KILLSWITCH_KILL_API=false` so `/kill` and `/reset` are off (the file
  still works);
- keep the upstream key out of the agent's environment, or it can call
  upstream directly and skip the proxy. Traffic that never reaches the
  proxy's port is not capped.

## Configuration

YAML file plus env overrides (env wins). A missing config file uses the
defaults below. Copy `config.example.yaml` to `config.yaml` only if you
want to edit the limits in a file:

| Env var | YAML key | Default |
|---|---|---|
| `KILLSWITCH_CONFIG` | — (config path) | `./config.yaml` |
| `KILLSWITCH_UPSTREAM_BASE_URL` | `upstream.base_url` | `https://api.openai.com/v1` |
| `KILLSWITCH_API_KEY_ENV` | `upstream.api_key_env` | `OPENAI_API_KEY` |
| `KILLSWITCH_UPSTREAM_TIMEOUT_MS` | `upstream.timeout_ms` | `60000` (`0` disables) |
| `KILLSWITCH_MAX_TOKENS_MINUTE` | `limits.max_tokens_per_minute` | `100000` |
| `KILLSWITCH_MAX_USD_HOUR` | `limits.max_usd_per_hour` | `5.00` |
| `KILLSWITCH_MAX_USD_DAY` | `limits.max_usd_per_day` | `25.00` |
| `KILLSWITCH_MAX_COST_REQUEST` | `limits.max_cost_per_request_usd` | `0.50` |
| `KILLSWITCH_KILL_FILE` | `kill_switch.file_path` | `./data/.kill` |
| `KILLSWITCH_KILL_API` | `kill_switch.enable_api_endpoint` | `true` |
| `KILLSWITCH_LEDGER_PATH` | `logging.path` | `./data/spend-ledger.jsonl` |
| `KILLSWITCH_PORT` / `PORT` | `server.port` | `4020` |
| `KILLSWITCH_HOST` | — (bind address) | `127.0.0.1` (Docker image sets `0.0.0.0`) |
| `KILLSWITCH_FREE_MODELS` | — (comma-separated exact model ids) | unset |

When `KILLSWITCH_FREE_MODELS` is set, a model outside that list is rejected
with 403 `model_not_allowed` and never reaches upstream. The proxy also
skips the upstream `Authorization` header and does not read the API key
environment variable. Leave it unset for the normal keyed OpenAI proxy.

A listed model that has no row in the price table is priced at **$0**: the
list is your statement that it costs nothing, which is what a local model
behind Ollama or a free catalog entry is. The dollar limits then never
trip for it; the per-minute token limit and the kill file still apply. A
listed model that does have a price row (`gpt-4o`, for example) keeps that
price, and a dated or suffixed id of a priced model (`gpt-4o-2024-11-20`)
keeps the $15/$60 fallback, or that row's price where it is higher.

The $0 price is for unpaid calls only. Keyless mode is also how an
MPP/x402 buyer runs the proxy, so a call that carries a payment credential
(`X-Payment`, `Payment-Signature`, any `X-Payment-*`, or `Authorization:
Payment ...`) is priced as if the model were not on the list, and the
dollar limits apply to it. Do not list a model your upstream bills for in
a way the proxy cannot see.

A $0 call without `max_tokens` holds nothing before it is sent, so a burst
of parallel calls to a local model all reach upstream; the per-minute token
limit counts them once the responses land.

Every decision — allowed or vetoed — appends one line to the JSONL ledger
with timestamp, model, token counts, `cost_usd`, `allowed`, `veto_reason`,
and `request_id`; allowed lines also carry `metered` (`usage` or
`held_estimate`). An allowed line is written when the call ends. Restart replays the last 48 h to rebuild the spend
windows; the ledger file is the source of truth. Each line also carries
`prev`, which links it to the line before it (see "Ledger integrity").

## Ledger integrity

Every line the proxy writes carries `prev`: the SHA-256 (hex) of the exact
bytes of the last complete line before it, or `"genesis"` for the first line.
Editing, removing or reordering a line breaks the link of the line after it.
`twzrd-x402-gate`'s durable spend ledger uses the same convention.

Check a ledger offline (no config, API key or network needed):

```sh
npx @twzrd1111/agent-killswitch verify-ledger ./data/spend-ledger.jsonl
# in the container:
docker exec <container> node dist/index.js verify-ledger
```

Without a path it reads `KILLSWITCH_LEDGER_PATH`, else
`$TWZRD_STATE_DIR/spend-ledger.jsonl`, else `./data/spend-ledger.jsonl`. If
your config sets `logging.path`, `compute.ledger_path` or `state_dir`, pass
the ledger path.
Exit 0 means the chain is intact, 1 means it is broken (or `--strict` found
something), and 2 means the file could not be checked. `--json` prints the
full report.

What the chain does not prove on its own:

- **The newest line.** Nothing commits to it yet. Removing it, or rewriting
  every line and recomputing every hash, still verifies. The command prints
  the `head` hash. Record it somewhere the ledger's writer cannot change: a
  later run that shows a different head over the same lines means the history
  was rewritten.
- **Several copies on one file.** Each copy reads the last line just before it
  appends, so the chain stays linear. Two copies appending at the same moment
  both name the same `prev`. The command reports that as a fork, and one row
  of the fork is then committed to by no later row. `--strict` refuses forks,
  unparseable lines and rows without `prev`, for one copy per file.
- **Older rows.** Rows written before this version have no `prev`. They are
  reported and not checked; the first chained row commits only to the last
  of them.

## Tests

```sh
npm ci && npm test
```

Offline: a stub upstream on `127.0.0.1` stands in for OpenAI, so no key,
network or spend is needed. Covered: the default kill file (403, upstream
never called), the kill API, ledger replay over the hourly limit (429),
replay skipping vetoed, stale and torn lines, metered cost on a normal and
a streamed request surviving a restart, the 504/502 upstream failures
keeping the held estimate, overlapping calls seeing each other's holds
(dollars and tokens), the per-request cap standing in for a missing
`max_tokens`, a 200 and a stream without usage keeping the hold, an
upstream HTTP 402 whose `WWW-Authenticate` / `PAYMENT-REQUIRED` challenge
reaches the client, a paid retry whose `X-Payment` / `Payment-Signature` /
`X-Payment-Signature` headers reach upstream, and `Payment-Receipt` /
`X-Payment-*` on 200 (stream and non-stream). The ledger chain: rows written
through the proxy (allowed and vetoed) verify with `--strict`; an edited,
removed, swapped or garbled line is reported at the line after it; forks
from two copies (refused with `--strict`), older rows, torn tails and a
ledger written by `twzrd-x402-gate` verify; and the `verify-ledger` exit
codes. A test also states the limit: dropping the newest line or rewriting
every hash verifies, and only a recorded head shows it.

## Pricing notes

Costs use a static per-model table (`src/pricing.ts`, checked against
provider catalogs; sources below). There are no live pricing fetches by design.
An **unknown model is estimated at a fixed fallback** of
**$15 input / $60 output per million tokens** rather than rejected —
failing closed on cost beats failing open. A model id that is not in the
table is priced at that fallback (or at a dearer row it extends; see "Built-in
price rows") unless you put it on `KILLSWITCH_FREE_MODELS`, which
prices it at $0 (above); `nvidia/nemotron-3.5-bolt` is listed at $0. The
ledger shows exactly what was assumed.

The checks before a call do not count prompt tokens. The per-request cap
prices `max_tokens` at the model's output rate (or uses the cap itself when
`max_tokens` is missing), so a very large prompt with a small `max_tokens`
is forwarded. Its real cost, prompt included, enters the hourly and daily
windows when upstream reports usage.

Upstream payment headers an MPP/x402 buyer needs — `WWW-Authenticate`
challenges, `PAYMENT-REQUIRED`, `Payment-Receipt`, and `X-Payment-*` — are
forwarded to the client on both stream and non-stream responses, including
HTTP 402. On the retry, client `X-Payment`, `Payment-Signature`,
`X-Payment-Signature`, and other `X-Payment-*` headers are copied upstream.
The proxy still injects `Authorization: Bearer ${OPENAI_API_KEY}` by default
and passes through the client's `Authorization` only when it is an explicit
402 payment credential (`Payment` scheme, or a non-Bearer value with a
payment header) — never as a second API key. Hop-by-hop headers,
`Set-Cookie`, and other secrets are not copied.

## What it is not (v0.1 scope)

OpenAI chat completions only. No Anthropic, no embeddings/images, no
tokenizer, no multi-upstream or key rotation, no dashboard, no Redis/SQLite.

## Paid support

This is a local binary with no SaaS backend. Annual support (priority fixes,
custom limits/policies, audit-export help) is available. Open an issue at
<https://github.com/twzrd-sol/twzrd-trust/issues> with `agent-killswitch` in
the title, your use case and team size. Bugs go to the same tracker.


### Served-model telemetry

New ledger rows keep `model` as the requested ID for compatibility and add
`requested_model`, `served_model` (string or null), and `model_mismatch`.
The proxy reads the JSON response's `model`, or the last valid `model` from
SSE data events, independently of whether usage is present. Missing, invalid,
blank or over-512-character IDs are recorded as null. A mismatch is exact string
inequality; aliases and dated IDs can therefore flag. False with a null served
model means unknown, not a verified match. Vetoes have no served model.

These are upstream-reported IDs, not execution attestations. Detection is telemetry;
it does not reject responses or change billing to a possibly untrusted returned ID.
Cost accounting continues to use the requested model. If a stream aborts before
forwarding completes, existing hold settlement applies and the served ID may be unknown.
No prompts, completion text, or response bodies are added to the ledger.

### Operator model-rate overrides

Rates are USD per **one million tokens**, with separate `in` and `out` values:

```sh
export KILLSWITCH_MODEL_RATES='{"deepseek-reasoner":{"in":0.55,"out":2.19}}'
```

This is a configuration example, not a current DeepSeek price claim. In the legacy
`config.yaml`, the equivalent is:

```yaml
model_rates:
  deepseek-reasoner: {in: 0.55, out: 2.19}
```

Exact ID precedence: environment entry > config entry > built-in table > existing
unpaid free-model allowlist rule > fixed $15/$60 unknown fallback, raised to
any dearer row or override the id extends with `-` or `:`. Each override
requires both finite nonnegative numeric fields; malformed JSON, missing fields,
negative values and unknown fields fail startup. Zero rates are an explicit
operator assertion. Request bodies cannot override these rates. Restart to reload.
The shared binding-policy schema is unchanged; use the environment override with it.

The same rate lookup drives admission, in-flight holds and usage-based settlement.
Existing ledger amounts are retained on restart. Adding a high-priced override does
not raise the fallback for unrelated unknown IDs, only for IDs that extend it. Cached tokens, audio, tools,
provider-specific fees and route changes can make actual provider charges differ.

### Built-in price rows

Checked 2026-11-10 (OpenAI rows 2026-11-07). Each row is the highest price the
upstream can bill for that exact id, including any premium the request body can
select, because the agent being limited writes the body and the proxy forwards
it. Rows use the top prompt-length tier and already include announced price
increases. A row is a conservative budget estimate for the limits, not the price
a given call pays: under-pricing is the unsafe direction, so a row usually
overstates a call. If your agents cannot reach a premium (you pin one route, or the upstream
ignores the field), set an override (above) at the price you actually pay. The
full list, grouped by source, is in `src/pricing.ts`.

| Group | Ids | Source and rule |
|---|---:|---|
| OpenRouter (`anthropic/…`, `deepseek/…`, `google/…`) | 37 | `https://openrouter.ai/api/v1/models/<id>/endpoints` (public, no key): the dearest endpoint, because OpenRouter picks the provider per request. Includes regional, fast and priority endpoints, prompt-length tiers and audio input, at the undiscounted price where a discount is listed |
| Anthropic, [OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) (`claude-sonnet-5-5`, …) | 18 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing): fast mode where offered, times the 1.1x `inference_geo` multiplier on Claude 4.6 and later |
| DeepSeek API (`deepseek-flash`, `deepseek-v4-pro`) | 4 | [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), peak band, cache-miss input |
| Gemini API, OpenAI compatibility (`gemini-3.6-flash`, …) | 11 | [Gemini pricing](https://aistudio.google.com/docs/pricing): Priority tier, and audio input where it bills above text |
| OpenAI and BlockRun | 7 | OpenAI published prices; BlockRun's free `nvidia/nemotron-3.5-bolt` |

What the rule produces, for example:

- **Gemini API.** The compatibility layer honours `service_tier="priority"`
  (1.8x) and `input_audio` from the request body, so `gemini-2.5-flash` is
  $1.80/$4.50 (Priority, audio input) where the standard text price is
  $0.30/$2.50.
- **Anthropic layer.** It documents neither fast mode nor `inference_geo`, but it
  does forward some extra body fields (`thinking`), so both are priced in:
  `claude-sonnet-5-5` is $2.20/$11 (standard $2/$10, times 1.1), and
  `claude-fable-5-2` is $17.60/$88 (fast mode $16/$80, times 1.1).
- **Prompt-length tiers.** `claude-haiku-5-5` uses its over-100k-prompt price.
  `claude-sonnet-4-5-20250929` uses $6/$22.50, the over-200k price that
  OpenRouter lists for Anthropic's own AWS endpoint (Anthropic's page lists
  $3/$15). `claude-mythos-preview` has no published price and stays on the
  fallback.
- **OpenRouter.** `anthropic/claude-sonnet-4.6` is $3.30/$16.50 because
  regional Bedrock and Vertex bill 1.1x. `google/gemini-3.7-flash` is
  $2.70/$13.50, its priority endpoint without the listed 50% discount.
  `anthropic/claude-fable-5.2` is $16/$80 because a fast-mode endpoint is
  listed.
- **Announced increases.** `gemini-3.6-flash` and `gemini-3.8-flash` carry the
  Priority price Google announced for 2027-01-01 ($2.70/$13.50), and
  `gemini-4-carbon` / `gemini-4-argon` the one for 2026-12-01 ($7.20/$36).
- **Rows above the fallback.** Four rows bill more than $60 output (up to $88)
  and keep their price. So does an id that extends one of them with `-` or `:`
  (`anthropic/claude-fable-5.2:nitro`, `claude-fable-5-2-20261201`), and the
  same applies to an operator override. A variant of a row below the fallback
  still gets $15/$60.
- **Legacy and retired ids.** `deepseek-v4-flash` and
  `deepseek-v4-flash-vision-exp` are legacy names that DeepSeek still accepts and
  bills at the Flash price. `deepseek-chat`, `deepseek-reasoner` and the retired
  OpenRouter ids `deepseek/deepseek-r1`, `anthropic/claude-3.5-sonnet` and
  `google/gemini-2.0-flash-001` are not listed by their providers and stay on the
  fallback. Configure a verified rate if your upstream still serves them.

The fallback is not a ceiling. An unlisted model that bills more than $60 per
million output tokens is under-counted until you add an override. Settlement
prices `prompt_tokens + completion_tokens` from the upstream's usage block, so
per-image, per-search and per-request fees are not counted, and neither are
reasoning tokens a provider leaves out of `completion_tokens`. Static rates are
estimates, not live prices; no catalog fetch runs in the request path.
