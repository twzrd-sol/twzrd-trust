# Spend-guard recipes for twzrd-x402-gate 0.28.1

Three copy-paste recipes that put a per-call spend cap in front of an agent's signer: one for
`@x402/fetch`, one for `mppx`, one for an MCP client through the `@twzrd1111/mandate` sidecar.
Each was run against a loopback-only stub (127.0.0.1) with a throwaway in-memory key and a
tripwire that refuses every non-loopback fetch. No wallet, no RPC, no paid endpoint. The harness
is in [`verify/`](./verify); re-run it with the commands in [Verification](#verification-loopback-only).

| Recipe | Packages (exact, as installed and run) |
|---|---|
| 1. @x402/fetch | twzrd-x402-gate@0.28.1, @x402/fetch@2.32.0, @x402/core@2.32.0, @x402/evm@2.32.0, viem@2.58.4 |
| 2. mppx | twzrd-x402-gate@0.28.1, mppx@0.21.4, viem@2.58.4 |
| 3. MCP proxy | @twzrd1111/mandate@0.1.1 with an npm override to twzrd-x402-gate@0.28.1 (see the note), @x402/fetch@2.32.0, @x402/core@2.32.0, @x402/evm@2.32.0, viem@2.58.4 |

---

## 1. @x402/fetch: replace `wrapFetchWithPayment` with `createBuyerFetch`

You already have an `x402Client` with your scheme and signer registered:

```js
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
```

The recipe (three lines):

```js
import { createBuyerFetch } from "twzrd-x402-gate";
const pay = createBuyerFetch({ client, maxPricePerCall: "0.01", allowedRecipients: [SELLER_PAYTO] }); // was: wrapFetchWithPayment(fetch, client)
const res = await pay(url); // a quote over 0.01 USDC throws BuyerFetchBlockedError, reason "price_cap_exceeded", before the signer runs
```

```bash
npm install twzrd-x402-gate@0.28.1 @x402/fetch@2.32.0 @x402/core@2.32.0 @x402/evm@2.32.0 viem@2.58.4
```

What to know:
- `maxPricePerCall` (exact USDC decimal) and `allowedRecipients` are required. An empty list refuses every payment.
- The cap and the recipient list are checked locally at `onBeforePaymentCreation`, before the free TWZRD preflight.
  A quote that passes them then gets the free preflight and merchant card from `https://intel.twzrd.xyz`
  (no key, no charge). It fails closed: if the preflight cannot be reached, nothing is signed. A `decision: block`
  card refuses (`intel_decision_block`), and so does an amount above the card's recommended cap
  (`intel_recommended_cap_exceeded`). A `warn` proceeds unless you pass `allowWarn: false`.
- Strict networks: USDC on Base mainnet (`eip155:8453`) and Solana mainnet only. Testnets are refused.
- **Spend ledger (changed in 0.28.0, patched in 0.28.1).** Every approved payment is written as a hold in
  `.twzrd/spend-v2.jsonl` (`spendLedgerFile`) before the signer runs. A hold that never signed is released.
  A signed hold stays counted until a settlement header with `success: true` and a transaction commits it, or
  until its window passes. A seller's `success: false`, an error status or another 402 does not release it, so a
  seller that keeps asking again cannot sign past `hourlyBudgetCap`. Processes that point at the same file share
  the budget (writes take `<file>.lock`). The 0.27.0 file was `.twzrd/spend.jsonl`; its spend is not counted
  unless `spendLedgerFile` points at it. Every process that writes a shared ledger must be on 0.28.1: a 0.28.0
  writer still releases signed holds.
- The spend ledger caps spend; it does not recognise a repeated request as the same purchase. Two calls for the
  same thing are two payments, each under `maxPricePerCall` and inside `hourlyBudgetCap`. Set `hourlyBudgetCap`
  if retries matter to you: without it there is no cumulative cap.
- It also writes `.twzrd/decisions.jsonl` (`decisionFile`; one process per file). Optional: `expectedAmount`, `budgetScope`.
- `@x402/core` 2.23 and later applies its own default per-payment limit ($1) before any hook. A quote above that is refused by the core client, not by the gate.

## 2. mppx: guard `onChallenge` with `installTwzrdAutoGate("mpp")`

```js
import { Mppx, tempo } from "mppx/client";
import { installTwzrdAutoGate, createLocalDecisionSigner } from "twzrd-x402-gate";
const mppx = Mppx.create({ methods: [tempo({ account })], polyfill: false,
  onChallenge: installTwzrdAutoGate("mpp", { signer: createLocalDecisionSigner(), policy: { maxAmountUsd: "0.01" } }) });
```

Then call `mppx.fetch(url)`. A charge above 0.01 USD throws `TwzrdMppBlockError` (`code: "PAYMENT_CONTROL_BLOCK"`,
`reasonCodes: ["POLICY_MAX_AMOUNT", "twzrd_budget_exceeded"]`). mppx rethrows it, so `createCredential()` never runs and nothing signs.

```bash
npm install twzrd-x402-gate@0.28.1 mppx@0.21.4 viem@2.58.4
```

What to know:
- Do not also register an `onChallengeReceived` handler that returns a credential. mppx uses that credential first and the guard never runs.
- Only Solana `charge` and Tempo `charge` are evaluated. Any other method or intent fails closed (`UNEVALUATED_METHOD`).
  Sponsored charges, splits, non-USD assets and unknown clusters are refused.
- Local caps run first. When they block, no network call is made (remote intelligence is skipped once a local rule blocks).
- The default seat also asks TWZRD for seller intelligence and fails closed if it cannot be reached
  (`intelligence: false` turns that off and leaves the local policy only). Tempo (`eip155:4217`) is not a scored network. On Tempo the gate
  checks the merchant card (wash) and the local caps, and logs `unsupported_network_seen`.
- `maxAmountUsd` is a per-charge cap. This recipe keeps no cumulative budget across charges; the durable,
  settlement-aware MPP budget is `createMppSpendAccounting` (0.28.x), which this recipe does not wire in.
- `warn` proceeds to pay by default. Set `treatWarnAsBlock: true` to refuse on warn as well.
- `polyfill: false` keeps mppx from replacing `globalThis.fetch`.

## 3. MCP proxy: the `@twzrd1111/mandate` sidecar

```bash
npx @twzrd1111/mandate@0.1.1 init --daily 1.00 --per-call 0.01 --chains base --tools mcp:<your_tool>
npx @twzrd1111/mandate@0.1.1 serve --agent-key ./agent.json --trust-issuer <issuer printed by init> --pay-module ./pay.mjs --mcp-upstream <your MCP server URL>
claude mcp add --transport http twzrd-mandate http://127.0.0.1:4029/mcp
```

`pay.mjs` is your payer. The sidecar holds no key:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { client } from "./my-x402-client.mjs"; // your x402Client with your signer registered
export const wrapPay = (guarded) => wrapFetchWithPayment(guarded, client);
```

A tool call whose x402 quote is over the per-call cap comes back as an MCP tool result with `isError: true` and
`structuredContent.twzrd_mandate = { outcome: "refused", layer: 4, code: "per_request_cap", signatures: 0, paid: false, ... }`.
The payer is never invoked.

What to know:
- `init` writes `mandate.json`, `operator.json` and `agent.json` (keys, mode 0600). `serve` listens on `127.0.0.1:4029` only.
- `--tools` takes exact names with no wildcard (`mcp:<tool>`, `http:<host>`, `inference`). Default `--min-trust` is 75. Default chain is solana.
- Layers before signing: mandate integrity, halt switches, tool allow-list, spend caps (4), trust screen (5: needs the TWZRD trust service, fails closed), challenge integrity (6).
  Stop with `POST /mandate/kill` or `touch <state-dir>/.kill`.
- For a stdio-only client: `npx @twzrd1111/mandate@0.1.1 mcp-stdio --sidecar http://127.0.0.1:4029`.
- **Dependency note.** `@twzrd1111/mandate@0.1.1` pins `twzrd-x402-gate@0.26.0`, which npm marks deprecated
  (GHSA-6cqg-vwmj-qw2v: fallback routing paid an unallowlisted route by default). The mandate runtime's payment
  transport refuses any request that is not the call's own target ("a mandate allows no fallback route"); that was
  read in the code, not exercised here. If you install the sidecar into a project, add an npm override so it runs on
  the current gate:

  ```json
  "overrides": { "twzrd-x402-gate": "0.28.1" }
  ```

  The harness runs with that override (`verify/r3-mandate-mcp/package.json`). The same run without it (gate 0.26.0)
  also passed. A mandate release that depends on 0.28.1 directly would remove the need for the override.

---

## Verification (loopback only)

Shared pieces: `verify/stub.mjs` (an x402 v2 seller for Base USDC plus a TWZRD-shaped trust service, both on
127.0.0.1) and `verify/tripwire.mjs` (preloaded with `--import`: it refuses and logs any non-loopback fetch). Keys are
generated in memory with viem `generatePrivateKey()` and never written. Each recipe directory has its own
`package.json` and lockfile; install with `npm ci --ignore-scripts` inside it. Root `npm run ci` does not run these.

| Recipe | Command (from `verify/<dir>`) | Result (2026-11-26, Node 24) |
|---|---|---|
| 1 | `node --import ../tripwire.mjs verify.mjs` | exit 0, `RESULT recipe1 over-cap refused before signer: PASS` |
| 2 | `node --import ../tripwire.mjs verify.mjs` | exit 0, `RESULT recipe2 over-cap refused before credential/signer: PASS` |
| 3 | `RUN_ROOT=<a temp dir> node verify.mjs` (preloads the tripwire into the sidecar process) | exit 0, `RESULT recipe3 over-cap refused at layer 4 before signer: PASS` |

Recipe 1 (`r1-x402-fetch`), 0.01 cap:
- A, quote 0.05: `BuyerFetchBlockedError`, `price_cap_exceeded`. Signer calls 0. Stub saw only the unpaid challenge. 0 trust calls.
- B, quote 0.005, trust stub returns 503: `twzrd_fail_closed`. Signer calls 0.
- C, quote 0.005, trust stub allows: 200, signer calls 1, one payment-bearing request to the stub. Ledger rows:
  `hold` (5000 micro, unsigned), then `hold_signed`. The stub's 200 carries no settlement header, so the signed hold
  is neither committed nor released and keeps counting for its window.
- D (control: the same signer through plain `wrapFetchWithPayment`, no guard), quote 0.05: 200, signer calls 1.
- Tripwire hits: 0.

Recipe 2 (`r2-mppx`), 0.01 cap, Tempo charge (chain 4217, USDC.e):
- A, quote 0.05: `PAYMENT_CONTROL_BLOCK` `[POLICY_MAX_AMOUNT, twzrd_budget_exceeded]`. Credential calls 0, account signatures 0, 0 trust calls.
- B, quote 0.005, trust stub returns 503: `PAYMENT_CONTROL_BLOCK` `[INTEL_BLOCK]`. Credential calls 0.
- C, quote 0.005, trust stub allows: the guard asked for 1 credential. The harness returns a dummy credential so that no Tempo
  transaction is built (mppx's own credential path would call a Tempo RPC, which the tripwire refuses). Stub status 200.
- Tripwire hits: 0.

Recipe 3 (`r3-mandate-mcp`), operator-signed mandate (0.01 per call, Base, `mcp:premium_quote`, min trust 75), loopback paid MCP server:
- A, quote 0.05: tool result `isError: true`, layer 4 `per_request_cap`, signatures 0 (payer sign log 0). The upstream saw one unpaid `tools/call`. 0 trust calls.
- B (positive control), quote 0.005: paid result `{"quote":42}`, signatures 1. Status counters: refusals 1, settled 1.
- `mandate ledger --verify`: ok. Tripwire hits: 0.
