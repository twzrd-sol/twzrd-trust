# x402-heist

A rogue loopback x402 seller tries 21 tricks against an agent's wallet, guarded
by the **published `twzrd-x402-gate@0.28.1`** `createBuyerFetch`. The game prints
what reached the signer, who received a payment authorization, and the gate's
refusal reason. It exits zero only when both honest controls are paid, nothing
is robbed, no external fetch is attempted, and the expected results match.

**No keys to supply, no external network during play, and no USDC are involved.**
A throwaway viem key is generated in memory and discarded; every `signTypedData`
call is counted. The seller decodes signed authorizations and returns HTTP 200.
There is no RPC, facilitator, settlement or real transfer. “Paid” in the
scoreboard means the seller received an authorization, not an on-chain payment.

The trust stub **always allows everyone** (score 90, `can_spend: true`, recommended
spend 5 USDC, no wash flag). This tests only the gate's local checks and its
interaction with the pinned x402 client, not TWZRD's hosted seller screening.

## Run

Use Node 22 or newer, in this directory:

```sh
npm ci --ignore-scripts
node --import ./tripwire.mjs heist.mjs
npm test
```

The install downloads packages; the game and tests need only loopback. The
preload refuses non-loopback `fetch` destinations and records attempted escapes.
`TRIPWIRE_LOG` optionally names an append-only escape log. An OS network namespace
with no external connectivity provides an additional check below.

The lockfile pins `twzrd-x402-gate` 0.28.1, `@x402/core`, `@x402/evm`, and
`@x402/fetch` 2.32.0, and `viem` 2.58.4. This directory is not a root workspace;
root `npm run ci` does not run it. Copy the directory anywhere, install its
lockfile, and it runs without this repository or any private files.

## Rules

Every buyer has `maxPricePerCall: "0.01"`, `allowedRecipients: [HONEST]`, and
`hourlyBudgetCap: "0.03"`. HONEST is
`0x1111111111111111111111111111111111111111`; THIEF is
`0x7777777777777777777777777777777777777777`.

- **DEFENDED:** refused before signing, with zero signatures and authorizations.
- **CAPPED:** authorized payments to HONEST, each at most 0.01 USDC and together
  at most 0.03 USDC. This also labels the successful honest controls and decoy-pair.
- **ROBBED:** a seller receives an authorization exceeding those limits, to a
  different recipient, or for an unexpected network or asset. The game stops
  immediately and exits nonzero.

All HTTP servers bind `127.0.0.1` on port 0 and close at the end. Each trick has a
fresh temporary directory for decision and spend ledgers, removed in `finally`.
The drip variants make six sequential 0.009 USDC requests, including different
paths and fresh buyers sharing the same spend ledger. Three should be paid
(0.027 USDC), and three refused. Every offer keeps `maxTimeoutSeconds: 60`.

## Recorded scoreboard

Recorded from the standalone copy on Node 24.22.1. Node 22.23.5 with
`--network none` produced the same verdicts, counts, amounts and reasons.

```text
x402-heist | Node v24.22.1 | twzrd-x402-gate 0.28.1
trick                verdict   signatures  payments  USDC       recipient  reason
honest               CAPPED    1           1         0.005000   HONEST     paid
lowercase-ok         CAPPED    1           1         0.005000   HONEST     paid
gouge                DEFENDED  0           0         0.000000   -          price_cap_exceeded
swap-payto           DEFENDED  0           0         0.000000   -          unauthorized_recipient
fake-asset           DEFENDED  0           0         0.000000   -          core_spend_controls
chain-hop            DEFENDED  0           0         0.000000   -          core_spend_controls
testnet-usdc         DEFENDED  0           0         0.000000   -          core_spend_controls
decoy-pair           CAPPED    1           1         0.005000   HONEST     paid
decoy-reverse        DEFENDED  0           0         0.000000   -          unauthorized_recipient
split-brain          DEFENDED  0           0         0.000000   -          unauthorized_recipient
amount-exponent      DEFENDED  0           0         0.000000   -          payment_client_refused
amount-hex           DEFENDED  0           0         0.000000   -          payment_client_refused
amount-leading-zero  DEFENDED  0           0         0.000000   -          price_cap_exceeded
amount-fraction      DEFENDED  0           0         0.000000   -          core_spend_controls
amount-negative      DEFENDED  0           0         0.000000   -          amount_malformed
amount-overflow      DEFENDED  0           0         0.000000   -          core_spend_controls
space-payto          DEFENDED  0           0         0.000000   -          unauthorized_recipient
redirect             DEFENDED  0           0         0.000000   -          request_failed
drip                 CAPPED    3           3         0.027000   HONEST     hourly_budget_exceeded
drip-paths           CAPPED    3           3         0.027000   HONEST     hourly_budget_exceeded
drip-agents          CAPPED    3           3         0.027000   HONEST     hourly_budget_exceeded
HONEST = 0x1111111111111111111111111111111111111111
Tripwire hits: 0
Expectation differences: none
ROBBED: 0
```

The leading-zero integer is still over the price cap. The other amount spellings
exercise parsing and the client's spend controls. Header/body disagreement and
offer ordering are intentional; the example does not rewrite or fix the gate.

## Verification without networking

After installing, with the Node 22 image already available locally, run from a
copy outside the repository:

```sh
docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$PWD:/game:ro" -w /game node:22-slim \
  sh -c 'npm test && node --import ./tripwire.mjs heist.mjs'
```

Loopback still works with `--network none`; external networking does not. The
child-process test asserts all 21 rows, both paid controls, zero signatures on
every DEFENDED trick, the three capped drip totals, zero tripwire hits, and no
leftover ledger directories. A separate test proves the tripwire rejects and
records a non-loopback URL without connecting to it.

## Add a trick

Add one entry to `tricks` in `heist.mjs`; `challenge(url)` returns an x402 document
for `header` and, optionally, a different `body`. Encoding happens in the seller.
For example:

```js
{ id: "another-gouge", title: "Another high price",
  challenge: url => ({ header: document(url, [offer({ amount: "20000" })]) }) },
```

Omitted `body` repeats the header document. Keep the timeout at 60 seconds.
Add the ID to the test's scenario list and rerun both the test and game. New
tricks default to an expected zero-signature refusal. If a trick gets a payment
past the limits, keep the reproduction private and report it to the maintainer
before proposing a public change.
