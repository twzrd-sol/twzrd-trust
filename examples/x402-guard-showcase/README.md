# x402 guard showcase: Base USDC and Solana USDC

Three acts in one command. An agent buys from an x402 seller on Base USDC and on
Solana USDC through `twzrd.safeFetch` from the published `twzrd-x402-gate`. Each
purchase's result from the gate is checked against what the signer and the
seller actually saw.

| Act | What happens | What the run checks |
|---|---|---|
| 1. ALLOW | A clean seller is paid on both rails. Then a signed V7 receipt is checked offline: as issued, with its score edited, and with its freshness window extended. | `signerInvocations: 1` and one paid request per rail. The receipt verifies as issued and both edited copies fail. No connection is opened during the receipt check. |
| 2. BLOCK | On both rails: a flagged seller, a price over the cap, and a token that is not USDC. | `signerInvocations: 0` each time. The signer is never called, the seller is never paid, and the budget is untouched. |
| 3. KILL | `./data/.kill` is written while one purchase per rail waits on the seller check. Then 50 more purchases per rail run with the file present. Then the file is removed. | Both in-flight purchases are refused before the signer. All 100 later purchases are refused on entry, before any request reaches the seller. Payments resume once the file is gone. |

It needs no key, wallet, account or USDC. The seller runs on 127.0.0.1 in the
same process, and the run refuses any connection other than TCP to 127.0.0.1 or
::1.

## Run it

Node 22 or later.

```bash
cd examples/x402-guard-showcase
npm ci
npm run showcase
npm test
```

`npm ci` installs `twzrd-x402-gate` 0.22.0, `twzrd-receipt-verifier` 1.4.4 and
their dependencies from the npm registry, pinned by `package-lock.json` (seven
packages, no install scripts). After the install nothing here uses the network.

On 2026-11-15 both the tests (8/8) and the showcase (PASS 23/23) passed on Node
24.22.1. They passed again on Node 22.23.5 in a container with networking
disabled (`--network none`). To repeat that, install first, then run `npm test`
and `node showcase.mjs` in any sandbox with networking off.

Exit codes:

- `0`: every check passed.
- `1`: a check failed (listed under `RESULT`), or the run hit an unexpected error.
- `2`: the run refused to start and changed nothing.

`node showcase.mjs --data-dir <dir>` puts the `.kill` and the transcript in
`<dir>` instead of `./data`.

## Output

This is one run on Node 24.22.1. The port and the timings change from run to run
and from machine to machine.

```text
x402 guard showcase   twzrd-x402-gate 0.22.0   twzrd-receipt-verifier 1.4.4   node v24.22.1
seller  http://127.0.0.1:37883 (loopback, settles nothing)
signer  demo: holds no key, builds no transaction
budget  0.10 USDC per call and in total, both rails
kill    ./data/.kill

ACT 1  ALLOW
  rail         shop   verdict  signerInvocations  seller saw
  Base USDC    /good  allow    1                  402, then 1 paid request (200)
  Solana USDC  /good  allow    1                  402, then 1 paid request (200)
  V7 receipt (fixtures/intel-receipt-v7.json) checked offline: twzrd-receipt-verifier, key twzrd-receipt-ed25519-v2 Ak5SQw...HzvS
    as issued               VALID    subject GFpLvo...e1Gs  score 67  issued 2026-11-14
    score +1                INVALID  leaf mismatch: preimage does not hash to receipt.leaf
    fresh for 30 more days  INVALID  leaf mismatch: preimage does not hash to receipt.leaf
    connections opened during the check: 0

ACT 2  BLOCK
  rail         shop          verdict  reason          signerInvocations  seller check  seller saw
  Base USDC    /flagged      block    intel_block     0                  asked         402 only, 0 paid
  Base USDC    /pricey       block    over_max_spend  0                  not reached   402 only, 0 paid
  Base USDC    /wrong-asset  block    non_usdc_asset  0                  not reached   402 only, 0 paid
  Solana USDC  /flagged      block    intel_block     0                  asked         402 only, 0 paid
  Solana USDC  /pricey       block    over_max_spend  0                  not reached   402 only, 0 paid
  Solana USDC  /wrong-asset  block    non_usdc_asset  0                  not reached   402 only, 0 paid
  budget spent by refusals: 0.00 USDC

ACT 3  KILL  ./data/.kill
  in flight: one purchase per rail waiting on the seller check when .kill was written
  Base USDC    /good  block  twzrd_kill_switch  signerInvocations 0  seller paid 0  refused 0.178 ms after .kill
  Solana USDC  /good  block  twzrd_kill_switch  signerInvocations 0  seller paid 0  refused 0.179 ms after .kill
  halted: 50 more purchases per rail with .kill present
  Base USDC    50/50 refused on entry  signer calls 0  seller requests 0  p50 0.006 ms  max 0.026 ms
  Solana USDC  50/50 refused on entry  signer calls 0  seller requests 0  p50 0.006 ms  max 0.012 ms
  sub-millisecond halt: yes
  resumed: .kill removed (this run wrote it)
  Base USDC    /good  allow  signerInvocations 1  seller paid 1
  Solana USDC  /good  allow  signerInvocations 1  seller paid 1

RESULT  PASS  23/23 checks
  demo signer calls 4, gate signerInvocations 4, seller paid requests 4 (Base USDC 2, Solana USDC 2)
  budget used 0.04 of 0.10 USDC (demo ledger; no USDC moved)
  TCP connections 3, all loopback; non-loopback refused 0
  transcript ./data/showcase-transcript.json
```

The run writes the full transcript, with every check and what it observed, to
`data/showcase-transcript.json` (schema `twzrd.x402_guard_showcase.v1`).

## What is real and what stands in

| Part | In this showcase |
|---|---|
| The gate | `twzrd-x402-gate` 0.22.0 from npm, unmodified. Every purchase goes through `twzrd.safeFetch`. |
| The seller | A loopback HTTP server in the same process. It answers an unpaid request with an x402 v2 `402` that offers both rails. It accepts a payment only if the payment names one of its own offers, and it counts what it saw. It settles nothing on any chain. |
| The signer | A stand-in that holds no key and builds no transaction. It sends a demo `PAYMENT-SIGNATURE` naming the offer the gate approved, so the seller can count a paid request, and it counts its own calls. |
| The seller check | A recorded table. The good seller gets `allow`, the flagged seller gets `block` (`WASH_FLAGGED`), and anyone else gets `block`. A live agent uses TWZRD's free preflight here; see [Wire it to real money](#wire-it-to-real-money). |
| The V7 receipt | Real. TWZRD's paid trust route issued it. `fixtures/intel-receipt-v7.json` holds the same bytes as [`docs/proofs/intel-receipt/receipt.json`](../../docs/proofs/intel-receipt/receipt.json). It is checked with `twzrd-receipt-verifier` 1.4.4 against the issuer key that package pins. TWZRD operated both sides of it: a wallet TWZRD funds bought it, and it scores TWZRD's own seller wallet, not the demo sellers. [docs/verify-intel-receipt.md](../../docs/verify-intel-receipt.md) walks through it. |
| The budget | `maxSpend: "0.10"`, which is both the per-call cap and the cumulative budget. Both rails share one in-memory ledger. |
| The seller addresses | Not real sellers. Each is derived from the sha256 digest of a public label (`x402-guard-showcase/good-seller/base`, and so on): the last 20 bytes for Base, base58 of all 32 bytes for Solana. `npm test` re-derives them. |

## How the kill switch works here

The gate checks for `.kill` at two points in a purchase:

- **On entry**, before it fetches the 402. If `.kill` is present, the purchase is refused and no request reaches the seller. This is a file check and does not wait on the network.
- **At the last look**, right before the signer. Nothing is awaited between that read and the signer call. So a `.kill` written while a purchase waits on its 402 or on the seller check still stops it.

Act 3 exercises both. The in-flight time runs from the moment the `.kill` write
returns to the moment `safeFetch` resolves with the refusal. The halted time is
the whole `safeFetch` call with `.kill` present. The run prints both and says
whether they were under a millisecond. That line is a measurement, not a check,
so a slower machine does not fail the run.

The gate never reads what is in `.kill`. It halts while the file exists, and also
while it cannot check (any error other than not-found). To halt an agent wired
the same way, create the file. To resume, remove it:

```bash
touch ./data/.kill   # every purchase is refused before the signer
rm ./data/.kill      # purchases resume
```

The gate also honors `.pause`, a JSON file that halts payments until its
`until_unix_ms`. A `.pause` that cannot be read or parsed also halts. The acts
do not use `.pause`.

## Run safety

- The `.kill` and the transcript live in this example's data dir. The agent
  passes `stateDir`, `killFilePath` and `pauseFilePath` explicitly, and these win
  over `TWZRD_STATE_DIR`, `KILLSWITCH_KILL_FILE` and `KILLSWITCH_PAUSE_FILE`.
- The spend ledger is in memory, so `TWZRD_SPEND_LEDGER_FILE` is never opened. No
  write-ahead log is opened (`TWZRD_SVM_WAL_FILE` is ignored). A fatal refusal
  writes no `.pause` (`TWZRD_TRIP_PAUSE_ON_BLOCK_MS` is ignored).
- A test points those six environment variables at a directory that holds
  another `.kill`. It checks that the run still passes and leaves that directory
  unchanged.
- With `tripPauseOnBlockMs: 0`, the gate writes `.pause` only when the
  cumulative budget trips. The acts spend 0.04 of the 0.10 budget, so that does
  not happen. A test checks that no `.pause` is left behind.
- The run refuses to start (exit 2) if the data dir already holds a `.kill` or a
  `.pause`. It never removes a sentinel it did not write: the `.kill` it writes
  carries a random token, and cleanup removes the file only when the token matches.
- For the length of the run, `net.Socket.prototype.connect` is patched with a
  loopback-only guard. `http`, `https` and `fetch` all connect through that method.
- The guard allows TCP to 127.0.0.1 and ::1 only. It refuses every other connect
  before a DNS lookup or a packet: another address, any hostname (`localhost`
  included), or a local socket path.
- The transcript counts both the allowed and the refused connections. UDP and
  other processes are outside the guard, and the run uses neither.

## Wire it to real money

The agent is in `lib/agent.mjs`. Three parts change.

**The signer.** Replace `pay` with your x402 client's signer. The gate calls it
with `{ url, paymentRequired, selected }`. `selected` is the one offer the gate
approved, and `paymentRequired.accepts` holds only that offer. Sign it, send the
paid request, and return `{ response }`.

**The seller check.** The gate runs no seller check unless you pass `preflight`.
The gate's README has a tested paste-in, `beforeYouPay`, which asks TWZRD's free
preflight and merchant card and throws to refuse. See
[Refuse before you sign without this package](../../twzrd-x402-gate/README.md#refuse-before-you-sign-without-this-package).
Inside `buy(url)`, wrap it so that a refusal, a timeout and an outage all block:

```js
preflight: (payTo, priceUsdc) =>
  beforeYouPay({ payTo, priceUsdc, resourceUrl: url }).then(
    (card) => ({ decision: card.decision }),
    () => ({ decision: "block" }), // refused, slow or down: block
  ),
```

The gate does not catch a `preflight` that throws. `safeFetch` then rejects
without paying, and you get an error instead of a result. The wrapper turns
every failure into a `block` result.

**The budget.** The showcase passes an in-memory `ledger`. The gate also uses
one in-memory ledger per process when `ledger`, `ledgerFile` and
`TWZRD_SPEND_LEDGER_FILE` are all unset. Either way, a restart forgets what was
spent. For a cumulative cap that survives restarts, replace `ledger` with
`ledgerFile: "<path>"`.

A few other things to set up:

- Point `killFilePath` at a path your operator controls.
- Pin the receipt issuer key yourself.
- Set your own receipt age limit. The signature does not expire, so pass
  `verify(receipt, pubkey, { maxAgeSeconds })`. This showcase leaves the limit
  off because its fixture is fixed and would age out.
- V7 receipts score Solana sellers. The free preflight scores sellers on both
  Solana and Base.

## What this does not show

- That money moved. No USDC is spent, no chain is read or written, and nothing settles.
- That the seller check gives the right answer. The table here is recorded, and a live preflight gives advice that your policy then acts on.
- That a receipt's score is right, that its payment settled, or that it is in the transparency log. The check here covers the leaf hash and the signature. [docs/verify-intel-receipt.md](../../docs/verify-intel-receipt.md) covers settlement and log inclusion.
- Use by anyone outside TWZRD. This is a demo run by whoever runs it.
- Network timing. The seller is in the same process, so a real purchase adds network time for the 402 and the payment. The `.kill` checks themselves do not touch the network.

## Files

| File | What it does |
|---|---|
| `showcase.mjs` | The CLI: runs the acts, prints the transcript and writes the JSON. |
| `lib/acts.mjs` | The three acts and every check. |
| `lib/agent.mjs` | `twzrd.safeFetch` with the cap, the seller check and the demo signer. |
| `lib/seller.mjs` | The loopback x402 seller. |
| `lib/seller-check.mjs` | The recorded seller check. |
| `lib/receipt.mjs` | The offline V7 receipt check. |
| `lib/kill-switch.mjs` | Writes and removes this run's `.kill`, and refuses to start over an existing sentinel. |
| `lib/net-guard.mjs` | The loopback-only connection guard. |
| `lib/rails.mjs` | Base USDC and Solana USDC: networks, USDC mints, demo seller addresses. |
| `fixtures/intel-receipt-v7.json` | The signed V7 receipt. |
| `test/showcase.test.mjs` | `node --test` coverage of the full run, the refusals, environment isolation and the CLI. |
