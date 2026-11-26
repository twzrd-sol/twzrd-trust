# `twzrd.mandate.v1`

A mandate is one signed JSON document that states what an agent runtime may
spend, on what, with whom, and where its stop switch lives. The runtime
(`@twzrd1111/mandate`) refuses to operate on a mandate it cannot verify.

This file is the normative description. `src/schema.ts` is the
implementation; `test/mandate.test.mjs` holds the vectors. The JSON Schema
(`schema/twzrd.mandate.v1.schema.json`, `$id` `urn:twzrd:schema:mandate:v1`)
describes the shape; the cross-field rules below are enforced in code.

## Document

```json
{
  "schema": "twzrd.mandate.v1",
  "mandateId": "mnd_6f1d2c9a0b7e4f538a1c2d3e4f5a6b7c",
  "issuerMode": "human-operator",
  "issuer": "<base58 Ed25519 public key, 32 bytes>",
  "agent": "<base58 Ed25519 public key, 32 bytes>",
  "issuedAt": "2026-11-17T08:00:00Z",
  "expiresAt": "2026-12-17T08:00:00Z",
  "limits": {
    "maxPerCallUsd": "0.05",
    "hourlyCeilingUsd": "1.00",
    "dailyCeilingUsd": "5.00",
    "monthlyCeilingUsd": "50.00"
  },
  "allowedChains": ["solana", "base"],
  "minTrustScore": 75,
  "allowedCounterparties": [],
  "blockedCounterparties": [],
  "allowedTools": ["http:intel.twzrd.xyz", "mcp:evaluate_x402_resource"],
  "requireV7Receipt": false,
  "requireMerkleInclusion": false,
  "killswitchDir": "./.twzrd-mandate",
  "signature": {
    "alg": "ed25519",
    "publicKey": "<same value as issuer>",
    "value": "<base64, 64 bytes>"
  }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `schema` | yes | exactly `twzrd.mandate.v1` |
| `mandateId` | yes | `mnd_` followed by 32 lowercase hex characters |
| `issuerMode` | yes | `human-operator`, `self-mandated` or `ephemeral-session` |
| `issuer` | yes | base58 Ed25519 public key (32 bytes) that signed the document |
| `agent` | yes | base58 Ed25519 public key of the agent runtime the mandate is for |
| `issuedAt`, `expiresAt` | yes | `YYYY-MM-DDTHH:MM:SSZ`, UTC, whole seconds; `expiresAt` is after `issuedAt` |
| `task` | `ephemeral-session` only | 1 to 200 characters; forbidden in the other modes |
| `limits.maxPerCallUsd` | yes | decimal string, at most 6 places |
| `limits.hourlyCeilingUsd` | no | decimal string; enforced as the daily ceiling when absent |
| `limits.dailyCeilingUsd` | yes | decimal string |
| `limits.monthlyCeilingUsd` | no | decimal string |
| `allowedChains` | yes | non-empty, no duplicates, each `solana` or `base` (mainnet only) |
| `minTrustScore` | yes | integer 0 to 100 |
| `trustScreen` | no | `"on"` (default) or `"off"`; off skips the layer-5 preflight and records a `trust_screen_off` control line — fail-open, operator's explicit choice |
| `allowedCounterparties` | no | when non-empty, only these recipients may be paid |
| `blockedCounterparties` | no | recipients that are never paid |
| `allowedTools` | yes | non-empty list of exact tool names; there is no wildcard |
| `requireV7Receipt` | yes | boolean |
| `requireMerkleInclusion` | yes | boolean; `true` requires `requireV7Receipt: true` |
| `killswitchDir` | yes | state directory; absolute, or relative to the mandate file |
| `signature` | yes | see Signature |

Any other member, at any level, makes the document malformed. `null` is
never a valid value. Amounts are strings so that no binary rounding enters
the signed bytes; the order `maxPerCallUsd <= hourlyCeilingUsd <=
dailyCeilingUsd <= monthlyCeilingUsd` must hold for the members present.

## Issuer modes

| Mode | Who signs | Extra rules |
| --- | --- | --- |
| `human-operator` | a human's key | `issuer` differs from `agent`; lifetime at most 366 days |
| `self-mandated` | the agent's own key | `issuer` equals `agent`; lifetime at most 366 days |
| `ephemeral-session` | either | `task` is required; lifetime at most 24 hours, so the daily ceiling is the whole envelope |

A signature proves which key signed. It does not say that key is one you
trust. The runtime therefore needs a pin as well:

- `human-operator` and an `ephemeral-session` signed by someone other than
  the agent: the issuer must be on the runtime's trusted-issuer list
  (`--trust-issuer`, `TWZRD_MANDATE_TRUSTED_ISSUERS`). No list, no service.
- `self-mandated` and an `ephemeral-session` the agent signed itself: the
  runtime must hold the agent key named in the mandate (`--agent-key`).
  When the runtime pins any operator issuer, a mandate the agent signed for
  itself is refused (`mandate_issuer_untrusted`) unless the agent key is
  itself pinned or the operator passes `--allow-self-mandate`
  (`allowSelfMandate`). An operator who pins issuers decides what the agent
  may spend; the agent cannot step around that by signing its own mandate.

## Signature

The signed bytes are the UTF-8 encoding of

```
TWZRD:MANDATE_V1\n<canonical JSON of the document without "signature">
```

Canonical JSON is the form `twzrd-x402-gate` uses for decision tokens:
object keys in code-unit order, no insignificant whitespace, arrays in
order. `signature.publicKey` must equal `issuer`; `signature.value` is the
64-byte Ed25519 signature in standard padded base64, and it must be the
canonical encoding of those bytes.

## Verification outcomes

`verifyMandate` returns `{ ok: true, mandate }` or `{ ok: false, code,
detail }`. It never throws on a bad document. Codes:

| Code | Meaning |
| --- | --- |
| `mandate_malformed` | not an object, an unknown or missing member, a value of the wrong type or range, a rule in the tables above broken |
| `mandate_unsigned` | no `signature` member |
| `mandate_signature_invalid` | the signature does not verify over the document as given |
| `mandate_issuer_untrusted` | the signature verifies but the issuer is not pinned as described above |
| `mandate_not_yet_valid` | `issuedAt` is more than 300 seconds in the future |
| `mandate_expired` | the current time is at or after `expiresAt` |

The runtime checks expiry again before every call, after the trust lookup,
before the 402 is handed to the payer, and before a payment-bearing request
is sent. A mandate that expires while a call is in flight stops that call.

## What each member enforces

| Member | Enforced by | When |
| --- | --- | --- |
| `allowedTools` | `createToolGuard` (`@twzrd1111/agent-killswitch`) | before the call is forwarded |
| `maxPerCallUsd`, hourly and daily ceilings | `createToolGuard`: an atomic hold on the shared hash-chained spend ledger | before the 402 reaches the signer |
| `maxPerCallUsd`, daily and monthly ceilings | `createTwzrdPolicyFetch` (`twzrd-x402-gate`) on its own file ledger | before the 402 reaches the signer |
| `allowedChains`, counterparties | the mandate runtime, on the quoted offer and again on the 402 handed to the signer | before the signer |
| `minTrustScore`, wash screen | `twzrdApprovePayment` (`twzrd-x402-gate`), free preflight | before the signer |
| `killswitchDir` | `.kill` and `.pause` are read by the guard, the gate and the runtime | every step |
| `requireV7Receipt` | `verifyReceiptBinding` under the pinned issuer key, no key fetch | after the paid response, before it is handed to the agent |
| `requireMerkleInclusion` | `twzrd-log-verifier` under the pinned log key | after the receipt check |

A receipt requirement is checked after payment: a seller is paid before it
can return anything. When a required receipt is missing, does not verify
under the pinned key, is about a wallet this call did not name (neither the
paid recipient nor a wallet named as a path segment of the request URL; the
query string is not read), is older than the runtime accepts, repeats a
receipt this state directory already accepted, or is not proven in the log,
the runtime withholds the response from the agent, records the violation,
and writes `.pause`, so nothing more is spent until an operator resumes. The
key a receipt names for itself is ignored; only the pinned key is tried, and
no key is ever fetched.

Receipt age is measured against the receipt's signed `timestamp_unix`:
older than 900 seconds (`receiptMaxAgeSeconds`, `--receipt-max-age`), or
more than 300 seconds in the future, is refused. Each accepted receipt's
leaf is appended to `receipt-leaves.txt` in the state directory before the
response is handed over, and a receipt whose leaf is already there is
refused, across restarts. The package's loopback seller answers every paid
call with one fixed, signed fixture receipt, so the loopback rigs, the
sentinel's loopback mode and `serve --receipt-max-age off
--allow-receipt-replay` turn both checks off, and say so; nothing else
should.

A pause written by the runtime after a violation lasts until the mandate
expires (`tripPauseMs` shortens it). Only `resume`, with the control token,
lifts it sooner.

## Pre-sign refusal layers

Every refusal below happens with zero payment signatures. `mandate
verify-breakers` proves each on loopback.

| Layer | Refusal codes |
| --- | --- |
| 1 Mandate integrity | `mandate_expired`, `mandate_signature_invalid`, `mandate_unsigned`, `mandate_malformed`, `mandate_issuer_untrusted` |
| 2 Halt switches | `kill_switch`, `payment_gate_halt` |
| 3 Tool allow-list | `tool_not_allowed` |
| 4 Spend caps | `per_request_cap`, `budget_exceeded`, `monthly_ceiling_exceeded`, `duplicate_purchase` (same method, url, body, payTo, amount, network inside 60 s) |
| 5 Trust screen | `chain_not_allowed`, `counterparty_blocked`, `counterparty_not_allowed`, `trust_gate_refused` (wash flag, score below `minTrustScore`, intel block or outage). `trust_screen_off` is a control line, not a refusal: the screen was skipped by operator choice |
| 6 Challenge integrity | `payment_required_unreadable`, `unpriced_offer`, `offer_changed_after_approval`, `no_payer_configured` |

A refusal is one of these codes at one of these layers, and the ledger line
for it carries `signatures: 0`. Two layer-4 codes are reached only after
earlier spend: `budget_exceeded` and `monthly_ceiling_exceeded` are refused
with no signature for the refused call.

## Tool names

`allowedTools` holds exact names. The runtime derives the name of a call
from how it arrives; an agent does not choose it.

| Route | Tool name |
| --- | --- |
| `/pay/<absolute-url>` and the forward proxy | `http:<host>` or `http:<host>:<port>` when the URL names a port |
| `/mcp` `tools/call` | `mcp:<tool name>` |
| `/v1/*` | `inference` |

## One paid call

1. Layers 1 to 3 are checked. Nothing has been sent.
2. The runtime sends the request with no payment. A 2xx is a free call and
   passes through. A 402 is read strictly: the `PAYMENT-REQUIRED` header
   must be canonical base64 of UTF-8 JSON, or the body must be a JSON
   challenge. Anything else, an MPP (`WWW-Authenticate: Payment`) challenge
   included, is `payment_required_unreadable`.
3. Each offer is priced. Only an exact-amount USDC offer on Solana mainnet
   or Base mainnet has a price. The cheapest offer that passes the chain and
   counterparty lists and the per-call cap is the approved offer.
4. A hold for the approved amount is taken (layer 4).
5. The trust lookup runs (layer 5).
6. The payer is handed a 402 that carries the approved offer and no other.
   If the seller's next 402 no longer carries that offer at that price or
   less, the call is refused (`offer_changed_after_approval`).
7. Just before the payment-bearing request leaves, the signed amount is
   written to the spend ledger (it counts in the hour, day and month windows
   from then on) and a `pending` line is written to the decision ledger,
   both to disk. If either write fails, nothing is paid
   (`spend_record_failed`).
8. At most one payment-bearing request leaves, to the call's own URL. There
   is no fallback route and no second payment. An `x-payment`,
   `payment-signature` or `Authorization: Payment ...` header the agent
   sent is dropped first: only the payer pays.
9. The amount recorded is always the signed amount. A settlement header that
   names a different amount, cannot be read or reports failure, or a seller
   that answers non-2xx after taking the payment, pauses spending
   (`settlement_tripped`, `paid_call_failed`). What a seller reports never
   lowers the recorded spend.
10. Receipt and inclusion are checked when the mandate requires them.

If the process dies after step 7, the next runtime to open the state
directory finds the `pending` line no later line answers, records it as a
`violation` (`payment_unresolved`) at the signed amount, and pauses.

The seller therefore sees up to three requests for one paid call: the
runtime's unpaid request, the payer's unpaid request, and the paid request.

Codes outside the six layers, for calls that are not clean refusals:

| Code | Outcome | Meaning |
| --- | --- | --- |
| `paid_call_failed` | `violation` | a payment left and the seller did not answer 2xx; spending is paused |
| `settlement_tripped` | `violation` | the settlement header names an amount other than the one signed, cannot be read, or reports failure; the signed amount is recorded and spending is paused |
| `spend_record_failed` | `refused` or `violation` | the spend ledger, the decision ledger or the receipt-leaf file could not be written; before the payment, nothing is paid; after it, spending is paused |
| `payment_unresolved` | `violation` | a `pending` payment found unanswered when the runtime opened the state directory; spending is paused |
| `receipt_missing`, `receipt_invalid`, `inclusion_unproven` | `violation` | see above; the response is withheld |
| `payment_not_made` | `refused` | the pay module returned the 402 without paying it |
| `second_payment_refused` | `refused` or `violation` | the payer tried to send a second payment for one call |
| `upstream_error`, `bad_target` | `error` | the target could not be reached, is not an http(s) URL, or carries credentials in the URL; nothing was signed |
| `connect_not_supported` | `refused` | an https `CONNECT` through the forward proxy; the proxy cannot read it, so cannot govern it |

## Sidecar

`mandate serve` listens on loopback only (default `127.0.0.1:4029`). A
request with an `Origin` header, a `Sec-Fetch-Site` other than `none`, or a
`Host` that is not the sidecar's own loopback address is refused with 403,
so a web page in the operator's browser cannot drive it.

| Route | What it does |
| --- | --- |
| `GET /health` | liveness, the mandate id, `expired`, `halted` |
| `GET /mandate/status` | `twzrd.mandate.status.v1`: the mandate, halt state, spend and remaining budget, counters, ledger head, last heartbeat |
| `GET /mandate/ledger?limit=N` | `twzrd.mandate.ledger.v1`: the last N decision lines and whether the chain verifies |
| `GET /mandate/heartbeat` | the last signed heartbeat |
| `POST /mandate/heartbeat` | sign one now; needs the control token and the agent key |
| `POST /mandate/kill` | write `.kill`; needs no token |
| `POST /mandate/resume` | remove `.kill` and `.pause`; needs `Authorization: Bearer <control token>` |
| `POST /mcp` (and `GET`, `DELETE`) | the MCP proxy; 503 without `--mcp-upstream` |
| `ANY /pay/<absolute-url>` | one governed HTTP call to that URL |
| `ANY /v1/*` | the OpenAI-compatible route, metered by `@twzrd1111/agent-killswitch`; 503 without `--upstream` |
| absolute-form request line | the sidecar as `HTTP_PROXY` for `http://` targets; `CONNECT` is refused |

The control token is 32 random bytes, written with mode 0600 to
`control.token` in the state directory when the sidecar starts. The agent
talks to the sidecar's port, so resuming needs something the port does not
give out; stopping needs nothing.

On `/mcp`, a `tools/call` is a governed call. A paid MCP tool is one that
answers with an x402 payment-required tool result; the proxy pays it in
band through `_meta["x402/payment"]`. A `tools/call` that carries its own
payment, or that is sent inside a batch, is refused. A refusal comes back
as a tool result with `isError: true` and
`structuredContent.twzrd_mandate = { outcome, layer, code, detail, signatures }`.
Every other MCP message passes through unless the mandate has expired or is
halted.

The proxy forwards the message it parsed, re-serialized, never the bytes
that arrived, so a duplicate key reaches the upstream the way the proxy read
it. A message (or batch) with two keys in one object that differ only in
case, or an envelope or `params` key spelled in another case (`"Method"`,
`"Name"`, `"argumentſ"`), is refused with JSON-RPC error `-32600`
before anything is forwarded: some MCP servers match field names without
regard to case, and would read a different method or tool from it.

## Decision ledger

`mandate-ledger.jsonl` in the state directory holds one line per decision
(`twzrd.mandate.decision.v1`). Each line carries `seq`, `at`, `mandateId`,
`prev` (SHA-256 of the previous line, `genesis` for the first), the tool
and target (query string and credentials removed), `outcome`, `layer`,
`code`, `detail` (every URL in it cut to scheme, host and path), `quotedUsd`,
`settledUsd`, `signatures`, `payTo`, `receipt`, `inclusion` and `ref` (the
`seq` of the `pending` line this line answers, or null).

| Outcome | Meaning |
| --- | --- |
| `pending` | a payment is about to leave; the call's own outcome line follows and names it in `ref` |
| `free` | the call cost nothing and was passed through |
| `settled` | one payment was made and every post-payment check passed |
| `refused` | stopped before any payment; `signatures` is 0 |
| `violation` | a payment was made and a post-payment check failed; spending is paused |
| `forwarded` | a `/v1` request was admitted and handed to the meter, which keeps its own spend line |
| `control` | a kill, a resume, or a pause written by the runtime |

Editing, removing or reordering a line breaks the chain. The chain is
unkeyed, so someone who can write the state directory can rewrite every
line and recompute every hash; the signed heartbeat is what pins it. A
runtime refuses to open a state directory whose ledger no longer contains
the head the last heartbeat (`heartbeat.json`) signed, or records fewer
decisions or less settled spend than that heartbeat did. Keep heartbeats
somewhere the agent cannot write as well, to catch a deleted one.

## Limits of 0.1.0

- MPP challenges are refused, not settled.
- The payer is a module the operator supplies (`--pay-module`). This
  package holds no wallet key and has not been run against a funded wallet.
- In-band MCP payment follows the x402 MCP transport document and has been
  run only against the package's own loopback MCP server.
- The `/v1` meter is an `agent-killswitch` process on a loopback port. It
  answers only requests that carry the per-start token the sidecar holds
  (`x-twzrd-meter-token`), and it is not started unless `inference` is in
  `allowedTools`. `/v1` requests are on the meter's spend ledger, not the
  decision ledger.
- `/v1` holds live in the meter's process and tool-call holds in the
  runtime's. Settled spend is shared through the one spend ledger; two
  calls in flight at the same moment, one on each side, can together pass a
  window ceiling by at most the amounts in flight.
- The monthly ceiling covers paid tool calls. `/v1` spend is bounded by the
  per-call, hourly and daily ceilings.
- An https target through `HTTP_PROXY` cannot be governed; use `/pay/<url>`.

## Related documents

- `twzrd.mandate.heartbeat.v1`: a signed statement of a runtime's counters
  and ledger head (`src/heartbeat.ts`).
- `twzrd.mandate.session.v1`: a recorded session, as `twzrd-sentinel
  --record` writes it (`examples/autonomous-sentinel`).
