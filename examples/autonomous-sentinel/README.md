# twzrd-sentinel

An autonomous buyer that runs under a signed spend mandate
(`@twzrd1111/mandate`). It decides nothing about money: every limit is in
the mandate, and every refusal comes from the mandate runtime.

One cycle:

1. **Discover** paid tasks from the catalog (`GET /v1/intel/bazaar/offers`).
2. For each task the runtime **screens** the seller before anything is
   signed, takes a **budget hold**, lets **one payment** leave, **verifies**
   the V7 receipt under the pinned key and its inclusion in the receipt log,
   and **records** what was actually charged against what was quoted.
3. The decision ledger is **verified**, and the agent signs a **heartbeat**:
   `decisions`, `refusals`, `settledUsd`, `remainingBudgetUsd`,
   `ledgerHeadHash`.

## Run it

From the repository root, after `npm ci && npm run build`:

```bash
node examples/autonomous-sentinel/sentinel.mjs --verify-breakers
node examples/autonomous-sentinel/sentinel.mjs run --dir ./sentinel-state --cycles 1
```

The default is **loopback**: a seller, a trust service and a receipt log on
`127.0.0.1`, paid with a throwaway key. No wallet, no network, no money.
With no `mandate.json` in `--dir`, the agent creates a key and issues itself
a mandate (`self-mandated`). The loopback catalog holds two honest tasks and
three the mandate must refuse (a wash-flagged seller, a price over the
per-call cap, a 402 header that is not canonical base64):

```
 1  FREE                                         sig 0  Discover paid tasks from the catalog
 2  SETTLED 0.01 USDC                            sig 1  loopback lookup
 3  REFUSED layer 5 trust_gate_refused           sig 0  loopback wash-seller
 4  REFUSED layer 4 per_request_cap              sig 0  loopback over-cap
 5  REFUSED layer 6 payment_required_unreadable  sig 0  loopback bad-header
 6  SETTLED 0.02 USDC                            sig 1  loopback report
heartbeat 1: decisions 6, refusals 3, settled 0.03 USDC, left 0.47 this hour and 1.97 today, ledger ... verified
```

The receipt the loopback seller returns is a recorded production V7 receipt
with its recorded inclusion proof, so the receipt checks are the real ones.

`--verify-breakers` proves that each of the six pre-sign layers refuses with
zero signatures. `--record <file>` runs one scripted loopback session (the
cycle above, then a seller the mandate does not name, then the kill file)
and writes it as `twzrd.mandate.session.v1`.

## Under an operator's mandate

```bash
npx @twzrd1111/mandate init --daily 5.00 --min-trust 75 --tools http:127.0.0.1:4039
node examples/autonomous-sentinel/sentinel.mjs run --trust-issuer <issuer printed by init>
```

The sentinel refuses to start under a mandate that is expired, edited,
unsigned, signed by an operator it has not been told to trust, or written
for another agent's key.

## Live

```bash
node examples/autonomous-sentinel/sentinel.mjs run --live --mandate mandate.json            # dry run
node examples/autonomous-sentinel/sentinel.mjs run --live --mandate mandate.json --pay-module ./pay.mjs
```

`--live` uses the real catalog and trust service. Without `--pay-module` it
is a dry run: tasks are discovered and screened, the real 402 is read and
priced, and it is refused unpaid (`no_payer_configured`). With a pay module
(see the `@twzrd1111/mandate` README) it pays within the mandate. By default
it attempts one catalog offer, `twzrd_trust`, the route that answers with a
signed V7 receipt; `--tasks a,b` names others. Only plain `GET` offers are
attempted.

The paid live path has not been exercised: no funded wallet has been used
with this example. The dry run has been run against the production catalog.

## Stopping it

- `touch <state-dir>/.kill`, or `mandate kill --mandate mandate.json`. The
  loop idles: nothing is discovered, asked or signed, and the heartbeat
  keeps reporting. `mandate resume --mandate mandate.json` clears it.
- `--control-port <port>` serves `/mandate/status`, `/mandate/kill` and
  `/mandate/resume` on `127.0.0.1` for a running sentinel.
- `SIGTERM` finishes the cycle in progress and exits 0.

Exit codes: 0 stopped or cycles done; 1 the ledger or heartbeat did not
verify, or a breaker failed; 2 usage, or a mandate the agent will not start
under; 3 the mandate expired.

## As a service

- `deploy/twzrd-sentinel.service`: a systemd user unit. Copy it to
  `~/.config/systemd/user/`, set `SENTINEL_HOME` at the top, then
  `systemctl --user enable --now twzrd-sentinel`.
- `deploy/Dockerfile`: builds from the published package, so it works once
  `@twzrd1111/mandate` is on npm. It has not been built yet.

Both run loopback unless `--live` is added to the command.
