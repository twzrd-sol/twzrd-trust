# Consumer adjacency — Muse / Instinct / OpenClaw-class

Skill pack for agents that might see **both** Stripe Link-style card rails and
Solana x402 `accepts[]` on the open web. TWZRD sits **beside** Stripe Link /
`mpp-agent` / `stripe-link-cli`, never instead of them.

Pins (origin/main shipped): `twzrd-x402-gate@0.9.7`,
`twzrd-receipt-verifier@^1.4.0`. This pack does **not** include PR #96.

## One rule

| 402 signal | Action |
|---|---|
| `accepts[].network` contains **solana** (and real base58 `payTo`) | Run TWZRD preflight path **before any sign** (gate AutoGate / `twzrd.safeFetch` / Hermes `twzrd_check`) |
| `method` stripe / link, or Tempo / MPP-only | **Do not** run Solana wash. Hand off to `stripe-link-cli` or `mpp-agent` |
| Empty / template `payTo` (`{pubkey}`, `:pubkey`, `PAY_TO_WALLET`, …) | **Refuse** — never sign |
| Free preflight `decision=block` or merchant_card `next_action` refuse | **Hard stop** (`signerInvocations` must stay 0) |
| `wash_flagged` + preflight `warn` | **Cap + $0.001 clearance** (`quickCheck` / `payment_decision.v1`). Optional Path A $0.05 is not the primary SKU. |

Code: `twzrd-x402-gate/src/consumer-adjacency.ts`  
Tests: `twzrd-x402-gate/test/consumer-adjacency.test.ts`  
Demo (0 USDC): `npx tsx examples/consumer-adjacency-demo.ts` from `twzrd-x402-gate/`

## Three evidence objects (never collapse)

| Kind | What it is | Not |
|---|---|---|
| `witness_shopping_receipt` | Witness service: page/offer evidence at time T | Not a payment decision; not intel score |
| `payment_decision_v1` | `twzrd.payment_decision.v1` portable allow\|block\|warn\|unavailable | Not a V6/V7 score receipt |
| `intel_receipt_v6_v7` | Paid Path A counterparty intelligence (offline verify) | Not witness shopping proof |

Do not say “the receipt” in agent copy when more than one of these is in play.

## Install (≤5 commands) — external agent

```bash
npm i twzrd-x402-gate@0.9.7 x402-solana@3.0.0
# optional offline verifier floor for Path A receipts:
npm i twzrd-receipt-verifier@^1.4.0
# refuse-before-sign proof (no wallet, 0 USDC):
curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate | jq '{verdict:(.steps[]|select(.name=="block_path").verdict),signerInvocations:(.steps[]|select(.name=="block_path").signer_invocations),mode}'
# wire gate on Solana pay path only:
# import { installTwzrdAutoGate } from "twzrd-x402-gate"
# installTwzrdAutoGate({ ... })  // see README quickstart
```

Hermes skill (Solana sellers only): refresh
`https://intel.twzrd.xyz/skill.md` or local `SKILL.md` in this repo.

## Product boundaries

- **Not** a wallet, Link issuer, Catena ACK, outbid board, or witness host.
- **Not** PR #96 / `completionOfPaidIntel` / agent-commerce-kit.
- Outbid and witness stay separate products; do not brand-merge.

## Verification

```bash
cd twzrd-x402-gate
npx tsx --test test/consumer-adjacency.test.ts
npx tsx examples/consumer-adjacency-demo.ts
```

Expect: 15 unit tests pass; demo prints `signerInvocations: 0` and `mode: no_spend`.
