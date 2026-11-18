# x402 guard showcase: Base USDC and Solana USDC

Three acts in one command, on Base USDC and on Solana USDC, on up to three
seats. Every purchase goes through the published `twzrd-x402-gate`, and every
decision is checked against what the demo signers, the seller and the Solana RPC
stub actually saw.

| Seat | Rails | What pays |
|---|---|---|
| `safe-fetch` | Base USDC, Solana USDC | `twzrd.safeFetch` with a spend cap, a recorded seller check and a demo signer. |
| `x402-fetch` | Base USDC, Solana USDC | The gate's `createGuardedX402Fetch` on an `x402Client` from `@x402/fetch`, through [`createGuardedX402FetchWithEvents`](#three-lines-typed-events-for-an-x402fetch-client) (`lib/guarded-fetch.mjs`), with a demo `exact` scheme. |
| `x402-solana` | Solana USDC | Opt-in: [`npm run setup:x402-solana`](#the-x402-solana-seat-is-opt-in) installs it. The stock `x402-solana` client, through [`createGuardedX402SolanaFetch`](#three-lines-typed-events-for-an-x402-solana-client) (`lib/guarded-fetch.mjs`). It builds a real USDC transfer from a loopback RPC stub's answers and hands it to a demo wallet that holds no key. |

| Act | What happens | What the run checks |
|---|---|---|
| 1. ALLOW | Every seat pays a clean seller on each of its rails, once for plain content and once for a body that carries a signed V7 receipt. Then the receipt is checked offline: as issued, with its score edited, and with its freshness window extended. | One paid request and `signerInvocations: 1` per purchase. The receipt in the paid body verifies (`receiptVerified: true`). The x402-solana client read the chain after its hook approved, and its wallet was handed one transfer that pays the approved offer. Offline, the receipt verifies as issued and both edited copies fail. No connection is opened during the offline check. |
| 2. BLOCK | On every seat and rail: a flagged seller, a price over the cap, and a token that is not USDC. | `signerInvocations: 0` each time. The signer is never called, the seller is never paid, and the x402-solana client reads nothing from the chain. The safe-fetch budget is untouched. |
| 3. KILL | `.kill` is written while one purchase per seat and rail is in flight. Then 50 more purchases per seat and rail run with the file present. Then the file is removed. | Every in-flight purchase is refused before the signer (five with all three seats). Every later purchase is refused on entry, before any request reaches the seller or the RPC stub (250 with all three seats). Payments resume once the file is gone. |

It needs no key, wallet, account or USDC. The seller and the Solana RPC stub run
on 127.0.0.1 in the same process, and the run refuses any connection other than
TCP to 127.0.0.1 or ::1.

## Three lines: typed events for an `@x402/fetch` client

`lib/guarded-fetch.mjs` wraps the gate's `createGuardedX402Fetch` for a
configured `x402Client`. It is a file in this example, not an export of the
published package: copy it into your agent, next to `twzrd-x402-gate` and
`twzrd-receipt-verifier`.

```js
import { createGuardedX402FetchWithEvents } from "./guarded-fetch.mjs";
const pay = createGuardedX402FetchWithEvents({ client, maxPricePerCall: "0.10", allowedRecipients: [payTo], receipt: true, onDecision: console.log });
const response = await pay(url); // a refusal throws; onDecision has already said why
```

`client` is your `x402Client` with its schemes and signer registered, for
example `@x402/evm` for Base and `@x402/svm` for Solana. The options are
`createGuardedX402Fetch`'s (`client`, `fetch`, `maxPricePerCall`,
`hourlyBudgetCap`, `allowedRecipients`, `twzrd`, and the rest) plus:

| Option | When it is used |
|---|---|
| `onDecision(record)` | Once per call: `allow`, `block` or `error`, with the [decision record](#the-decision-record). |
| `onKill(record)` | A call refused by `.kill` or `.pause` (`twzrd_kill_switch`, `twzrd_payment_paused (...)`, `twzrd_pause_corrupt`). `onDecision` gets the same record. |
| `onReceiptVerified(event)` | A receipt in a paid 2xx response was checked: `{ valid, leafValid, signatureValid, errors, kind, subject, score, issuedAtUnix, trustedPubkey }`. |
| `receipt` | `true`, or `{ extract, pubkey, maxAgeSeconds }`: check the receipt in a paid 2xx response with `twzrd-receipt-verifier`. By default it reads `twzrd_receipt` from the JSON body and checks it against the issuer key that package pins. |

What the wrapper adds, and what it leaves to the gate:

- A `.kill` / `.pause` check before the request is sent, with the gate's own
  reader (`twzrdSentinelRefusal`), so a halted agent sends nothing. The gate
  itself reads both inside its pre-sign hook, once the 402 is in, and again
  right before the signer. Without this check a halted agent still sends the
  unpaid request; it still never pays.
- Apart from that entry check it decides nothing. Every other allow and refusal
  is the gate's, or another hook's on the same client. A refusal throws, as it
  does from `createGuardedX402Fetch`. A callback that throws is ignored. An
  async callback is not awaited, and its rejection is dropped.
- The receipt check runs after the payment. `receiptVerified: false` does not
  undo it; act on it in your own policy, for example by refusing that seller
  next time.
- Register your own hooks on the client before you call it. Hooks registered
  later run after the gate's last look, between it and the signer.
- `@x402/core`'s own spend controls (recognized assets only, 1 USD per payment by
  default) run while the offer is selected, before any hook. This example turns
  them off so that the gate's checks are the ones that refuse. Left on, a payment
  they refuse is recorded as `block`, reason `core_spend_controls`, stage
  `pre_sign`, with the offer fields null.

Which entry point: the gate's README lists `createGuardedX402Fetch` and
`twzrd.safeFetch` for existing integrations, and points a new buyer at
`createBuyerFetch`, which keeps its hourly ledger in a file and requires a cap
and an allowlist. This example does not run `createBuyerFetch`. For an
`x402-solana` client, see the next section.

## Three lines: typed events for an `x402-solana` client

The gate has no guarded fetch for the stock `x402-solana` client. Its seat for
that client is `installTwzrdAutoGate("x402-solana")`, a `beforePayment` hook.
`createGuardedX402SolanaFetch`, in the same file, builds the client around that
seat and gives it the same checks, halts and decision records as the
`@x402/fetch` wrapper:

```js
import { createGuardedX402SolanaFetch } from "./guarded-fetch.mjs";
const pay = createGuardedX402SolanaFetch({ createX402Client, wallet, rpcUrl, maxPricePerCall: "0.10", allowedRecipients: [payTo], receipt: true, onDecision: console.log });
const response = await pay(url); // a refusal throws; onDecision has already said why
```

`createX402Client` is the stock client's factory from `x402-solana/client`.
`wallet` is your wallet adapter or keypair signer: anything with
`signTransaction` and a `publicKey` or `address`. The wrapper imports nothing
from x402-solana itself; you pass the factory in. In this example the seat is
opt-in (see [Run it](#the-x402-solana-seat-is-opt-in)); in your agent,
x402-solana is an ordinary dependency.

| Option | What it does |
|---|---|
| `createX402Client`, `wallet` | Required. |
| `network` | `"solana"` (the default) or `"solana-devnet"`: the only cluster it pays on. |
| `rpcUrl`, `customFetch`, `verbose` | Passed to x402-solana as given. |
| `maxPricePerCall`, `hourlyBudgetCap`, `allowedRecipients` | As `createGuardedX402Fetch` reads them, with the same refusal codes. |
| `twzrd` | Options for the gate's x402-solana seat: sentinel paths, `disabled`, and the rest. |
| `onDecision`, `onKill`, `onReceiptVerified`, `receipt` | As on the `@x402/fetch` wrapper above. |

What it adds to the stock client:

- **The gate's checks in the client's one hook.** In `beforePayment`, on the one
  offer x402-solana selected, it runs `createGuardedX402Fetch`'s local checks
  with the same refusal codes (the gate's field checks, `allowedRecipients`,
  USDC only, `maxPricePerCall`, `hourlyBudgetCap`), then the gate's x402-solana
  seat, which runs the TWZRD evaluator unless `twzrd.disabled` and reads `.kill`
  and `.pause` either way.
- **A network pin.** The stock client pays the first `exact` offer on any Solana
  network, whatever `network` it was built with. The wrapper refuses an offer
  off the configured cluster (`network_not_allowed`).
- **Three looks at `.kill` and `.pause`.** On entry, before any request. In the
  hook. And in the wallet, right before your `signTransaction`, with nothing
  awaited in between. After its hook approves, x402-solana reads the chain (here
  five RPC calls: the mint twice, both token accounts and a blockhash) and
  builds the transaction, so a halt written during those reads is caught in the
  wallet. Act 3 holds a purchase on its blockhash read to show it.
- **The hourly budget, counted at the wallet.** A payment counts against
  `hourlyBudgetCap` when the wallet is asked to sign it. From the hook until
  then its amount is reserved, so a concurrent call cannot overspend while this
  one reads the chain; the reservation is released if the call ends unsigned.
  `createGuardedX402Fetch` counts at its last look instead, which comes right
  before its scheme signs.
- **No silent options.** Any other option throws a `TypeError` when the fetch is
  built, x402-solana's own `amount` and `beforePayment` included:
  `maxPricePerCall` and the wrapper's hook govern.

A refusal in the hook throws x402-solana's own error, for example `Payment
aborted by beforePayment hook: [twzrd-guarded-fetch] price_cap_exceeded`; the
record carries the reason alone. A missing or malformed amount never reaches the
hook: x402-solana rejects it first (`Invalid amount in payment requirements:
...`). That call is recorded as an `error` with the client's message and no
offer fields, and nothing is read from the chain or signed.

### The decision record

| Field | What it holds |
|---|---|
| `decision` | `allow`, `block`, or `error` (not a refusal: the transport failed, the 402 could not be read, and so on). |
| `reason` | The refusal code: the gate's (`price_cap_exceeded`, `unauthorized_recipient`, `twzrd_kill_switch`, ...), the Solana wrapper's `network_not_allowed`, or `core_spend_controls`. For an `error`, the message. `null` on `allow`. |
| `stage` | `entry` (refused before any request), `pre_sign` (decided after the 402, before the signer), `transport` (refused at the paid request, after signing; x402-fetch only), or `null`. |
| `chain`, `network` | From the offer the client selected: `base` / `eip155:8453`, `solana` / `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. `null` when no offer was selected. |
| `asset`, `assetAddress` | `USDC` or `non-USDC` by the gate's USDC table, and the token address. |
| `payTo` | The recipient in that offer. |
| `amount`, `amountUsdc` | The amount in base units, and in USDC (`null` when the asset is not USDC). |
| `signerInvocations` | How many times the signer ran during the call: the scheme on an `x402Client`, the wallet's `signTransaction` on x402-solana. |
| `status` | The HTTP status of the response, on `allow`. |
| `receiptVerified` | `true` or `false` when a receipt was found and checked, else `null`. |
| `elapsedMs` | The whole call, in milliseconds. |

The safe-fetch seat builds the same record from what `safeFetch` returns
(`lib/agent.mjs`). Each trace record adds `type`, `act`, `step`, `seat`, `rail`,
`shop`, `demoSignerCalls`, `sellerUnpaid`, `sellerPaid`, `sellerCheckConsulted`
(safe-fetch only), `rpcCalls` and `signedTransferMatchesOffer` (x402-solana
only), `decisionsEmitted` and `killLatencyMs`. `rail` names the agent that made
the purchase; `chain` comes from the offer it read, so it is `null` for a
purchase refused on entry. `rpcCalls` counts the RPC calls the stub answered
during the purchase. `signedTransferMatchesOffer` is `null` when the demo wallet
was handed nothing, and otherwise `true` only when it was handed exactly one
transfer and that transfer pays the approved offer.

## Run it

Node 22 or later.

```bash
cd examples/x402-guard-showcase
npm ci --ignore-scripts
npm run setup:x402-solana                                # optional: adds the x402-solana seat
npm run showcase                                         # all three acts, as tables
node showcase.mjs --scenario kill --json > kill.ndjson   # one trace record per line
node showcase.mjs --interactive                          # Enter runs the next act, q stops
npm test
```

| Flag | What it does |
|---|---|
| `--scenario allow\|block\|kill\|all` | Runs one act, or all three (the default). |
| `--json` | Prints the trace on stdout, one JSON record per line, instead of the tables. The transcript path goes to stderr. |
| `--interactive` | Asks on stderr before each act. Enter runs it; `q` or the end of input stops the run with result `stopped`. |
| `--data-dir <dir>` | Puts the `.kill` and the transcript in `<dir>` instead of `./data` next to `showcase.mjs`. |
| `--help` | Prints the usage line. |

Exit codes:

- `0`: every check passed, or `--interactive` stopped early with every check so far passing.
- `1`: a check failed (listed under `RESULT`), or the run hit an unexpected error.
- `2`: the run refused to start and changed nothing, or a flag was wrong.

`npm ci` installs 10 packages pinned by `package-lock.json`: `twzrd-x402-gate`
0.26.0, `twzrd-receipt-verifier` 1.4.6, `@x402/core` 2.31.0, `@x402/fetch`
2.31.0, and their dependencies. None has an install script, and on 2026-11-18
`npm audit` reported no vulnerabilities in them. That is enough for the
safe-fetch and x402-fetch seats. The x402-solana seat is then skipped: the
header, the result and the trace's `skippedSeats` name it and the command that
adds it, and its tests are reported as skipped. After the install nothing here
uses the network.

### The x402-solana seat is opt-in

`npm run setup:x402-solana` runs `npm install --no-save --ignore-scripts` for
`x402-solana` 3.0.1, `@solana/web3.js` 1.99.0 and `@solana/spl-token` 0.4.15.
It adds 72 packages to `node_modules` and leaves `package.json` and
`package-lock.json` unchanged. Those three versions are pinned; the packages
under them resolve when you run the setup, within the ranges the three declare.
On 2026-11-15 the setup installed 82 packages in all, the same versions as an
`npm install --package-lock-only` of the same pins. `npm ci` and `npm install`
remove the 72 again; run the setup after either.

The seat loads only from this example's own `node_modules`. A copy in a parent
directory, such as this repository's root `node_modules`, is ignored, so the
seat runs on what the setup installed or not at all. The trace's `start` record
gives the versions it ran on.

Three of the added packages have install scripts, each for a native add-on with
a JavaScript fallback: `bigint-buffer`, `bufferutil` and `utf-8-validate`.
`--ignore-scripts` skips them, and everything here passes without them.
`bigint-buffer` then prints this line on stderr when it loads:

```text
bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)
```

npm also warns that `uuid@8.3.2` is deprecated.

`npm audit` in this example reads `package-lock.json`, so it does not see the
packages the setup adds: after the setup it still reports none. Audited on
their own on 2026-11-15 (the three pins added to a copy of `package.json`, then
`npm install --package-lock-only` and `npm audit`), they carry six advisories,
all in x402-solana 3.0.1's dependency tree. None has a fixed version that tree
accepts, and 3.0.1 is the latest x402-solana:

| Package | Advisory | Comes in through |
|---|---|---|
| `bigint-buffer` 1.1.5 | [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg), high: a buffer overflow in `toBigIntLE()` that can crash the process. No fixed version exists. | `@solana/spl-token` 0.4.15, through `@solana/buffer-layout-utils` |
| `zod` 3.25.76 | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high: memory exhaustion while validating oversized constrained collections. Fixed in 4.6.6. | the `@x402/core` 2.21.0 that x402-solana 3.0.1 pins for itself |
| `stream-json` 1.9.1 | [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x), [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc), moderate | `@solana/web3.js` 1.99.0, through `jayson` |
| `uuid` 8.3.2 | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), moderate | `@solana/web3.js` 1.99.0, through `jayson` |

npm's own count is 13 packages, because it also flags the packages that depend
on these. The example's own `@x402/core` and `@x402/fetch` are 2.31.0, whose
`zod` (4.6.7) is not affected. In this run these packages only handle data from
the loopback seller and the RPC stub in the same process. An agent that deploys
x402-solana takes on the same tree: run `npm audit` on the versions you deploy.

On 2026-11-18, from a clean `npm ci --ignore-scripts` in a copy of this example
outside the repository, `npm test` passed 28 tests and skipped the 10
x402-solana tests, and the showcase passed 45/45 checks. After
`npm run setup:x402-solana`, the tests passed 38/38 and the showcase 58/58.
Both ways passed on Node 24.22.1, and again on Node 22.23.5 in a container with
networking disabled (`--network none`). To repeat that, install first, then run
`npm test` and `node showcase.mjs` in any sandbox with networking off.

## Output

This is the stdout of one run on Node 24.22.1, after
`npm run setup:x402-solana`. The ports and the timings change from run to run
and from machine to machine.

```text
x402 guard showcase   twzrd-x402-gate 0.26.0   twzrd-receipt-verifier 1.4.6   @x402/fetch 2.31.0   x402-solana 3.0.1   node v24.22.1
seller  http://127.0.0.1:21043 (loopback, settles nothing)
rpc     http://127.0.0.1:19769 (loopback Solana RPC stub for x402-solana: the mint, two token accounts, a blockhash)
seats   safe-fetch   twzrd.safeFetch with the recorded seller check
        x402-fetch   createGuardedX402Fetch on an @x402/fetch client; TWZRD evaluator off (offline)
        x402-solana  createGuardedX402SolanaFetch on the stock x402-solana client, Solana only; TWZRD evaluator off (offline)
signer  demo signer (safe-fetch), demo exact scheme (x402-fetch), demo wallet (x402-solana): no key, nothing signed
budget  0.10 USDC per call; safe-fetch 0.10 in total, x402-fetch 0.10 per hour per rail, x402-solana 0.10 per hour
kill    ./data/.kill
acts    allow, block, kill

ACT 1  ALLOW
  seat         rail         shop      decision  signerInvocations  receipt   seller saw
  safe-fetch   Base USDC    /good     allow     1                  -         402, then 1 paid request (200)
  safe-fetch   Base USDC    /receipt  allow     1                  verified  402, then 1 paid request (200)
  safe-fetch   Solana USDC  /good     allow     1                  -         402, then 1 paid request (200)
  safe-fetch   Solana USDC  /receipt  allow     1                  verified  402, then 1 paid request (200)
  x402-fetch   Base USDC    /good     allow     1                  -         402, then 1 paid request (200)
  x402-fetch   Base USDC    /receipt  allow     1                  verified  402, then 1 paid request (200)
  x402-fetch   Solana USDC  /good     allow     1                  -         402, then 1 paid request (200)
  x402-fetch   Solana USDC  /receipt  allow     1                  verified  402, then 1 paid request (200)
  x402-solana  Solana USDC  /good     allow     1                  -         402, then 1 paid request (200)
  x402-solana  Solana USDC  /receipt  allow     1                  verified  402, then 1 paid request (200)
  x402-solana read the chain after its hook approved: 5 RPC reads per payment
  transfers its wallet was handed that pay the approved offer: 2/2
  V7 receipt (fixtures/intel-receipt-v7.json) checked offline: twzrd-receipt-verifier, key twzrd-receipt-ed25519-v2 Ak5SQw...HzvS
    as issued               VALID    subject GFpLvo...e1Gs  score 67  issued 2026-11-14
    score +1                INVALID  leaf mismatch: preimage does not hash to receipt.leaf
    fresh for 30 more days  INVALID  leaf mismatch: preimage does not hash to receipt.leaf
    connections opened during the check: 0
  checks 14/14

ACT 2  BLOCK
  seat         rail         shop          decision  reason                         signerInvocations  seller saw
  safe-fetch   Base USDC    /flagged      block     intel_block                    0                  402 only, 0 paid
  safe-fetch   Base USDC    /pricey       block     over_max_spend                 0                  402 only, 0 paid
  safe-fetch   Base USDC    /wrong-asset  block     non_usdc_asset                 0                  402 only, 0 paid
  safe-fetch   Solana USDC  /flagged      block     intel_block                    0                  402 only, 0 paid
  safe-fetch   Solana USDC  /pricey       block     over_max_spend                 0                  402 only, 0 paid
  safe-fetch   Solana USDC  /wrong-asset  block     non_usdc_asset                 0                  402 only, 0 paid
  x402-fetch   Base USDC    /flagged      block     unauthorized_recipient         0                  402 only, 0 paid
  x402-fetch   Base USDC    /pricey       block     price_cap_exceeded             0                  402 only, 0 paid
  x402-fetch   Base USDC    /wrong-asset  block     unsupported_or_non_usdc_asset  0                  402 only, 0 paid
  x402-fetch   Solana USDC  /flagged      block     unauthorized_recipient         0                  402 only, 0 paid
  x402-fetch   Solana USDC  /pricey       block     price_cap_exceeded             0                  402 only, 0 paid
  x402-fetch   Solana USDC  /wrong-asset  block     unsupported_or_non_usdc_asset  0                  402 only, 0 paid
  x402-solana  Solana USDC  /flagged      block     unauthorized_recipient         0                  402 only, 0 paid
  x402-solana  Solana USDC  /pricey       block     price_cap_exceeded             0                  402 only, 0 paid
  x402-solana  Solana USDC  /wrong-asset  block     unsupported_or_non_usdc_asset  0                  402 only, 0 paid
  x402-solana chain reads during its refusals: 0
  safe-fetch budget spent by refusals: 0.00 USDC
  checks 16/16

ACT 3  KILL  ./data/.kill
  in flight: one purchase per seat and rail, held when .kill was written
  (safe-fetch on the seller check after its 402, x402-fetch on its 402,
  x402-solana on its blockhash read, after its hook approved)
  safe-fetch   Base USDC    block  twzrd_kill_switch  pre_sign  signerInvocations 0  seller paid 0  refused 0.318 ms after .kill
  safe-fetch   Solana USDC  block  twzrd_kill_switch  pre_sign  signerInvocations 0  seller paid 0  refused 0.330 ms after .kill
  x402-fetch   Base USDC    block  twzrd_kill_switch  pre_sign  signerInvocations 0  seller paid 0  refused 0.612 ms after .kill
  x402-fetch   Solana USDC  block  twzrd_kill_switch  pre_sign  signerInvocations 0  seller paid 0  refused 0.806 ms after .kill
  x402-solana  Solana USDC  block  twzrd_kill_switch  pre_sign  signerInvocations 0  seller paid 0  refused 1.270 ms after .kill  chain reads 5
  halted: 50 more purchases per seat and rail with .kill present
  safe-fetch   Base USDC    50/50 refused on entry  signer calls 0  seller requests 0  p50 0.004 ms  max 0.029 ms
  safe-fetch   Solana USDC  50/50 refused on entry  signer calls 0  seller requests 0  p50 0.004 ms  max 0.010 ms
  x402-fetch   Base USDC    50/50 refused on entry  signer calls 0  seller requests 0  p50 0.002 ms  max 0.006 ms
  x402-fetch   Solana USDC  50/50 refused on entry  signer calls 0  seller requests 0  p50 0.002 ms  max 0.004 ms
  x402-solana  Solana USDC  50/50 refused on entry  signer calls 0  seller requests 0  p50 0.002 ms  max 0.008 ms  chain reads 0
  sub-millisecond halt: safe-fetch yes, x402-fetch yes, x402-solana no (a measurement, not a check;
  once released, the in-flight x402-solana purchase finishes a chain read and builds its transaction before its wallet refuses)
  resumed: .kill removed (this run wrote it)
  safe-fetch   Base USDC    /good  allow  signerInvocations 1  seller paid 1
  safe-fetch   Solana USDC  /good  allow  signerInvocations 1  seller paid 1
  x402-fetch   Base USDC    /good  allow  signerInvocations 1  seller paid 1
  x402-fetch   Solana USDC  /good  allow  signerInvocations 1  seller paid 1
  x402-solana  Solana USDC  /good  allow  signerInvocations 1  seller paid 1
  checks 19/19

RESULT  PASS  58/58 checks
  safe-fetch   demo signer calls 6, signerInvocations 6, seller paid requests 6 (Base USDC 3, Solana USDC 3)
               events: onDecision 114, onKill 102, onReceiptVerified 2
  x402-fetch   demo scheme calls 6, signerInvocations 6, seller paid requests 6 (Base USDC 3, Solana USDC 3)
               events: onDecision 114, onKill 102, onReceiptVerified 2
  x402-solana  demo wallet calls 3, signerInvocations 3, seller paid requests 3 (Solana USDC 3)
               events: onDecision 57, onKill 51, onReceiptVerified 1
               transfers handed to the wallet 3, paying the approved offer 3
               RPC reads: getAccountInfo 16, getLatestBlockhash 4, other 0
  budget used: safe-fetch 0.06 of 0.10 USDC (one ledger, both rails); x402-fetch Base USDC 0.03, Solana USDC 0.03; x402-solana Solana USDC 0.03 USDC (demo; no USDC moved)
  TCP connections 8, all loopback; non-loopback refused 0
  transcript ./data/showcase-transcript.json
```

The x402-solana client built four transactions and read the chain for each:
the two Act 1 purchases, the one in flight in Act 3, and the one after the
resume. Its wallet refused the one in flight, so the demo wallet was called
three times.

Without the setup, the header names the skipped seat and the command that adds
it, and has no `rpc` line:

```text
seats   safe-fetch   twzrd.safeFetch with the recorded seller check
        x402-fetch   createGuardedX402Fetch on an @x402/fetch client; TWZRD evaluator off (offline)
        x402-solana  not installed: npm run setup:x402-solana adds this seat
```

The acts then run on the other two seats, and the result reads
`RESULT  PASS  45/45 checks` with the same `not installed` line under it.

The run writes the transcript to `data/showcase-transcript.json` (schema
`twzrd.x402_guard_showcase.v2`): every check with what it observed, the totals,
and the trace.

## The trace (`--json`)

Schema `twzrd.x402_guard_trace.v1`, one record per line:

| `type` | When |
|---|---|
| `start` | First: package versions (`null` for one that is not installed), seller, RPC stub (`null` without the x402-solana seat), the seats that run and the rails each one buys on (`seatRails`), the seats skipped and why (`skippedSeats`: seat, reason `not_installed`, the missing packages and the setup command), rails, acts, budget and kill file. |
| `act` | At the start and the end of each act; the end record counts the checks passed. |
| `decision` | One per purchase, as it settles. |
| `receipt` | One per receipt check, `source` `paid_response` or `offline`. |
| `kill_switch` | When the run writes `.kill` (`engaged`) and removes it (`removed`). |
| `result` | Last: `pass`, `fail` or `stopped`, checks passed and failed, acts run. |

A full run on Node 24.22.1 printed 303 records with the x402-solana seat, and
245 without it. This is one of the 303, the x402-solana purchase in flight when
`.kill` was written:

```json
{
  "type": "decision",
  "act": "kill",
  "step": "in_flight",
  "seat": "x402-solana",
  "rail": "solana",
  "shop": "/good",
  "chain": "solana",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "asset": "USDC",
  "assetAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "2WBvtM5caeqGYzEsL1bpBykRBZT117YtBekYFwdrw6kw",
  "amount": "10000",
  "amountUsdc": "0.01",
  "decision": "block",
  "reason": "twzrd_kill_switch",
  "stage": "pre_sign",
  "signerInvocations": 0,
  "status": null,
  "receiptVerified": null,
  "elapsedMs": 6.328,
  "demoSignerCalls": 0,
  "sellerUnpaid": 1,
  "sellerPaid": 0,
  "sellerCheckConsulted": null,
  "rpcCalls": 5,
  "signedTransferMatchesOffer": null,
  "decisionsEmitted": 1,
  "killLatencyMs": 1.154
}
```

`elapsedMs` includes the time the purchase was held; `killLatencyMs` runs from
the `.kill` write to the refusal. The purchase read the chain five times after
its hook approved, and its wallet refused before the demo wallet was called, so
no transfer was handed over (`signedTransferMatchesOffer: null`).

## What is real and what stands in

| Part | In this showcase |
|---|---|
| The gate | `twzrd-x402-gate` 0.26.0 from npm, unmodified. The safe-fetch seat calls `twzrd.safeFetch`. The x402-fetch seat calls `createGuardedX402Fetch` through `lib/guarded-fetch.mjs`. The x402-solana seat calls the gate's x402-solana seat (`installTwzrdAutoGate`), its offer readers (`resolveRequirementFields`, `isUsdcRequirement`) and its sentinel reader (`twzrdSentinelRefusal`) through the same file. |
| The x402 clients | x402-fetch: a real `x402Client` from `@x402/fetch` 2.31.0, one per rail, so each pays only its own rail's offer. Its scheme is a stand-in (below). Core's own spend controls are off. x402-solana: the stock `x402-solana` 3.0.1 client that `npm run setup:x402-solana` installs, unmodified, from `createX402Client`. It reads the 402, selects the offer, reads the chain from the RPC stub, builds a v0 transaction with one SPL `TransferChecked`, hands it to the wallet, and sends what the wallet returns in its `PAYMENT-SIGNATURE`. |
| The seller | A loopback HTTP server in the same process. It answers an unpaid request with an x402 v2 `402` that offers both rails; each Solana offer names a fee payer in `extra.feePayer`, which x402-solana requires. It accepts a payment only if the payment names one of its own offers, and it counts what it saw. It settles nothing on any chain, and it does not read the x402-solana transaction. |
| The Solana RPC stub | A loopback JSON-RPC server in the same process (`lib/solana-rpc.mjs`). It answers `getAccountInfo` for the USDC mint and for the buyer's and the good seller's token accounts, and `getLatestBlockhash` with a fixed demo blockhash. Any other account reads as missing, and any other method gets an error; the run checks that no other method was called. It is not a chain: the accounts and balances are made up, and nothing is submitted. It starts only when the x402-solana seat runs. |
| The signers | None holds a key or signs anything, and each counts its own calls. safe-fetch: a `pay` function that sends a demo `PAYMENT-SIGNATURE` naming the offer the gate approved, so the seller can count a paid request. x402-fetch: a demo `exact` scheme in the place `@x402/evm` or `@x402/svm` takes; `@x402/fetch` builds the `PAYMENT-SIGNATURE` from its demo payload. x402-solana: a demo wallet in the place a wallet adapter or keypair signer takes. It reads the transfer it was handed and returns the transaction unsigned. The run checks every transfer against the offer the gate approved: one `TransferChecked`, with its mint, amount, decimals, owner, source and destination token accounts, fee payer and blockhash. |
| The seller check | safe-fetch: a recorded table. The good seller gets `allow`, the flagged seller gets `block` (`WASH_FLAGGED`), and anyone else gets `block`. A live agent uses TWZRD's free preflight here; see [Wire it to real money](#wire-it-to-real-money). x402-fetch and x402-solana: the gate's TWZRD evaluator, which asks TWZRD's live preflight, is off in this offline run (`twzrd: { disabled: true }`). Their caps, recipient allowlists and kill switch stay on, so they refuse the flagged seller with `unauthorized_recipient`. |
| The V7 receipt | Real. TWZRD's paid trust route issued it. `fixtures/intel-receipt-v7.json` holds the same bytes as [`docs/proofs/intel-receipt/receipt.json`](../../docs/proofs/intel-receipt/receipt.json). It is checked with `twzrd-receipt-verifier` 1.4.6 against the issuer key that package pins. TWZRD operated both sides of it: a wallet TWZRD funds bought it, and it scores TWZRD's own seller wallet. The `/receipt` shop returns these same bytes in its paid body, so that receipt is about TWZRD's seller wallet, not about the demo seller that serves it. [docs/verify-intel-receipt.md](../../docs/verify-intel-receipt.md) walks through it. |
| The budget | safe-fetch: `maxSpend: "0.10"`, which is both the per-call cap and the cumulative budget, one in-memory ledger for both rails. x402-fetch: `maxPricePerCall: "0.10"` and `hourlyBudgetCap: "0.10"`, a rolling hour kept in memory per client, so per rail. x402-solana: the same two limits, a rolling hour kept in memory, counted when the wallet is asked to sign. |
| The demo addresses | Not real accounts; nobody holds a key for any of them. Each seller address is derived from the sha256 digest of a public label (`x402-guard-showcase/good-seller/base`, and so on): the last 20 bytes for Base, base58 of all 32 bytes for Solana. The Solana buyer, fee payer and blockhash come the same way from `x402-guard-showcase/buyer/solana`, `fee-payer/solana` and `blockhash/solana`. `npm test` re-derives them, and checks that the buyer and the sellers are on the ed25519 curve, as token account derivation needs. |
| `x-showcase-agent` | Demo instrumentation. Each agent names itself in this request header so the seller can count per agent. A real agent sends no such header. |

## How the kill switch works here

Each seat reads `.kill` before any request and again before its signer:

- **On entry**, before any request. If `.kill` is present, the purchase is
  refused and no request reaches the seller (or, for x402-solana, the RPC
  stub). For safe-fetch the gate does this; for x402-fetch and x402-solana the
  wrapper does. It is a file check and does not wait on the network.
- **Before the signer.** For safe-fetch this is the gate's last look, with
  nothing awaited between that read and the signer call. For x402-fetch the
  gate's pre-sign hook reads it as the 402 comes in, and again at its last look
  before the scheme signs. For x402-solana the wrapper's hook and the gate's
  seat read it as the 402 comes in; then the client reads the chain and builds
  the transaction; then the wrapper's wallet reads it once more, with nothing
  awaited between that read and the real `signTransaction`.

Act 3 holds the safe-fetch purchases on the seller check, after their 402; the
x402-fetch purchases at the seller, before their 402 is answered; and the
x402-solana purchase on its blockhash read, after its hook approved. It writes
`.kill`, then lets them go. All of them (five with all three seats) are refused
before the signer, the x402-solana one by its wallet. The in-flight time runs from the moment the
`.kill` write returns to the moment the purchase settles with the refusal. The
halted time is the whole purchase with `.kill` present. The run prints both and
says whether they were under a millisecond. That line is a measurement, not a
check, so a slower machine does not fail the run. In the output above the
x402-solana purchase took 1.270 ms: once released, it finishes the blockhash
read and builds its transaction before its wallet refuses.

The gate never reads what is in `.kill`. It halts while the file exists, and also
while it cannot check (any error other than not-found). To halt an agent wired
the same way, create the file. To resume, remove it:

```bash
touch ./data/.kill   # every purchase is refused before the signer
rm ./data/.kill      # purchases resume
```

The gate also honors `.pause`, a JSON file that halts payments until its
`until_unix_ms`. A `.pause` that cannot be read or parsed also halts. The acts
do not use `.pause`; the wrappers' tests do.

## Run safety

- The `.kill` and the transcript live in this example's data dir. Every seat
  passes `stateDir`, `killFilePath` and `pauseFilePath` explicitly, and these
  win over `TWZRD_STATE_DIR`, `KILLSWITCH_KILL_FILE` and `KILLSWITCH_PAUSE_FILE`.
- The safe-fetch spend ledger is in memory, so `TWZRD_SPEND_LEDGER_FILE` is never
  opened. No write-ahead log is opened (`TWZRD_SVM_WAL_FILE` is ignored). A fatal
  refusal writes no `.pause` (`TWZRD_TRIP_PAUSE_ON_BLOCK_MS` is ignored). The
  x402-fetch and x402-solana hourly budgets are in memory too.
- A test points those six environment variables at a directory that holds
  another `.kill`. It checks that the run still passes and leaves that directory
  unchanged.
- With `tripPauseOnBlockMs: 0`, safe-fetch writes `.pause` only when the
  cumulative budget trips. The acts spend 0.06 of the 0.10 budget, so that does
  not happen. A test checks that no `.pause` is left behind.
- The run refuses to start (exit 2) if the data dir already holds a `.kill` or a
  `.pause`. It never removes a sentinel it did not write: the `.kill` it writes
  carries a random token, and cleanup removes the file only when the token matches.
- For the length of the run, `net.Socket.prototype.connect` is patched with a
  loopback-only guard. `http`, `https` and `fetch` all connect through that
  method, and so do x402-solana's RPC calls through `@solana/web3.js`.
- The guard allows TCP to 127.0.0.1 and ::1 only. It refuses every other connect
  before a DNS lookup or a packet: another address, any hostname (`localhost`
  included), or a local socket path.
- The transcript counts both the allowed and the refused connections. UDP and
  other processes are outside the guard, and the run uses neither.
- `test/guarded-fetch.test.mjs` answers from a transport in the same process and
  checks that no socket was opened. With the x402-solana seat installed,
  `test/guarded-solana-fetch.test.mjs` runs the RPC stub on 127.0.0.1 under the
  same guard and checks that every connection it opened was loopback.

## Wire it to real money

The agents are in `lib/agent.mjs`.

### The safe-fetch seat

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

### The x402-fetch seat

- **The scheme.** Register `@x402/evm` (Base) or `@x402/svm` (Solana) with your
  signer on the `x402Client`, in place of the demo scheme.
- **The evaluator.** Remove `disabled: true` from `twzrd`. The evaluator is on by
  default and asks TWZRD's preflight before the signer.
- **Core's spend controls.** Keep them, or tune them with `spendControls` on
  `x402Client.fromConfig`. Their refusals are recorded as `core_spend_controls`.
- **Caps and recipients.** Set `maxPricePerCall`, `hourlyBudgetCap` and
  `allowedRecipients` for your sellers. The rolling hour is kept in memory and
  starts over when the process restarts.

### The x402-solana seat

- **The packages.** Add `x402-solana` and its peer dependencies,
  `@solana/web3.js` and `@solana/spl-token`, to your agent's own dependencies
  and lockfile, and audit that tree (see
  [the advisories above](#the-x402-solana-seat-is-opt-in)).
- **The wallet.** Pass your wallet adapter or keypair signer as `wallet`, in
  place of the demo wallet. It signs as the owner of the buyer's USDC token
  account.
- **The RPC.** Point `rpcUrl` at your own Solana RPC, in place of the loopback
  stub.
- **The transport.** Drop `customFetch`, the showcase's loopback-only
  transport, or pass your own.
- **The evaluator.** Remove `disabled: true` from `twzrd`. The gate's
  x402-solana seat then asks TWZRD's preflight before the signer.
- **Caps and recipients.** Set `maxPricePerCall`, `hourlyBudgetCap` and
  `allowedRecipients` for your sellers. The rolling hour is kept in memory and
  starts over when the process restarts.

### Every seat

- Point `killFilePath` at a path your operator controls.
- Pin the receipt issuer key yourself (`receipt: { pubkey }` on either wrapper).
- Set your own receipt age limit (`receipt: { maxAgeSeconds }`, or
  `verify(receipt, pubkey, { maxAgeSeconds })`). The signature does not expire.
  This showcase leaves the limit off because its fixture is fixed and would age
  out.
- V7 receipts score Solana sellers. The free preflight scores sellers on both
  Solana and Base.

## What this does not show

- That money moved. No USDC is spent and nothing settles. The x402-solana transaction is built but never signed or submitted, and the seller does not read it. The RPC stub is not a chain: its accounts and balances are made up.
- That the seller check gives the right answer. The safe-fetch table is recorded, the x402-fetch and x402-solana evaluators are off, and a live preflight gives advice that your policy then acts on.
- That a receipt's score is right, that its payment settled, or that it is in the transparency log. The check here covers the leaf hash and the signature. [docs/verify-intel-receipt.md](../../docs/verify-intel-receipt.md) covers settlement and log inclusion.
- `createBuyerFetch`. It does not run here.
- Use by anyone outside TWZRD. This is a demo run by whoever runs it.
- Network timing. The seller and the RPC stub are in the same process, so a real purchase adds network time for the 402, the chain reads and the payment. The `.kill` checks themselves do not touch the network.

## Files

| File | What it does |
|---|---|
| `showcase.mjs` | The CLI: runs the acts, prints the tables or the trace, and writes the transcript. |
| `lib/acts.mjs` | The three acts, every check, and the trace. It skips the x402-solana seat when that seat is not installed. |
| `lib/guarded-fetch.mjs` | `createGuardedX402FetchWithEvents` (typed events, the entry check and the receipt check around `createGuardedX402Fetch`) and `createGuardedX402SolanaFetch` (the gate's checks, its x402-solana seat, the same halts and records on the stock x402-solana client). |
| `lib/agent.mjs` | The three seats: `twzrd.safeFetch` with the demo signer, the wrapper on an `x402Client` with the demo scheme, and the Solana wrapper on x402-solana with the demo wallet. Also `readTransfer`, which reads the token transfer out of a transaction, and `loadX402Solana`, which loads x402-solana from this example's own `node_modules` or names the packages that are missing. |
| `lib/seller.mjs` | The loopback x402 seller. |
| `lib/solana-rpc.mjs` | The loopback Solana RPC stub, loaded only with the x402-solana seat. |
| `lib/seller-check.mjs` | The recorded seller check. |
| `lib/receipt.mjs` | The offline V7 receipt check. |
| `lib/kill-switch.mjs` | Writes and removes this run's `.kill`, and refuses to start over an existing sentinel. |
| `lib/net-guard.mjs` | The loopback-only connection guard. |
| `lib/rails.mjs` | Base USDC and Solana USDC: networks, USDC mints, demo seller, buyer and fee payer addresses. |
| `fixtures/intel-receipt-v7.json` | The signed V7 receipt. |
| `test/showcase.test.mjs` | `node --test` coverage of the full run, the trace, the refusals, environment isolation and the CLI flags, with or without the x402-solana seat. |
| `test/guarded-fetch.test.mjs` | `node --test` coverage of the `@x402/fetch` wrapper and its helpers, with no socket. |
| `test/guarded-solana-fetch.test.mjs` | `node --test` coverage of the Solana wrapper on the real x402-solana client: the transfer it builds, refusals before any chain read, the network pin, a malformed amount, halts on entry and in the wallet, the budget under concurrent calls, refused options, the demo keys, and loopback only. Skipped, with the reason, until `npm run setup:x402-solana` has run. |
