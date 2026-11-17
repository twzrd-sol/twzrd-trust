# End-to-end harness

One paid tool call, driven through every control between an agent and a
seller, on loopback. It uses the built packages in this repository and no
network.

| Stage | Control | What the harness uses |
| --- | --- | --- |
| 1 | Agent | reads the seller's quote from its 402 |
| 2 | Tool guard | `createToolGuard` (`@twzrd1111/agent-killswitch`) |
| 3 | Trust gate | `twzrdApprovePayment` (`twzrd-x402-gate`) |
| 4 | Budget authorization | `createTwzrdPolicyFetch` with a daily ceiling on a file spend ledger |
| 5 | Payment | a test signer and a stub 402 seller on 127.0.0.1 |
| 6 | Receipt verification | `verifyReceiptBinding` and `twzrd-receipt-verifier`, pinned key |
| 7 | Ledger reconciliation | both ledgers verify and agree with what the seller received |

The tool guard and the gate keep separate ledgers in one state directory
(`spend-ledger.jsonl` and `payment-spend-ledger.jsonl`) and share `.kill`
and `.pause`. Stage 7 is what ties the two ledgers together.

## Run

```bash
npm ci && npm run build
npm ci --prefix agent-killswitch && npm run build --prefix agent-killswitch
npm run test:e2e
```

`npm run ci` runs it after the killswitch suite, which builds the second
package.

## Failure matrix

| Case | What happens | What the test proves |
| --- | --- | --- |
| 1a, 1b | `.kill` appears mid-run, before and after the trust gate approves | the signer is never called, the hold is released, nothing is recorded |
| 2 | the seller reports a bill above its quote | the guard records the full bill and pauses; the gate halts without asking intel; reconciliation reports the difference |
| 3 | the gate refuses, so the call is never sent | `ToolNotSentError` releases the hold and the whole budget is there for the next call |
| 4 | the tool ledger cannot be written after the seller was paid | everything pauses, the spend still counts in the guard, reconciliation reports the missing line |
| 5 | eight calls race for a budget of three | exactly three are signed and paid |
| 6a, 6b | a pause written by the gate, and one written by the guard | each stops the other |

## Limits

- The seller, the intel service and settlement are one stub server. The
  payment is a signature the stub checks, not a chain transfer.
- Stage 6 verifies a recorded TWZRD receipt (the fixture in
  `twzrd-x402-gate/test/fixtures/`) that the stub returns with its answer.
- A spend ceiling needs a ledger to count against. The harness refuses to
  build a pipeline with a ceiling and no ledger.

## Against a real seller

`npm run e2e:devnet` runs `live.test.mjs`, which is skipped everywhere else.
It needs `TWZRD_E2E_URL` and `TWZRD_E2E_PAY_MODULE` (a module that exports
`wrapPay(guardedFetch)` around your own signer) and spends real test funds up
to `TWZRD_E2E_MAX_USD` (default 0.01). See the header of that file.
