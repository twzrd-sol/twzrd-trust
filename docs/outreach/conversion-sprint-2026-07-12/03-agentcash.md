# Channel 3: AgentCash

**Status:** draft ready (send after 2s.io is in flight)  
**Done signal:** guard composition run in their environment OR co-feature  
**Do not lead with paid TWZRD trust fetch** — `fee_payer_slot_already_signed` on sponsored self-settle is still red.

## Public proof URL

https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md

## Message

```
Hey AgentCash team — quick mutual-win on composition, not a new paid path.

We shipped a buyer-side x402 guard that runs TWZRD preflight on the exact selected payment requirement before the wallet signs. Strict mode blocks when can_spend=false and leaves signInvocations at 0 — no USDC required to prove it.

npm i twzrd-x402-gate@0.5.3

Pattern (guard raw fetch, then hand to AgentCash pay client):

  installTwzrdAutoGate((guarded) => wrapFetchWithPayment(guarded, agentCashClient), {
    gateOnCanSpend: true,
    failOpen: false,
  });

Five-minute zero-spend proof + expected transcript:
https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/proofs/seller-graph-payguard-closeout-2026-07-12.md

Would you run that harness in your environment and send back decision, reason, and signer invocation count? If it works, happy to co-feature "preflight before AgentCash signs" as the safe default for agent spenders.

(Keeping the older sponsored /trust paid-path compatibility issue separate — this ask is guard-only, no settlement.)
```

## Historical note

First autonomous mainnet payment via AgentCash remains valid historical proof (`3aXGtvmN...`), but current public `npx agentcash fetch .../trust` repro is caveated until fee-payer slot semantics align.