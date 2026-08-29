# The 7-day milestone

> One external agent with a funded wallet routes **every** x402 payment
> through TWZRD for seven consecutive days.

This is TWZRD's first commercial proof point. Everything in this repo — the
gate, bind-v1, the receipts, the ledger — is the machinery behind it. This
document makes the milestone measurable enough that a third party can check
whether it happened, because an adoption claim we grade ourselves is worth as
little as an unsigned ledger day.

## Definition

An integration qualifies when all of the following hold:

1. **External wallet.** The paying wallet belongs to the external operator,
   funds theirs, keys theirs. It is none of TWZRD's operational wallets, and
   payments to TWZRD-operated services alone do not qualify the week — house
   traffic is dogfood, not adoption.
2. **Every payment gated.** For the seven days, every x402 payment the agent
   makes goes through `twzrd.safeFetch` (or `installTwzrdX402ClientHook`),
   with policy active — not a passthrough configuration.
3. **Seven consecutive UTC days** with at least one gated payment per day.
4. **Receipts exist.** Settled payments carry bind-v1 stamps where the seller
   permits (`extra.memo` unset), producing receipts verifiable from chain
   data via `/v1/intel/resource_bind/verify` or independent recomputation.

## How it is proven — without their keys or their data

The operator's evidence is theirs to publish, and none of it requires trusting
TWZRD or exposing secrets:

- **The spend ledger** (`ledgerFile`): a hash-chained JSONL of every gated
  spend, on their disk. Publishing it (or a digest per day) shows continuity
  and volume without exposing keys.
- **The transaction signatures**: each settled payment is public chain data.
  Anyone can decode the `rb1:` memos and verify the receipts.
- **Verdict coverage**: blocks are part of the story — `signerInvocations: 0`
  refusals demonstrate the gate was live, not decorative.

TWZRD's side of the proof is symmetric and already public: the verifier
endpoint is free, the leaf spec is reproducible ([REVIEW.md](./REVIEW.md)),
and adoption over time is visible in aggregate on the ledger surfaces.

## What the external operator gets

- A spend-control layer their agent cannot be prompt-injected out of —
  caps and network allow-lists live outside the model.
- Merchant scoring before money moves (wash-flagged sellers block for free).
- A verifiable receipt trail: *what* was paid for, not just that money moved.
- Direct engineering support during the week — a broken integration is a
  TWZRD bug first.

## Status

Not yet attempted. Start here: [QUICKSTART.md](./QUICKSTART.md). If you run
a funded agent and want to be the first week, open an issue on this repo.
