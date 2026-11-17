# @twzrd1111/mandate

A mandate is one signed JSON file that says what an agent may spend, on
what, with whom, and where its stop switch is. This package issues
mandates and runs a loopback sidecar that enforces one: every paid call an
agent makes through it is checked against the mandate before anything is
signed.

It is built on `twzrd-x402-gate` (trust check and payment policy),
`@twzrd1111/agent-killswitch` (budget holds and the kill switch) and
`twzrd-log-verifier` (receipt log inclusion). It holds no wallet key.

## Start

```bash
npx @twzrd1111/mandate init --daily 5.00 --min-trust 75
npx @twzrd1111/mandate serve --trust-issuer <issuer printed by init> \
  --mcp-upstream https://intel.twzrd.xyz/mcp
```

`init` writes `mandate.json` and two key files, `operator.json` and
`agent.json` (mode 0600), and prints the `serve` line with the issuer
filled in. `serve` listens on `http://127.0.0.1:4029` and refuses to start
on a mandate it cannot verify.

Without `--tools`, a mandate allows `http:intel.twzrd.xyz` and four TWZRD
trust tools over MCP (`evaluate_x402_resource`, `get_merchant_card`,
`get_readiness_card_tool`, `verify_receipt`). Name anything else the agent
may call: `--tools mcp:<tool>,http:<host>,inference`.

Point an agent at it:

```bash
claude mcp add --transport http twzrd-mandate http://127.0.0.1:4029/mcp
```

```json
{ "mcpServers": { "twzrd-mandate": { "type": "http", "url": "http://127.0.0.1:4029/mcp" } } }
```

For a client that only speaks stdio:

```json
{ "mcpServers": { "twzrd-mandate": { "command": "npx", "args": ["@twzrd1111/mandate", "mcp-stdio", "--sidecar", "http://127.0.0.1:4029"] } } }
```

`/mcp` answers 503 until `serve` is given `--mcp-upstream <url>` or
`--mcp-upstream-cmd "<command>"`.

An agent that issues its own mandate:

```bash
npx @twzrd1111/mandate self-issue --agent-key ./agent.json --daily 2.00
npx @twzrd1111/mandate serve --agent-key ./agent.json
```

Check the six refusal layers on your own machine, with no wallet and no
network:

```bash
npx @twzrd1111/mandate verify-breakers
```

## What a mandate holds

| Member | Meaning |
| --- | --- |
| `issuerMode` | `human-operator`, `self-mandated` or `ephemeral-session` |
| `limits.maxPerCallUsd`, `hourlyCeilingUsd`, `dailyCeilingUsd`, `monthlyCeilingUsd` | spend caps, as decimal strings |
| `allowedChains` | `solana`, `base` (mainnet USDC only) |
| `minTrustScore` | lowest TWZRD trust score a seller may have, 0 to 100 |
| `allowedCounterparties`, `blockedCounterparties` | recipients that may, or may never, be paid |
| `allowedTools` | exact tool names; there is no wildcard |
| `requireV7Receipt`, `requireMerkleInclusion` | a paid answer must carry a verifying receipt, proven in the log |
| `expiresAt` | after this, nothing is forwarded or paid |
| `killswitchDir` | the state directory: `.kill`, `.pause`, the ledgers |

An expired, edited, unsigned or malformed mandate stops the runtime. The
format, the signature and every rule are in [SPEC.md](./SPEC.md); the JSON
Schema is exported as `@twzrd1111/mandate/schema`.

Tool names are derived by the sidecar, not chosen by the agent:
`http:<host>` (or `http:<host>:<port>`) for a paid HTTP call, `mcp:<tool>`
for an MCP tool, `inference` for the `/v1` route.

## The sidecar

| Route | Use |
| --- | --- |
| `/mcp` | MCP proxy (Streamable HTTP) in front of any MCP server. `tools/call` is checked against the mandate; a tool that asks for an x402 payment is paid in band, within the mandate. |
| `/pay/<absolute-url>` | one governed HTTP call. A 402 is priced, screened and paid within the mandate. |
| `/v1/*` | an OpenAI-compatible route metered by `@twzrd1111/agent-killswitch`. Set the client's base URL to `http://127.0.0.1:4029/v1`; no SDK change. Needs `--upstream` and `inference` in `allowedTools`. |
| as `HTTP_PROXY` | governs plain `http://` targets. An https `CONNECT` is refused, because the proxy cannot read it; use `/pay/<url>` for https. |
| `/health`, `/mandate/status`, `/mandate/ledger`, `/mandate/heartbeat` | read-only state |
| `POST /mandate/kill` | stop now. Needs no token. |
| `POST /mandate/resume` | clear `.kill` and `.pause`. Needs the control token. |

The same controls from the command line: `mandate status`, `mandate
ledger --verify`, `mandate kill`, `mandate resume`. `touch
.twzrd-mandate/.kill` also stops it.

The sidecar binds loopback only and refuses requests that carry an
`Origin`, a cross-site `Sec-Fetch-Site`, or a `Host` other than its own
address, so a web page cannot drive it. The agent can reach the sidecar's
port, so resume is gated on a token written to `control.token` (mode 0600)
in the state directory; `mandate resume` reads it for you.

## Paying

The sidecar never holds a key. Payment is a module you supply:

```js
// pay.mjs
import { wrapFetchWithPayment } from "@x402/fetch";
import { client } from "./my-x402-client.mjs"; // your x402 client, with your signer registered

export const wrapPay = (guarded) => wrapFetchWithPayment(guarded, client);
```

```bash
npx @twzrd1111/mandate serve --agent-key ./agent.json --pay-module ./pay.mjs
```

`wrapPay` receives a fetch that the mandate already governs and returns a
fetch that pays a 402. The payer only ever sees a 402 that carries the one
approved offer, and at most one payment-bearing request leaves per call.
Without `--pay-module`, every 402 is refused with `no_payer_configured`.

## Before anything is signed

| Layer | Refuses when |
| --- | --- |
| 1 Mandate integrity | the mandate is expired, edited, unsigned, malformed, or its issuer is not pinned |
| 2 Halt switches | `.kill` or `.pause` is present |
| 3 Tool allow-list | the tool is not named in `allowedTools` |
| 4 Spend caps | the price is over the per-call cap, or would pass the hourly, daily or monthly ceiling |
| 5 Trust screen | the chain or recipient is not allowed, the seller is wash-flagged or below `minTrustScore`, or the trust service cannot be reached |
| 6 Challenge integrity | the 402 cannot be read strictly, has no USDC price, changed after approval, or there is no payer |

A refusal is HTTP 403 with
`{ "error": { "type": "twzrd_mandate_refused", "layer", "code", "detail", "signatures": 0, "mandateId", "ledgerSeq" } }`;
on `/mcp` it is a tool result with `isError: true` and the same fields
under `structuredContent.twzrd_mandate`.

## After a payment

- The spend is written to disk, at the signed amount, before the payment
  leaves, together with a `pending` ledger line. A sidecar that dies
  mid-payment finds that line when it next starts, records the payment and
  pauses.
- The amount recorded is always the signed amount. If the seller's
  settlement header names a different amount, cannot be read or reports
  failure, or the seller answers non-2xx after being paid, spending is
  paused as well.
- With `requireV7Receipt`, the answer must carry a V7 receipt that
  verifies under the pinned TWZRD key, is about the wallet paid (or a
  wallet named in the request path), was signed in the last 900 seconds
  (`--receipt-max-age`), and has not been accepted for an earlier call. No
  key is fetched; the key a receipt names for itself is ignored.
- With `requireMerkleInclusion`, the receipt must also be proven in the
  receipt log under the pinned log key.
- When a check fails after payment, the answer is withheld from the
  agent, the violation is recorded, and spending is paused until an
  operator resumes (or the mandate ends).

Every decision (free, settled, refused, violation, control, and the
`pending` line before each payment) is one line in `mandate-ledger.jsonl`,
hash-chained to the line before it. `mandate ledger --verify` checks the
chain. A sidecar will not start on a ledger that no longer contains the head
its last signed heartbeat named. `serve --heartbeat <seconds>` signs a
`twzrd.mandate.heartbeat.v1` statement of the counters, remaining budget
and ledger head with the agent key.

## Library

```js
import { createMandateRuntime, issueMandate, loadKeyFile, startSidecar, verifyMandate, verifyBreakers, VERSION } from "@twzrd1111/mandate";
```

`createMandateRuntime` is the enforcement core the sidecar uses;
`startSidecar` is the HTTP surface; `verifyBreakers` returns the breaker
report as data. Types ship with the package.

## Limits of 0.1.0

- MPP challenges are refused, not settled. x402 exact-amount USDC on
  Solana and Base is the only payment this version makes.
- It has not been run against a funded wallet. The tests and
  `verify-breakers` use a loopback seller, a loopback trust service and a
  payer that signs nothing of value.
- In-band MCP payment has been run only against the package's loopback
  MCP server.
- A seller sees up to three requests for one paid call: the sidecar's
  unpaid request, the payer's unpaid request, and the paid request.
- `/v1` spend is held in the meter's process and tool-call spend in the
  sidecar's. Settled spend is shared through one ledger; two calls in
  flight at the same moment, one on each side, can together pass a ceiling
  by at most the amounts in flight.
- The monthly ceiling covers paid tool calls; `/v1` is bounded by the
  per-call, hourly and daily ceilings. `/v1` requests are on the meter's
  spend ledger, not the decision ledger.
- Pinning an operator issuer (`--trust-issuer`) turns self-signed mandates
  off unless `--allow-self-mandate` is given.
- One sidecar per state directory. A second one is refused.

## Develop

From the repository root (the package is a workspace):

```bash
npm ci
npm run build
npm test --workspace=@twzrd1111/mandate
npm run pack-smoke --workspace=@twzrd1111/mandate
```

MIT.
