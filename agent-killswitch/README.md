# Agent Spend Kill-Switch

A drop-in local reverse proxy that sits in front of any OpenAI-compatible
`/v1/chat/completions` endpoint. It enforces hard token/cost budgets, gives
you an instant file-based kill switch, and writes every decision to an
append-only JSONL ledger.

Point any OpenAI client at it by changing one variable — `OPENAI_BASE_URL` —
and a runaway agent can never silently burn more than you allow.

## 5-minute setup (Docker)

```sh
# 1. Configure (or just use env vars)
cp config.example.yaml config.yaml

# 2. Run — the only secret is your upstream key
docker build -t agent-killswitch .     # installs from package-lock.json (npm ci)
docker run -d --name killswitch \
  -p 127.0.0.1:4020:4020 \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  -v "$PWD/data:/app/data" \
  agent-killswitch

# 3. Point any OpenAI client at it
export OPENAI_BASE_URL="http://127.0.0.1:4020/v1"
```

Works with LangChain, AutoGen, CrewAI, Vercel AI SDK, Cursor, and anything
else that speaks `/v1/chat/completions` — streaming included.

## The kill switch

```sh
# Stop all spend immediately (no upstream call is made after this)
touch ./data/.kill     # or: curl -X POST http://127.0.0.1:4020/kill

# Resume
rm ./data/.kill        # or: curl -X POST http://127.0.0.1:4020/reset
```

With the Docker setup above, `data/` is mounted from the host, so the
host-side `touch ./data/.kill` reaches the container.

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

It stops a **runaway** agent: a loop, a retry storm, a prompt that will not
end. It does not stop an **adversarial** one. Any local process that can
write the kill file's directory, or reach `127.0.0.1:4020` while the kill
API is on, can lift the kill with `rm` or `POST /reset`, and that includes
the agent itself. If the agent could act against you:

- run the proxy as a different user or in a container, with `data/` not
  writable by the agent;
- set `KILLSWITCH_KILL_API=false` so `/kill` and `/reset` are off (the file
  still works);
- keep the upstream key out of the agent's environment, or it can call
  upstream directly and skip the proxy.

## Configuration

YAML file plus env overrides (env wins). Copy `config.example.yaml` to
`config.yaml` and edit the limits:

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

Every decision — allowed or vetoed — appends one line to the JSONL ledger
with timestamp, model, token counts, `cost_usd`, `allowed`, `veto_reason`,
and `request_id`; allowed lines also carry `metered` (`usage` or
`held_estimate`). An allowed line is written when the call ends. Restart replays the last 48 h to rebuild the spend
windows; the ledger file is the source of truth.

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
`X-Payment-*` on 200 (stream and non-stream).

## Pricing notes

Costs use a static per-model table (`src/pricing.ts`, checked against
OpenAI's published prices). There are no live pricing fetches by design.
An **unknown model is billed at the most expensive known rate** (currently
o1 at **$15 input / $60 output per million tokens**) rather than rejected —
failing closed on cost beats failing open. That is why a free Nemotron call
logged `cost_usd` 0.001215 rather than $0.00: Nemotron is not in the table,
so the proxy assumed o1. The ledger shows exactly what was assumed.

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
